import { localize } from "./i18n";
// Repo List profiles: named groups of repositories, kept in the workspace setting
// linyra.profiles. Pure: no vscode import. A profile only chooses which repositories
// git log runs in; it filters nothing itself.

/** Profile name → repositories, each as its path relative to its workspace folder. */
export type Profiles = Record<string, string[]>;
/** A profile against the repositories found: their ids (Repo List order), and entries found nowhere. */
export interface ResolvedProfile { name: string; ids: string[]; missing: string[] }
export interface Folder { name: string; path: string }

/** The setting as written by hand or by Linyra: anything malformed is skipped, never an error. */
export function readProfiles(raw: unknown): Profiles {
  const out: Profiles = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const name = key.trim();
    if (!name || !Array.isArray(value)) continue;
    const entries = value.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter((x) => x !== "");
    out[name] = [...new Set(entries)];
  }
  return out;
}

export function profileNames(p: Profiles): string[] {
  return Object.keys(p).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

const slashes = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");

/**
 * How a profile names a repository: its path relative to the workspace folder holding it
 * (the innermost), "/" separators, "." for the folder itself; in a multi-root workspace the
 * folder's name comes first. Outside every folder: the absolute path, "/" separators.
 */
export function repoKey(root: string, folders: readonly Folder[], caseInsensitive = false): string {
  const r = slashes(root);
  const same = (a: string, b: string) => (caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b);
  let best: { folder: Folder; base: string; rel: string } | undefined;
  for (const folder of folders) {
    const base = slashes(folder.path);
    const rel = same(r, base) ? "" : r.length > base.length && same(r.slice(0, base.length + 1), `${base}/`) ? r.slice(base.length + 1) : null;
    if (rel !== null && (!best || base.length > best.base.length)) best = { folder, base, rel };
  }
  if (!best) return r;
  if (folders.length > 1) return best.rel ? `${best.folder.name}/${best.rel}` : best.folder.name;
  return best.rel || ".";
}

/** Each profile (sorted by name) against the repositories found, in their order. */
export function resolveProfiles(p: Profiles, repos: readonly { id: string; key: string }[]): ResolvedProfile[] {
  const known = new Set(repos.map((r) => r.key));
  return profileNames(p).map((name) => {
    const wanted = new Set(p[name]);
    return { name, ids: repos.filter((r) => wanted.has(r.key)).map((r) => r.id), missing: p[name].filter((k) => !known.has(k)) };
  });
}

/** The profiles the ticks are exactly (repoIds null = every repository). Derived, never stored. */
export function activeProfiles(resolved: readonly ResolvedProfile[], repoIds: readonly string[] | null, allIds: readonly string[]): string[] {
  const shown = new Set(repoIds ?? allIds);
  return resolved.filter((p) => p.ids.length > 0 && p.ids.length === shown.size && p.ids.every((id) => shown.has(id))).map((p) => p.name);
}

/** The ＋ Save as profile… row: some repositories ticked, and they are neither All nor a profile. */
export function showSaveRow(resolved: readonly ResolvedProfile[], repoIds: readonly string[] | null, allIds: readonly string[]): boolean {
  return repoIds !== null && repoIds.length > 0 && activeProfiles(resolved, repoIds, allIds).length === 0;
}

/** The repo filter a profile sets: its repositories in Repo List order, or null when that is all of them. */
export function profileFilter(p: ResolvedProfile, allIds: readonly string[]): string[] | null {
  const ids = allIds.filter((id) => p.ids.includes(id));
  return ids.length === allIds.length && ids.length > 0 ? null : ids;
}

/** Why a name cannot be used (undefined: it can). Names differing only in case are the same name. */
export function nameProblem(p: Profiles, name: string, current?: string): string | undefined {
  const n = name.trim();
  if (!n) return localize("Enter a name.");
  const clash = Object.keys(p).find((k) => k.toLowerCase() === n.toLowerCase() && k !== current);
  return clash === undefined ? undefined : localize("A profile named \"{0}\" already exists.", clash);
}

export function saveProfile(p: Profiles, name: string, keys: readonly string[]): Profiles {
  return { ...p, [name.trim()]: [...new Set(keys)] };
}

/** Renamed in place: the setting keeps its order. */
export function renameProfile(p: Profiles, from: string, to: string): Profiles {
  if (!(from in p)) return p;
  const out: Profiles = {};
  for (const [k, v] of Object.entries(p)) out[k === from ? to.trim() : k] = v;
  return out;
}

export function deleteProfile(p: Profiles, name: string): Profiles {
  const out = { ...p };
  delete out[name];
  return out;
}

/** One repository's memberships: in every profile of `names`, in no other. */
export function setMembership(p: Profiles, key: string, names: readonly string[]): Profiles {
  const out: Profiles = {};
  for (const [n, keys] of Object.entries(p)) {
    const want = names.includes(n);
    out[n] = want ? (keys.includes(key) ? keys : [...keys, key]) : keys.filter((k) => k !== key);
  }
  return out;
}

import { localize } from "../i18n";
import { hashQuery, type FilterState } from "../filterModel";
import { commitKey } from "../types";

const pad = (n: number) => String(n).padStart(2, "0");

export function relativeTime(now: number, t: number): string {
  const s = Math.max(0, now - t);
  if (s < 60) return localize("just now");
  const m = Math.floor(s / 60);
  if (m < 60) return localize("{0}m ago", m);
  const h = Math.floor(m / 60);
  if (h < 24) return localize("{0}h ago", h);
  const d = Math.floor(h / 24);
  if (d < 30) return localize("{0}d ago", d);
  if (d < 365) return localize("{0}mo ago", Math.floor(d / 30));
  return localize("{0}y ago", Math.floor(d / 365));
}

export function absoluteTime(t: number): string {
  const d = new Date(t * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function visibleRange(scrollTop: number, viewport: number, rowHeight: number, total: number, overscan = 8): { start: number; end: number } {
  if (total === 0 || rowHeight <= 0) return { start: 0, end: 0 };
  const first = Math.floor(scrollTop / rowHeight);
  const count = Math.ceil(viewport / rowHeight);
  return { start: Math.max(0, first - overscan), end: Math.min(total, first + count + overscan) };
}

export function moveSelection(key: string, index: number, total: number, pageRows: number): number | null {
  if (total === 0) return null;
  const last = total - 1;
  switch (key) {
    case "ArrowDown": return Math.min(last, index + 1);
    case "ArrowUp": return Math.max(0, index - 1);
    case "Home": return 0;
    case "End": return last;
    case "PageDown": return Math.min(last, Math.max(0, index) + pageRows);
    case "PageUp": return Math.max(0, index - pageRows);
    default: return null;
  }
}

/** Each accent as a theme color id, for native views (tree icons): the same hues as styles.css .accent-0 … .accent-5. */
export const ACCENT_COLORS = ["charts.red", "charts.blue", "charts.yellow", "charts.green", "charts.purple", "terminal.ansiCyan"];

/** Six hues: five of VS Code's chart colors plus terminal cyan; see styles.css .accent-0 … .accent-5. */
export const ACCENT_COUNT = 6;

/** FNV-1a: a stable, well-spread hash of the repository name. */
function hashName(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Each repository's hue (maintainer decision, spec §18). It never depends on the filter,
 * so ticking repositories never recolors the others. Each repo starts from a hue derived
 * from its name; when that hue is taken, it moves on to the next one that is least used,
 * in name order. Up to six repositories therefore get six different hues, discovery order
 * does not matter, and past six hues are shared evenly. Adding a repository can move repos
 * that sort after it (the assignment is greedy); filtering never moves anything. The color
 * is only a marker: the name is always printed beside it.
 */
export function assignAccents(repos: readonly { id: string; name: string }[]): Map<string, number> {
  const sorted = [...repos].sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const used = new Array<number>(ACCENT_COUNT).fill(0);
  const out = new Map<string, number>();
  for (const r of sorted) {
    const least = Math.min(...used);
    const start = hashName(r.name) % ACCENT_COUNT;
    let hue = start;
    for (let k = 0; k < ACCENT_COUNT; k++) {
      const h = (start + k) % ACCENT_COUNT;
      if (used[h] === least) {
        hue = h;
        break;
      }
    }
    used[hue]++;
    out.set(r.id, hue);
  }
  return out;
}

/** A repository's hue from assignAccents; 0 for one outside the list. */
export function accentOf(accents: ReadonlyMap<string, number>, repoId: string): number {
  return accents.get(repoId) ?? 0;
}

/** The Log's repo column, in characters: fits the longest repo name, within 10–28. */
export function repoColumnChars(names: readonly string[]): number {
  const longest = names.reduce((n, name) => Math.max(n, name.length), 0);
  return Math.min(28, Math.max(10, longest));
}

/**
 * A repo name cut to `max` characters in the middle: repos that share a prefix
 * (acme-mobile-…) usually differ at the end, so both ends stay visible.
 */
export function middleTruncate(name: string, max: number): string {
  // By character, not UTF-16 unit: an emoji is never split in half.
  const chars = Array.from(name);
  if (chars.length <= max) return name;
  if (max <= 1) return "…";
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return `${chars.slice(0, head).join("")}…${chars.slice(chars.length - (keep - head)).join("")}`;
}

/**
 * The longest middle cut of `name` that `fits` accepts (the caller measures real text
 * width). Binary search: fits is monotonic in length.
 */
export function fitMiddle(name: string, fits: (text: string) => boolean): string {
  if (fits(name)) return name;
  let lo = 1;
  let hi = Array.from(name).length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(middleTruncate(name, mid))) lo = mid;
    else hi = mid - 1;
  }
  return middleTruncate(name, lo);
}

/**
 * How many author chips fit in `room` px, in order. When not all fit, a "+N" chip of
 * `plusWidth` must fit too. Chips never shrink: a sliver of a name tells nobody anything.
 */
export function chipsThatFit(widths: readonly number[], room: number, plusWidth: number, gap: number): number {
  let used = 0;
  for (let k = 0; k < widths.length; k++) {
    const next = used + (k > 0 ? gap : 0) + widths[k];
    const rest = k + 1 < widths.length ? gap + plusWidth : 0;
    if (next + rest > room) return k;
    used = next;
  }
  return widths.length;
}

const repoNoun = (n: number) => localize(n === 1 ? "repository" : "repositories");

export function repoButtonLabel(repoIds: readonly string[] | null, repos: readonly { id: string; name: string }[]): string {
  if (repoIds === null) return localize("All repositories");
  if (repoIds.length === 0) return localize("No repositories");
  if (repoIds.length === 1) return repos.find((r) => r.id === repoIds[0])?.name ?? localize("1 repository");
  return localize("{0} of {1} repositories", repoIds.length, repos.length);
}

export function dateLabel(f: FilterState): string {
  switch (f.date) {
    case "24h": return localize(" in the last 24 hours");
    case "7d": return localize(" in the last 7 days");
    case "30d": return localize(" in the last 30 days");
    case "all": return "";
    case "custom":
      if (f.from && f.to) return localize(" between {0} and {1}", f.from, f.to);
      if (f.from) return localize(" since {0}", f.from);
      if (f.to) return localize(" until {0}", f.to);
      return "";
  }
}

export type EmptyAction = "clearText" | "clearAuthor" | "allTime" | "selectAll" | "settings" | "clearPath";

export interface EmptyState {
  title: string;
  body: string;
  action?: { label: string; id: EmptyAction };
}

export function emptyState(o: { repoCount: number; filter: FilterState; history?: string }): EmptyState {
  const f = o.filter;
  if (o.history !== undefined) {
    const p = o.history;
    const text = f.text.trim();
    if (text) return { title: localize("No matching commits"), body: localize("No commit to {0} contains “{1}”.", p, text), action: { label: localize("Clear Search"), id: "clearText" } };
    if (f.date !== "all") return { title: localize("No commits in this date range"), body: localize("No commits to {0}{1}.", p, dateLabel(f)), action: { label: localize("Show All Time"), id: "allTime" } };
    return { title: localize("No matching commits"), body: localize("No commits to {0} match these filters.", p), action: { label: localize("Clear Author"), id: "clearAuthor" } };
  }
  if (o.repoCount === 0) {
    return {
      title: localize("No git repositories found"),
      body: localize("Polylog lists the repositories that VS Code's Git extension reports. If yours sit deeper in the folder tree, raise git.repositoryScanMaxDepth or polylog.scanDepth."),
      action: { label: localize("Open Settings"), id: "settings" },
    };
  }
  if (f.repoIds !== null && f.repoIds.length === 0) {
    return { title: localize("No repositories selected"), body: localize("Choose at least one repository to see its commits."), action: { label: localize("Select All"), id: "selectAll" } };
  }
  const hash = hashQuery(f.text);
  if (hash) return { title: localize("No commit with this hash"),
    body: localize("No commit matching {0} was found in the selected repositories. Try a longer hash or select more repositories.", hash),
    action: { label: localize("Clear Search"), id: "clearText" } };
  const k = f.repoIds === null ? o.repoCount : f.repoIds.length;
  const scope = f.repoIds === null ? localize("{0} {1}", k, repoNoun(k)) : localize("{0} selected {1}", k, repoNoun(k));
  const text = f.text.trim();
  const names = [...(f.authors ?? []), f.author].map((n) => n.trim()).filter((n) => n !== "").map((n) => `“${n}”`);
  const who = f.mine ? [...names, localize("you")] : names;
  const author = who.length > 0;
  // "“dana”", "“dana” or “rin”", "“dana”, “rin” or you"
  const by = who.length <= 1 ? who.join("") : localize("{0} or {1}", who.slice(0, -1).join(", "), who[who.length - 1]);
  const touching = f.path ? localize(" touching “{0}”", f.path) : "";
  if (text && author) {
    return { title: localize("No matching commits"), body: localize("No commit by {0}{1} contains “{2}” in {3}{4}.", by, touching, text, scope, dateLabel(f)), action: { label: localize("Clear Search"), id: "clearText" } };
  }
  if (text) {
    const what = f.path ? localize("commit{0}", touching) : localize("commit message");
    return { title: localize("No matching commits"), body: localize("No {0} contains “{1}” in {2}{3}.", what, text, scope, dateLabel(f)), action: { label: localize("Clear Search"), id: "clearText" } };
  }
  if (author) {
    return { title: localize("No matching commits"), body: localize("No commits by {0}{1} in {2}{3}.", by, touching, scope, dateLabel(f)), action: { label: localize("Clear Author"), id: "clearAuthor" } };
  }
  if (f.path) {
    return { title: localize("No matching commits"), body: localize("No commit touches “{0}” in {1}{2}.", f.path, scope, dateLabel(f)), action: { label: localize("Clear Path"), id: "clearPath" } };
  }
  if (f.date !== "all") {
    return { title: localize("No commits in this date range"), body: localize("No commits in {0}{1}.", scope, dateLabel(f)), action: { label: localize("Show All Time"), id: "allTime" } };
  }
  if (f.repoIds !== null) {
    return { title: localize("No commits in the selected repositories"), body: localize("The {0} have no commits.", scope), action: { label: localize("Select All"), id: "selectAll" } };
  }
  return {
    title: localize("No commits yet"),
    body: localize("Polylog shows one merged log across every repository in this workspace. It found {0} {1}, but none has commits yet.", k, repoNoun(k)),
  };
}

export function branchUseLabel(u: { branches: string[]; found: number; missing: number } | undefined): string {
  if (!u) return "";
  const what = u.branches.length === 1 ? u.branches[0] : localize("{0} branches", u.branches.length);
  return u.missing === 0 ? localize("{0} in all {1} repos", what, u.found)
    : localize("{0} in {1} repos · skipped {2} without selected branches", what, u.found, u.missing);
}

export function countLabel(n: number): string {
  return localize("{0} {1}", n, localize(n === 1 ? "commit" : "commits"));
}

export function splitPath(p: string): { dir: string; base: string } {
  const i = p.lastIndexOf("/");
  return i < 0 ? { dir: "", base: p } : { dir: p.slice(0, i), base: p.slice(i + 1) };
}

/**
 * Where the selection goes when a whole page arrives (a filter change, a
 * refresh after repositories open or close, a replay): stay on the same commit
 * if it is still listed, otherwise the first row.
 */
export function reselect(prevKey: string | null, rows: readonly { repoId: string; sha: string }[]): number {
  if (rows.length === 0) return -1;
  if (prevKey === null) return 0;
  const i = rows.findIndex((r) => commitKey(r) === prevKey);
  return i < 0 ? 0 : i;
}


/** The number on the Log's Uncommitted switch: only once known, and never "0". */
export function switchCount(known: boolean, files: number): string {
  return known && files > 0 ? String(files) : "";
}

/** "3 repositories · +24 −5", beside the switch on its Uncommitted side. */
export function totalsLabel(t: { files: number; repos: number; added: number; deleted: number }): string {
  if (t.files === 0) return "";
  return localize("{0} {1} · +{2} −{3}", t.repos, localize(t.repos === 1 ? "repository" : "repositories"), t.added, t.deleted);
}

/** An Uncommitted row's change meter: each kind's share of the files, empty kinds left out. */
export function meterParts(m: { added: number; modified: number; deleted: number }): { kind: "added" | "modified" | "deleted"; share: number }[] {
  const total = m.added + m.modified + m.deleted;
  if (total === 0) return [];
  return (["added", "modified", "deleted"] as const).filter((k) => m[k] > 0).map((kind) => ({ kind, share: m[kind] / total }));
}

/** Escape returns focus to the list the Log shows (never to a hidden one). */
export function escapeTarget(mode: "commits" | "uncommitted"): "list" | "worklist" {
  return mode === "uncommitted" ? "worklist" : "list";
}

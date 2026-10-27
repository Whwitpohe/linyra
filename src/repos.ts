import { isValidRef } from "./filterModel";
import type { AuthorName, BranchName } from "./protocol";
import type { Repo } from "./types";

const segments = (p: string) => p.split(/[\\/]+/).filter(Boolean);
const baseName = (p: string) => segments(p).at(-1) ?? p;

function countBy<T>(items: readonly T[], key: (t: T) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of items) m.set(key(it), (m.get(key(it)) ?? 0) + 1);
  return m;
}

/** Folder-name labels, disambiguated by parent folder, then by full path. */
export function labelRepos(roots: readonly string[]): Repo[] {
  const unique = [...new Set(roots)];
  const bases = countBy(unique, baseName);
  const named = unique.map((root) => {
    const name = baseName(root);
    return { id: root, root, name: bases.get(name)! > 1 ? `${name} (${segments(root).at(-2) ?? root})` : name };
  });
  const names = countBy(named, (r) => r.name);
  return named
    .map((r) => (names.get(r.name)! > 1 ? { ...r, name: r.root } : r))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        re += "(?:.*/)?";
      } else {
        re += ".*";
      }
    } else if (ch === "*") {
      re += "[^/]*";
    } else if (ch === "?") {
      re += "[^/]";
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

export function excludeRepos(repos: readonly Repo[], patterns: readonly string[]): Repo[] {
  const res = patterns.map(globToRegExp);
  return repos.filter((r) => {
    const root = r.root.replace(/\\/g, "/");
    return !res.some((re) => re.test(baseName(r.root)) || re.test(root));
  });
}

const inside = (p: string, folder: string) => p === folder || p.startsWith(folder.endsWith("/") || folder.endsWith("\\") ? folder : folder + "/") || p.startsWith(folder + "\\");

/**
 * The folder walk plus the repositories vscode.git opened inside the workspace
 * folders. A union, so the list never shrinks when vscode.git sees fewer
 * (shallower scan depth, detection limited to open editors).
 */
export function mergeRoots(walk: readonly string[], git: readonly string[], folders: readonly string[]): string[] {
  const roots = [...walk];
  for (const g of git) if (!roots.includes(g) && folders.some((f) => inside(g, f))) roots.push(g);
  return roots;
}

/** Branch names across repositories (one list per repo), most shared first; only names the Branch box accepts. */
export function branchSuggestions(lists: readonly (readonly string[])[], limit = 300): BranchName[] {
  const counts = new Map<string, number>();
  for (const list of lists) {
    for (const name of new Set(list)) {
      if (name.endsWith("/HEAD") || !isValidRef(name)) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return [...counts].map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).slice(0, limit);
}

/**
 * People who committed recently, across repositories: one entry per email (ignoring
 * case), under the name they used most, most commits first. Each input is one repo's
 * `git log --format=%aN%x1f%aE` output.
 */
export function authorSuggestions(outputs: readonly string[], limit = 200): AuthorName[] {
  const byEmail = new Map<string, { email: string; count: number; names: Map<string, number> }>();
  for (const out of outputs) {
    for (const line of out.split("\n")) {
      const [name, email] = line.split("\x1f");
      if (!name?.trim() || !email?.trim()) continue;
      const key = email.trim().toLowerCase();
      const a = byEmail.get(key) ?? { email: key, count: 0, names: new Map<string, number>() };
      a.count++;
      a.names.set(name.trim(), (a.names.get(name.trim()) ?? 0) + 1);
      byEmail.set(key, a);
    }
  }
  const byName = (x: [string, number], y: [string, number]) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1);
  return [...byEmail.values()]
    .map((a) => ({ name: [...a.names].sort(byName)[0][0], email: a.email, count: a.count }))
    .sort((x, y) => y.count - x.count || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))
    .slice(0, limit);
}

/** Exclude from Linyra: the list with the repository's exact path added, or null if already in it. */
export function addExclusion(previous: readonly string[] | undefined, pattern: string): string[] | null {
  const list = previous ?? [];
  return list.includes(pattern) ? null : [...list, pattern];
}

/**
 * Undo an exclusion: the pattern leaves the list as it is now (entries added since stay), and
 * when nothing else is left and the scope had no list before, the setting is unset again
 * rather than an empty list, which would still override the other scopes.
 */
export function undoExclusion(current: readonly string[], pattern: string, previous: readonly string[] | undefined): string[] | undefined {
  const rest = current.filter((p) => p !== pattern);
  return rest.length === 0 && previous === undefined ? undefined : rest;
}

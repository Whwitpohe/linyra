// What Insights reads: a range of time and a scope (repositories, or one path in one). Pure.

export type InsightsRange = "1w" | "4w" | "3m" | "1y" | "all";
export const RANGES: readonly InsightsRange[] = ["1w", "4w", "3m", "1y", "all"];
export const DEFAULT_RANGE: InsightsRange = "3m";

export type InsightsTab = "history" | "files" | "commits" | "health";
export const TABS: readonly InsightsTab[] = ["history", "files", "commits", "health"];

export type ColorBy = "repo" | "author";

/** Visual History reads at most this many commits per repository and range, and says so. */
export const HISTORY_LIMIT = 5000;

/** The ticked repositories, one of them, or one file or folder in one. */
export type InsightsScope =
  | { kind: "ticked" }
  | { kind: "repo"; repoId: string }
  | { kind: "path"; repoId: string; path: string; folder: boolean };

export const isRange = (v: unknown): v is InsightsRange => typeof v === "string" && (RANGES as readonly string[]).includes(v);
export const isTab = (v: unknown): v is InsightsTab => typeof v === "string" && (TABS as readonly string[]).includes(v);
export const isColorBy = (v: unknown): v is ColorBy => v === "repo" || v === "author";

/** The range's first moment (unix seconds), counted back in calendar units from `now`; undefined: all of history. */
export function sinceOf(range: InsightsRange, now: number): number | undefined {
  const d = new Date(now * 1000);
  switch (range) {
    case "1w": return now - 7 * 86_400;
    case "4w": return now - 28 * 86_400;
    case "3m": d.setUTCMonth(d.getUTCMonth() - 3); return Math.floor(d.getTime() / 1000);
    case "1y": d.setUTCFullYear(d.getUTCFullYear() - 1); return Math.floor(d.getTime() / 1000);
    case "all": return undefined;
  }
}

/** A repository-relative path a webview or a command sent: forward slashes, inside the repository. */
export function safePath(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(raw)) return undefined;
  const p = raw.replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  if (p === "" || p.startsWith("/") || p.startsWith(":") || /^[A-Za-z]:/.test(p) || p.split("/").some((s) => s === ".." || s === "")) return undefined;
  return p;
}

/** A scope as it came from a webview: one whose repository is known, else the ticked repositories. */
export function sanitizeScope(raw: unknown, known: (repoId: string) => boolean): InsightsScope {
  const s = raw as { kind?: unknown; repoId?: unknown; path?: unknown; folder?: unknown } | undefined;
  if (s && typeof s.repoId === "string" && known(s.repoId)) {
    if (s.kind === "repo") return { kind: "repo", repoId: s.repoId };
    const path = safePath(s.path);
    if (s.kind === "path" && path) return { kind: "path", repoId: s.repoId, path, folder: s.folder === true };
  }
  return { kind: "ticked" };
}

/** git log's pathspec for a path scope: literal, so a name with * or : is that name. */
export function logPathspec(scope: InsightsScope): string[] {
  return scope.kind === "path" ? ["--", `:(literal)${scope.path}`] : [];
}

/** ls-tree takes plain paths (no pathspec magic); a folder needs no trailing slash. */
export function treePath(scope: InsightsScope): string[] {
  return scope.kind === "path" ? ["--", scope.path] : [];
}

/**
 * The repository a file or folder is in, and its path inside: the innermost repository whose root
 * contains it (a nested repository wins over the one around it). `insensitive`: Windows and macOS.
 */
export function locate<R extends { root: string }>(repos: readonly R[], fsPath: string, insensitive: boolean): { repo: R; path: string } | undefined {
  const norm = (p: string) => {
    const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
    return insensitive ? s.toLowerCase() : s;
  };
  const target = norm(fsPath);
  let best: { repo: R; path: string } | undefined;
  for (const repo of repos) {
    const root = norm(repo.root);
    if (target !== root && !target.startsWith(`${root}/`)) continue;
    if (best && norm(best.repo.root).length >= root.length) continue;
    best = { repo, path: fsPath.replace(/\\/g, "/").replace(/\/+$/, "").slice(root.length + 1) };
  }
  return best;
}

/**
 * The key one answer is read for: a path scope's path and the range (Files ignores the range).
 * The repositories are not in it: a scope of fewer repositories shows what was read of them. Health
 * reads whole repositories, so one answer serves every scope.
 */
export function readKey(tab: InsightsTab, scope: InsightsScope, range: InsightsRange): string {
  if (tab === "health") return tab;
  const where = scope.kind === "path" ? `${scope.repoId}\0${scope.path}` : "";
  return [tab, tab === "history" || tab === "commits" ? range : "", where].join("\x01");
}

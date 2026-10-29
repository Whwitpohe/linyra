import { localize } from "./i18n";
// Compare Branches: every git argument and parser. Pure: no vscode import.
import { parseShow } from "./commitDetail";
import { isValidRef } from "./filterModel";
import type { FileChange } from "./types";

/**
 * The two sides. Each is one branch name, or several in order ("develop develop-k"): a repository
 * uses the first it has, so repositories that name the same branch differently compare together.
 */
export interface Pair {
  left: string;
  right: string;
}
export type Side = "left" | "right";

/** One repository's comparison of the pair. */
export type RepoCompare =
  | { kind: "missing" }
  | { kind: "identical" }
  | { kind: "nobase" }
  | { kind: "error"; reason: string }
  /**
   * leftName/rightName: the candidate this repository has. base: the split point, read when a side
   * needs it (null until then). conflicts: the files a merge of the two would leave conflicted
   * ([] merges cleanly); undefined while the check (after the list) is still to come; null when
   * this git cannot tell (before 2.38).
   */
  | { kind: "differs"; leftName: string; rightName: string; leftSha: string; rightSha: string; base: string | null; left: number; right: number; sameLeft: number; sameRight: number; conflicts?: string[] | null };

export interface SideCommit {
  /** "+": only on this side; "=": the same change is on the other side too. */
  mark: "+" | "=";
  sha: string;
  parents: string[];
  time: number;
  author: string;
  subject: string;
}
export interface Duplicate {
  subject: string;
  left?: string;
  right?: string;
}
export type PickerItem =
  | { kind: "pair"; pair: Pair }
  /** order: its place among the side's ticked names (1 is tried first); 0 when not ticked. */
  | { kind: "name"; name: string; count: number; favorite: boolean; order: number };
export interface PickerGroup {
  title: string;
  items: PickerItem[];
}

/** The Repositories row that shows every repository whose files differ, at once. */
export const ALL_REPOS = "*";
/** Several repositories picked together (Ctrl/Shift-click): "+", then their ids, one per line. */
export const MANY_PREFIX = "+";

/** The selection for these repositories: one alone is itself; several, "+" and their ids. */
export function manyRepos(ids: readonly string[]): string {
  return ids.length === 1 ? ids[0] : `${MANY_PREFIX}${ids.join("\n")}`;
}

/** The repositories a selection names: "all" (All repositories), the ones picked together, or one. */
export function selectionIds(selection: string): string[] | "all" {
  if (selection === ALL_REPOS) return "all";
  return selection.startsWith(MANY_PREFIX) ? selection.slice(MANY_PREFIX.length).split("\n").filter(Boolean) : [selection];
}

/** All repositories, or several picked together: the sides show each one's rows under its name. */
export const isGroupSelection = (selection: string | undefined): selection is string => selection !== undefined && (selection === ALL_REPOS || selection.startsWith(MANY_PREFIX));

/** Commits shown per side before "Show 500 more". */
export const COMMIT_PAGE = 500;

const plural = (n: number, one: string, many = `${one}s`) => localize("{0} {1}", n, localize(n === 1 ? one : many));

/** A side holds at most this many names. */
export const MAX_CANDIDATES = 5;

/** A side's names, in order. Branch names never contain a space, so one separates them. */
export function candidates(side: string): string[] {
  return side.split(" ").filter(Boolean);
}

export function sideOf(names: readonly string[]): string {
  return [...new Set(names)].join(" ");
}

/** How a side reads: "develop, develop-k". */
export function sideLabel(side: string): string {
  return candidates(side).join(", ");
}

/** Names cross the webview boundary: only what git accepts as a branch name reaches git. */
export function validPair(p: unknown): p is Pair {
  const o = p as Partial<Pair> | null;
  const ok = (side: unknown) => {
    if (typeof side !== "string") return false;
    const names = candidates(side);
    return names.length > 0 && names.length <= MAX_CANDIDATES && side === sideOf(names) && names.every(isValidRef);
  };
  return ok(o?.left) && ok(o?.right);
}

/**
 * Every name of both sides, its commit and its tree, in one spawn (git cat-file --batch-check):
 * a repository uses the first name of each side it has, and the same tree means the same files.
 */
export function resolveInput(p: Pair): string {
  return [...candidates(p.left), ...candidates(p.right)].flatMap((name) => [`${name}^{commit}`, `${name}^{tree}`]).join("\n") + "\n";
}

export interface Resolved { name: string; sha: string; tree: string }

export function parseResolve(p: Pair, out: string): { left?: Resolved; right?: Resolved } {
  const lines = out.split("\n");
  const id = (i: number, type: string) => new RegExp(`^([0-9a-f]{40}(?:[0-9a-f]{24})?) ${type} `).exec(lines[i] ?? "")?.[1];
  const first = (names: readonly string[], from: number): Resolved | undefined => {
    for (const [k, name] of names.entries()) {
      const sha = id(from + 2 * k, "commit"), tree = id(from + 2 * k + 1, "tree");
      if (sha && tree) return { name, sha, tree };
    }
    return undefined;
  };
  const left = candidates(p.left);
  return { left: first(left, 0), right: first(candidates(p.right), 2 * left.length) };
}

export function mergeBaseArgs(l: string, r: string): string[] {
  return ["merge-base", l, r];
}

/**
 * The merge of the two, done in memory (git 2.38+): exit 0 merges cleanly, exit 1 lists the
 * conflicted files. Its objects go to a scratch object directory, so the repository is not written.
 */
export function mergeTreeArgs(l: string, r: string): string[] {
  return ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", l, r];
}

/** merge-tree -z --name-only: the merged tree's id, then each conflicted file once. */
export function parseMergeTree(out: string): { tree: string; conflicts: string[] } {
  const [tree = "", ...paths] = out.split("\0").filter(Boolean);
  return { tree, conflicts: [...new Set(paths)] };
}

/** Why merge-tree did not answer: no shared history, a git too old for it, or another failure. */
export function mergeTreeFailure(message: string): "nobase" | "unsupported" | "error" {
  if (/unrelated histories/i.test(message)) return "nobase";
  if (/unknown option|usage: git merge-tree/i.test(message)) return "unsupported";
  return "error";
}

/** A conflict as merge-tree names it: the file, or (renamed) its other name. */
export function isConflict(conflicts: readonly string[] | null | undefined, f: { path: string; oldPath?: string }): boolean {
  return !!conflicts && (conflicts.includes(f.path) || (f.oldPath !== undefined && conflicts.includes(f.oldPath)));
}

/** A Repositories row's merge note: "2 conflicts", "merges cleanly", or nothing when git cannot tell. */
export function conflictNote(c: RepoCompare): string {
  if (c.kind !== "differs" || !c.conflicts) return "";
  return c.conflicts.length === 0 ? localize("merges cleanly") : plural(c.conflicts.length, "conflicted file");
}

/** A side's commits the other lacks, and (counted apart) its commits whose change the other has too. */
export function sideCountArgs(side: Side, l: string, r: string): string[] {
  // Merges carry no change of their own (Files shows what they brought): they are not counted.
  return ["rev-list", side === "left" ? "--left-only" : "--right-only", "--cherry-mark", "--no-merges", "--count", `${l}...${r}`];
}

export function parseSideCount(out: string): { only: number; same: number } {
  const [only, same] = out.trim().split(/\s+/).map(Number);
  return { only: Number.isFinite(only) ? only : 0, same: Number.isFinite(same) ? same : 0 };
}

/** What a side changed since the branches split (merge base → its tip: `other...tip`), statuses and counts in one spawn. */
export function filesArgs(other: string, tip: string): string[] {
  return ["diff", "--raw", "--numstat", "-z", "-M", `${other}...${tip}`];
}

export function parseFiles(out: string): FileChange[] {
  return parseShow(out).files;
}

export function logArgs(side: Side, l: string, r: string, max: number): string[] {
  return ["log", side === "left" ? "--left-only" : "--right-only", "--cherry-mark", "--no-merges", `--max-count=${max}`, "--format=%m%x1f%H%x1f%P%x1f%ct%x1f%aN%x1f%s%x1e", `${l}...${r}`];
}

export function parseSideLog(out: string): SideCommit[] {
  return out.split("\x1e").map((rec) => rec.replace(/^\n+/, "")).filter(Boolean).map((rec) => {
    const [m, sha, parents, time, author, subject] = rec.split("\x1f");
    return { mark: m === "=" ? "=" : "+", sha, parents: parents ? parents.split(" ") : [], time: Number(time), author, subject: subject ?? "" };
  });
}

export function bothPaths(a: readonly FileChange[], b: readonly FileChange[]): Set<string> {
  const other = new Set(b.map((f) => f.path));
  return new Set(a.map((f) => f.path).filter((p) => other.has(p)));
}

/** The paths that differ between the two tips now; no renames, so each side's path is listed. */
export function tipsDiffArgs(l: string, r: string): string[] {
  return ["diff", "--name-only", "-z", "--no-renames", l, r];
}

/** Changed on both sides since the split, yet the same at both tips (a cherry-pick, the same fix twice). */
export function sameNow(both: ReadonlySet<string>, tipsDiff: string): Set<string> {
  const differ = new Set(tipsDiff.split("\0").filter(Boolean));
  return new Set([...both].filter((p) => !differ.has(p)));
}

/** Files mode with Hide Files Already on Both: the files listed, and how many were left out. */
export function shownFiles(files: readonly FileChange[], same: ReadonlySet<string>, hide: boolean): { shown: FileChange[]; hidden: number } {
  const shown = hide ? files.filter((f) => !same.has(f.path)) : [...files];
  return { shown, hidden: files.length - shown.length };
}

/** The file's path at each tip: renamed on this side, the other tip still has it under its old name. */
export function tipPaths(side: Side, f: { path: string; oldPath?: string }): { left: string; right: string } {
  const other = f.oldPath ?? f.path;
  return side === "left" ? { left: f.path, right: other } : { left: other, right: f.path };
}

/** Duplicates for display: a left and a right one with the same subject share a row. Counts come from git. */
export function pairDuplicates(left: readonly SideCommit[], right: readonly SideCommit[]): Duplicate[] {
  const rights = [...right];
  const out: Duplicate[] = [];
  for (const l of left) {
    const i = rights.findIndex((r) => r.subject === l.subject);
    if (i >= 0) {
      out.push({ subject: l.subject, left: l.sha, right: rights[i].sha });
      rights.splice(i, 1);
    } else out.push({ subject: l.subject, left: l.sha });
  }
  for (const r of rights) out.push({ subject: r.subject, right: r.sha });
  return out;
}

export function mirror(c: RepoCompare): RepoCompare {
  if (c.kind !== "differs") return c;
  // A merge's conflicts are the same whichever side goes into which.
  return { kind: "differs", leftName: c.rightName, rightName: c.leftName, leftSha: c.rightSha, rightSha: c.leftSha, base: c.base, left: c.right, right: c.left,
    sameLeft: c.sameRight, sameRight: c.sameLeft, conflicts: c.conflicts };
}

/** The list's summary. No commit numbers: they mislead when the same change travels by cherry-pick. */
export function summaryLabel(results: readonly RepoCompare[], ticked: number): string {
  let differ = 0, identical = 0, missing = 0, conflicted = 0;
  for (const c of results) {
    if (c.kind === "identical") identical++;
    else if (c.kind === "missing") missing++;
    else {
      differ++;
      if (c.kind === "differs" && c.conflicts && c.conflicts.length > 0) conflicted++;
    }
  }
  const parts = [localize("{0} {1}", differ, localize(differ === 1 ? "repository differs" : "repositories differ"))];
  if (conflicted > 0) parts.push(localize("{0} with conflicts", conflicted));
  if (identical > 0) parts.push(localize("{0} identical", identical));
  if (missing > 0) parts.push(localize("{0} missing a branch", missing));
  parts.push(localize("in {0}", plural(ticked, "repository", "repositories")));
  return parts.join(" · ");
}

/** The Compare view's description, next to its title: the pair, without "origin/". */
export function tabTitle(p: Pair | null): string {
  if (!p || !p.left || !p.right) return "";
  const short = (side: string) => candidates(side).map((n) => n.replace(/^refs\/(heads|remotes)\//, "").replace(/^origin\//, "")).join(", ");
  return `${short(p.left)} ↔ ${short(p.right)}`;
}

export function pushRecent(recent: readonly Pair[], p: Pair, cap = 5): Pair[] {
  return [p, ...recent.filter((x) => x.left !== p.left || x.right !== p.right)].slice(0, cap);
}

/**
 * Recent pairs (not while searching), Default branch (each repository's origin/HEAD), Favorites,
 * Local, Remote; a name may be in Favorites and its own group. Each name says whether this side
 * has it ticked, and in which place (`current`: the side's names, in order).
 */
export function pickerGroups(names: readonly { name: string; count: number }[], favorites: readonly string[], recent: readonly Pair[], query: string,
  current: readonly string[] = [], defaults: readonly { name: string; count: number }[] = []): PickerGroup[] {
  const q = query.trim().toLowerCase();
  const match = (n: string) => q === "" || n.toLowerCase().includes(q);
  const fav = new Set(favorites);
  const item = (n: { name: string; count: number }): PickerItem => ({ kind: "name", name: n.name, count: n.count, favorite: fav.has(n.name), order: current.indexOf(n.name) + 1 });
  const sorted = [...names].filter((n) => match(n.name)).sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const remote = (n: string) => isRemoteName(n);
  const groups: PickerGroup[] = [];
  if (q === "" && recent.length > 0) groups.push({ title: localize("Recent pairs"), items: recent.map((pair) => ({ kind: "pair", pair })) });
  // A ticked name no ticked repository has stays listed, so it can be unticked.
  const known = new Set([...names, ...defaults].map((n) => n.name));
  const unknown = current.filter((n) => !known.has(n) && match(n));
  if (unknown.length > 0) groups.push({ title: localize("Not in any ticked repository"), items: unknown.map((name) => item({ name, count: 0 })) });
  const heads = defaults.filter((n) => match(n.name));
  if (heads.length > 0) groups.push({ title: localize("Default branch"), items: heads.map(item) });
  const favs = sorted.filter((n) => fav.has(n.name));
  if (favs.length > 0) groups.push({ title: localize("Favorites"), items: favs.map(item) });
  const local = sorted.filter((n) => !remote(n.name));
  if (local.length > 0) groups.push({ title: localize("Local"), items: local.map(item) });
  const rem = sorted.filter((n) => remote(n.name));
  if (rem.length > 0) groups.push({ title: localize("Remote"), items: rem.map(item) });
  return groups;
}

/** Remote-tracking names come from refs/remotes: "<remote>/<branch>". The store marks them with this prefix list. */
let remotes: ReadonlySet<string> = new Set(["origin", "upstream"]);
function isRemoteName(n: string): boolean {
  return remotes.has(n.split("/")[0]);
}
/** The remotes the store found (`git for-each-ref refs/remotes`), so "feat/billing" stays Local. */
export function setRemoteNames(names: Iterable<string>): void {
  remotes = new Set(names);
}

/** A repository row's description: its = count when it has one, or why it cannot be compared. */
export function repoDescription(c: RepoCompare): string {
  switch (c.kind) {
    case "differs": return c.sameLeft > 0 ? `=${c.sameLeft}` : "";
    case "nobase": return localize("no common history");
    case "error": return localize("git error");
    default: return "";
  }
}

/** A Repositories row's description: each side's commits (merges not counted) and the duplicates. */
export function repoCounts(c: RepoCompare): string {
  if (c.kind !== "differs") return repoDescription(c);
  return [c.left > 0 ? `${c.left} ◀` : "", c.right > 0 ? `${c.right} ▶` : "", c.sameLeft > 0 ? `=${c.sameLeft}` : ""].filter(Boolean).join(" · ");
}

/**
 * Why Merge ◀ into ▶… leaves a repository out: a merge would conflict, ▶ is no local branch there,
 * ▶ is checked out in another worktree (its files there would not follow), or ▶ moved since it was compared.
 */
export type MergeSkip = { name: string; why: "conflict"; files: number } | { name: string; why: "remote" | "worktree" | "moved"; into: string };

/**
 * The repositories Merge ◀ into ▶… leaves out, grouped by why: `summary` is one line for a
 * notification ("7 repositories: develop checked out, not main"), `detail` each group and its names.
 */
export function mergeSkips(skipped: readonly MergeSkip[]): { summary: string; detail: string } {
  const groups = new Map<string, { title: (n: number) => string; names: string[] }>();
  for (const s of skipped) {
    const key = s.why === "conflict" ? "conflict" : `${s.why}\0${s.into}`;
    const repos = (n: number) => plural(n, "repository", "repositories");
    const title = s.why === "conflict" ? (n: number) => localize("{0}: a merge would conflict", repos(n))
      : s.why === "remote" ? (n: number) => localize("{0}: {1} is not a local branch", repos(n), s.into)
      : s.why === "worktree" ? (n: number) => localize("{0}: {1} is checked out in another worktree", repos(n), s.into)
      : (n: number) => localize("{0}: {1} moved since the comparison (Refresh)", repos(n), s.into);
    const g = groups.get(key) ?? groups.set(key, { title, names: [] }).get(key)!;
    g.names.push(s.why === "conflict" ? localize("{0} ({1})", s.name, plural(s.files, "file")) : s.name);
  }
  const list = [...groups.values()];
  return {
    summary: list.map((g) => g.title(g.names.length)).join(" · "),
    detail: list.map((g) => `${g.title(g.names.length)}\n${g.names.join(", ")}`).join("\n\n"),
  };
}

/** Copy as Release Notes: each repository's commits only on the left, as Markdown. */
export function releaseNotes(sections: readonly { repo: string; from: string; into: string; commits: readonly SideCommit[] }[]): string {
  return sections.filter((s) => s.commits.length > 0)
    .map((s) => [`## ${s.repo} (${s.from} → ${s.into})`, "", ...s.commits.map((c) => `- ${c.subject} (${c.sha.slice(0, 7)}, ${c.author})`)].join("\n"))
    .join("\n\n") + "\n";
}

/** A side's page of commits (git returned up to limit + 1, duplicates included): its own rows, and whether more exist. */
export function sidePage(commits: readonly SideCommit[], limit: number): { rows: SideCommit[]; more: boolean } {
  return { rows: commits.slice(0, limit).filter((c) => c.mark === "+"), more: commits.length > limit };
}

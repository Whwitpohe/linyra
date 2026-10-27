import { localize } from "./i18n";
// Compare Branches: every git argument and parser. Pure: no vscode import.
import { parseShow } from "./commitDetail";
import { isValidRef } from "./filterModel";
import type { FileChange } from "./types";

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
  | { kind: "differs"; leftSha: string; rightSha: string; base: string; left: number; right: number; sameLeft: number; sameRight: number };

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
export type PickerItem = { kind: "pair"; pair: Pair } | { kind: "name"; name: string; count: number; favorite: boolean };
export interface PickerGroup {
  title: string;
  items: PickerItem[];
}

/** Commits shown per side before "Show 500 more". */
export const COMMIT_PAGE = 500;

const plural = (n: number, one: string, many = `${one}s`) => localize("{0} {1}", n, localize(n === 1 ? one : many));

/** Names cross the webview boundary: only what git accepts as a branch name reaches git. */
export function validPair(p: unknown): p is Pair {
  const o = p as Partial<Pair> | null;
  return typeof o?.left === "string" && typeof o.right === "string" && isValidRef(o.left) && isValidRef(o.right);
}

/** Both tips and their trees in one spawn: the same tree means the same files, whatever the commits. */
export function revParseArgs(p: Pair): string[] {
  return ["rev-parse", `${p.left}^{commit}`, `${p.right}^{commit}`, `${p.left}^{tree}`, `${p.right}^{tree}`];
}

export function parseRevParse(out: string): { left: string; right: string; sameFiles: boolean } | null {
  const ids = out.split("\n").map((l) => l.trim()).filter(Boolean);
  if (ids.length !== 4 || !ids.every((id) => /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(id))) return null;
  return { left: ids[0], right: ids[1], sameFiles: ids[2] === ids[3] };
}

export function mergeBaseArgs(l: string, r: string): string[] {
  return ["merge-base", l, r];
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

/** What a side changed since the branches split: merge base → its tip, statuses and counts in one spawn. */
export function filesArgs(base: string, tip: string): string[] {
  return ["diff", "--raw", "--numstat", "-z", "-M", base, tip];
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
  return { kind: "differs", leftSha: c.rightSha, rightSha: c.leftSha, base: c.base, left: c.right, right: c.left, sameLeft: c.sameRight, sameRight: c.sameLeft };
}

/** The list's summary. No commit numbers: they mislead when the same change travels by cherry-pick. */
export function summaryLabel(results: readonly RepoCompare[], ticked: number): string {
  let differ = 0, identical = 0, missing = 0;
  for (const c of results) {
    if (c.kind === "identical") identical++;
    else if (c.kind === "missing") missing++;
    else differ++;
  }
  const parts = [localize("{0} {1}", differ, localize(differ === 1 ? "repository differs" : "repositories differ"))];
  if (identical > 0) parts.push(localize("{0} identical", identical));
  if (missing > 0) parts.push(localize("{0} missing a branch", missing));
  parts.push(localize("in {0}", plural(ticked, "repository", "repositories")));
  return parts.join(" · ");
}

/** The Compare view's description, next to its title: the pair, without "origin/". */
export function tabTitle(p: Pair | null): string {
  if (!p || !p.left || !p.right) return "";
  const short = (n: string) => n.replace(/^refs\/(heads|remotes)\//, "").replace(/^origin\//, "");
  return `${short(p.left)} ↔ ${short(p.right)}`;
}

export function pushRecent(recent: readonly Pair[], p: Pair, cap = 5): Pair[] {
  return [p, ...recent.filter((x) => x.left !== p.left || x.right !== p.right)].slice(0, cap);
}

/** Recent pairs (not while searching), Favorites, Local, Remote; a name may be in Favorites and its own group. */
export function pickerGroups(names: readonly { name: string; count: number }[], favorites: readonly string[], recent: readonly Pair[], query: string): PickerGroup[] {
  const q = query.trim().toLowerCase();
  const match = (n: string) => q === "" || n.toLowerCase().includes(q);
  const fav = new Set(favorites);
  const item = (n: { name: string; count: number }): PickerItem => ({ kind: "name", name: n.name, count: n.count, favorite: fav.has(n.name) });
  const sorted = [...names].filter((n) => match(n.name)).sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const remote = (n: string) => isRemoteName(n);
  const groups: PickerGroup[] = [];
  if (q === "" && recent.length > 0) groups.push({ title: localize("Recent pairs"), items: recent.map((pair) => ({ kind: "pair", pair })) });
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

/** A side's page of commits (git returned up to limit + 1, duplicates included): its own rows, and whether more exist. */
export function sidePage(commits: readonly SideCommit[], limit: number): { rows: SideCommit[]; more: boolean } {
  return { rows: commits.slice(0, limit).filter((c) => c.mark === "+"), more: commits.length > limit };
}

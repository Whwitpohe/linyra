// What each repository is on and in the middle of, as the Repo List marks it: its branch (a
// repository on another branch than the rest stands out), VS Code's * + ! for uncommitted work,
// and a merge, rebase, cherry-pick or revert that stopped. Pure: no vscode, no fs.
import { localize } from "./i18n";

/** What a repository is in the middle of, from which of git's state files exist in its git dir. */
export type Operation = "merge" | "rebase" | "cherry-pick" | "revert" | "am";

export const OPERATIONS: readonly Operation[] = ["merge", "rebase", "cherry-pick", "revert", "am"];

export function operationOf(exists: (name: string) => boolean): Operation | undefined {
  if (exists("rebase-merge") || exists("rebase-apply")) return "rebase";
  if (exists("MERGE_HEAD")) return "merge";
  if (exists("CHERRY_PICK_HEAD")) return "cherry-pick";
  if (exists("REVERT_HEAD")) return "revert";
  return undefined;
}

/** HEAD as its file says: "ref: refs/heads/develop" is develop; a commit id is a detached HEAD. */
export function parseHead(text: string): { branch: string | null; detached?: string } | undefined {
  const t = text.trim();
  const ref = /^ref:\s*(\S+)$/.exec(t);
  if (ref) return { branch: shortRef(ref[1]) };
  return /^[0-9a-f]{40,64}$/.test(t) ? { branch: null, detached: t.slice(0, 7) } : undefined;
}

/** A rebase's head-name file: the branch being rebased; null when a detached HEAD is ("detached HEAD"). */
export function rebasedBranch(text: string | undefined): string | null | undefined {
  if (text === undefined) return undefined;
  const t = text.trim();
  return t.startsWith("refs/") ? shortRef(t) : null;
}

const shortRef = (ref: string) => (ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref);

/** Uncommitted work as VS Code's status bar marks it. */
export interface WorkMark {
  /** Unstaged or untracked changes: *. */
  changes: boolean;
  /** Staged changes: +. */
  staged: boolean;
  /** Files with conflicts: !. */
  conflicts: number;
}

/** One repository's mark in the Repo List. */
export interface RepoMark {
  /** The branch checked out (during a rebase, the one being rebased); null when HEAD is detached. */
  branch: string | null;
  /** A detached HEAD's commit, short. */
  detached?: string;
  operation?: Operation;
  /** Absent when not known (VS Code's Git does not watch the repository and it was not read). */
  work?: WorkMark;
}

/** develop*+!, as VS Code's status bar draws a branch: changes, staged changes, conflicts. */
export function workSuffix(w: WorkMark | undefined): string {
  if (!w) return "";
  return `${w.changes ? "*" : ""}${w.staged ? "+" : ""}${w.conflicts > 0 ? "!" : ""}`;
}

/** What the row names: the branch, or "detached 1a2b3c4" (never a bare id that reads like a branch). */
export function headText(m: RepoMark): string {
  return m.branch ?? localize("detached {0}", m.detached ?? "HEAD");
}

/**
 * The branch most of these repositories are on, and those on another one (a detached HEAD
 * included). None when no branch is on more repositories than every other: two repositories
 * on two branches, or a tie, mark nothing.
 */
export function drift(marks: Readonly<Record<string, RepoMark>>, ids: readonly string[]): { common: string | null; others: Set<string> } {
  const counts = new Map<string, number>();
  for (const id of ids) {
    const b = marks[id]?.branch;
    if (b) counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0 || ranked[0][1] < 2 || (ranked.length > 1 && ranked[1][1] === ranked[0][1])) return { common: null, others: new Set() };
  const common = ranked[0][0];
  return { common, others: new Set(ids.filter((id) => marks[id] !== undefined && marks[id].branch !== common)) };
}

/** "merging", "rebasing": the row's badge. */
export function operationLabel(op: Operation): string {
  switch (op) {
    case "merge": return localize("merging");
    case "rebase": return localize("rebasing");
    case "cherry-pick": return localize("cherry-picking");
    case "revert": return localize("reverting");
    case "am": return localize("applying patches");
  }
}

/** The row's tooltip lines after the root: the branch, its work, what it is in the middle of. */
export function markTitle(m: RepoMark, common: string | null): string[] {
  const lines = [m.branch === null ? localize("HEAD detached at {0}", m.detached ?? "?") : localize("On branch {0}", m.branch)];
  if (common !== null && m.branch !== common) lines.push(localize("Most of the ticked repositories are on {0}.", common));
  const w = m.work;
  if (w) {
    // The tooltip explains the row's glyphs.
    const parts = [w.changes ? localize("modified (*)") : "", w.staged ? localize("staged (+)") : ""].filter(Boolean);
    if (parts.length > 0) lines.push(localize("Uncommitted: {0}", parts.join(", ")));
  }
  if (m.operation) {
    const conflicts = w?.conflicts ?? 0;
    lines.push(conflicts === 1 ? localize("{0} stopped: 1 file has conflicts (!). Right-click to resolve, continue or abort.", operationName(m.operation))
      : conflicts > 1 ? localize("{0} stopped: {1} files have conflicts (!). Right-click to resolve, continue or abort.", operationName(m.operation), conflicts)
      : localize("{0} stopped. Right-click to continue or abort.", operationName(m.operation)));
  }
  return lines;
}

/**
 * The tooltip's lines and the row's other parts as one spoken label: the glyph hints dropped (a
 * screen reader would spell out "(*)"), and a comma only after a part that does not end a sentence.
 */
export function spokenLabel(parts: string[]): string {
  return parts.filter(Boolean).map((p) => p.replace(/ \([*+!]\)/g, "")).reduce((said, p) => (said ? `${said}${/[.!?。！？]$/.test(said) ? " " : ", "}${p}` : p), "");
}

/** The command that continues, aborts or resolves a stopped operation (registered in extension.ts). */
export function operationCommand(op: Operation, action: "continue" | "abort" | "resolve"): string {
  if (action === "resolve") return "linyra.resolveConflicts";
  const name = op === "cherry-pick" ? "CherryPick" : op === "am" ? "Am" : op[0].toUpperCase() + op.slice(1);
  return `linyra.${action}${name}`;
}

/** "Merge", "Rebase": a sentence's subject, and the commands' titles. */
export function operationName(op: Operation): string {
  switch (op) {
    case "merge": return localize("Merge");
    case "rebase": return localize("Rebase");
    case "cherry-pick": return localize("Cherry-pick");
    case "revert": return localize("Revert");
    case "am": return localize("Patch series");
  }
}

/**
 * git's own "go on" and "go back" for the operation. The editor is ":", which git never runs: the
 * message it prepared (the merge's, the commit's being replayed) is used as it is.
 */
export function continueArgs(op: Operation): string[] {
  return [op, "--continue"];
}

export function abortArgs(op: Operation): string[] {
  return [op, "--abort"];
}

export const NO_EDITOR_ENV: Record<string, string> = { GIT_EDITOR: ":" };

/** The files git still lists as conflicted. */
export function unmergedArgs(): string[] {
  return ["diff", "--name-only", "-z", "--diff-filter=U", "--"];
}

/** Abort…'s confirmation: what goes back, and that the resolving done so far is lost. */
export function abortPrompt(op: Operation, repos: readonly string[]): { message: string; detail: string; button: string } {
  const button = localize("Abort {0}", operationName(op));
  const message = repos.length === 1
    ? localize("Abort the {0} in {1}?", operationNoun(op), repos[0])
    : localize("Abort the {0} in {1} repositories?", operationNoun(op), repos.length);
  return { message, detail: localize("The branch and the working tree go back to where they were before it began; conflicts resolved so far are lost."), button };
}

/** Abort in All Repositories…: the repositories and what each is in the middle of. */
export function abortAllPrompt(count: number): { message: string; detail: string; button: string } {
  return {
    message: localize("Abort what {0} repositories are in the middle of?", count),
    detail: localize("Each branch and working tree goes back to where it was before its merge, rebase, cherry-pick or revert began; conflicts resolved so far are lost."),
    button: localize("Abort All"),
  };
}

/** "merge", "rebase": inside a sentence. */
export function operationNoun(op: Operation): string {
  switch (op) {
    case "merge": return localize("merge");
    case "rebase": return localize("rebase");
    case "cherry-pick": return localize("cherry-pick");
    case "revert": return localize("revert");
    case "am": return localize("patch series");
  }
}

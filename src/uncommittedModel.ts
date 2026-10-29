import { localize } from "./i18n";
// Uncommitted work as the Log's switch and the Uncommitted view show it. Pure: no vscode import.
import { kindCounts, type KindCounts } from "./changeKinds";
import { fileTree, type TreeNode } from "./fileTree";
import type { FileChange } from "./types";
import type { BranchStatus } from "./workingTree";

export interface RepoWork {
  repoId: string;
  root: string;
  name: string;
  head: string | null;
  /** The checked-out branch and its upstream, from the same git status (absent where git was not run: a clean repository). */
  branch?: BranchStatus;
  /** What a commit now would contain: the index against the last commit. */
  staged: FileChange[];
  /** What is not staged yet: the working tree against the index, untracked files included. */
  changes: FileChange[];
  /** How many of the changes are conflicted (git status's unmerged entries); absent when none. */
  conflicts?: number;
  /** Newest modification time (ms) of a changed file; null when unknown. */
  editedAt: number | null;
  /** VS Code's Git has the repository open: it can stage, discard and commit there. */
  canStage: boolean;
}
export type Group = "staged" | "changes";
export type DiffSide = "head" | "index" | "worktree" | "empty";
export const NO_UNCOMMITTED_VIEW = "No uncommitted changes in the ticked repositories.";

const plural = (n: number, one: string, many = `${one}s`) => localize("{0} {1}", n, localize(n === 1 ? one : many));

/** Each changed path once, though a file staged and changed again is in both halves. */
export function distinctPaths(w: RepoWork): string[] {
  return [...new Set([...w.staged, ...w.changes].map((f) => f.path))].sort();
}

export function totals(works: readonly RepoWork[]): { files: number; repos: number; added: number; deleted: number } {
  let files = 0;
  let repos = 0;
  let added = 0;
  let deleted = 0;
  for (const w of works) {
    const n = distinctPaths(w).length;
    if (n === 0) continue;
    repos++;
    files += n;
    for (const f of [...w.staged, ...w.changes]) {
      added += f.added ?? 0;
      deleted += f.deleted ?? 0;
    }
  }
  return { files, repos, added, deleted };
}

/** Distinct files by kind (a file staged and changed again counts once): the row's +3 ✎2 −1 and its meter. */
export function workKinds(w: RepoWork): KindCounts {
  return kindCounts([...w.staged, ...w.changes]);
}

/** The row's one tag: what is staged. New files are counted by workKinds, not tagged. */
export function tags(w: RepoWork): string[] {
  if (w.staged.length === 0) return [];
  return [w.changes.length === 0 ? localize("all staged") : localize("{0} staged", w.staged.length)];
}

/** The changed paths, each once: how many is the counts' job. */
export function previewLabel(w: RepoWork): string {
  return distinctPaths(w).join(", ");
}

export function editedLabel(nowMs: number, editedAt: number | null): string {
  if (editedAt === null) return "";
  const m = Math.floor((nowMs - editedAt) / 60_000);
  if (m < 1) return localize("edited just now");
  if (m < 60) return localize("edited {0}m ago", m);
  if (m < 48 * 60) return localize("edited {0}h ago", Math.floor(m / 60));
  return localize("edited {0}d ago", Math.floor(m / 1440));
}

/** The diff a row opens, as Source Control: Staged is HEAD ↔ index; Changes is index (or HEAD) ↔ file. */
export function diffFor(group: Group, f: FileChange, alsoStaged: boolean): { left: DiffSide; right: DiffSide } {
  const isNew = f.status === "A" || f.untracked === true;
  if (group === "staged") return { left: isNew ? "empty" : "head", right: f.status === "D" ? "empty" : "index" };
  if (f.untracked) return { left: "empty", right: "worktree" };
  return { left: alsoStaged ? "index" : "head", right: f.status === "D" ? "empty" : "worktree" };
}

/**
 * What Discard does to the files it listed. `staged` are the listed files taken from the Staged
 * group: they are unstaged first. A file new to the index (added, or a rename's or copy's new
 * name) is then untracked, so it is deleted, like a new file never staged.
 */
export function discardPlan(files: readonly FileChange[], staged: readonly FileChange[]): { paths: string[]; unstage: string[]; remove: string[] } {
  const both = (f: FileChange) => (f.oldPath ? [f.path, f.oldPath] : [f.path]);
  const isNew = (f: FileChange) => f.untracked === true || (staged.includes(f) && (f.status === "A" || f.status === "R" || f.status === "C"));
  return {
    paths: [...new Set(files.flatMap(both))],
    unstage: [...new Set(staged.flatMap(both))],
    remove: [...new Set(files.filter(isNew).map((f) => f.path))],
  };
}


/** Files staged as new (git add) and never committed. A staged rename or copy is not one: Rollback moves it back. */
export const addedPaths = (staged: readonly FileChange[]): Set<string> => new Set(staged.filter((f) => f.status === "A" && !f.untracked).map((f) => f.path));

/**
 * Discard Changes, as the JetBrains IDEs' Rollback: tracked files go back to the last commit, and
 * an added file only leaves version control (`unadd`: unstaged, kept on disk). New files are not
 * changes to discard: Delete… removes them.
 */
export function rollbackPlan(files: readonly FileChange[], staged: readonly FileChange[]): { paths: string[]; unstage: string[]; remove: string[]; unadd: string[] } {
  const added = addedPaths(staged);
  const rest = (list: readonly FileChange[]) => list.filter((f) => !added.has(f.path) && !f.untracked);
  return { ...discardPlan(rest(files), rest(staged)), unadd: [...added] };
}

/**
 * Discard Changes' prompt, one verb wherever uncommitted work is listed (the Uncommitted side, the
 * Changes view, the Commit side bar). It does what the JetBrains Rollback does: tracked files go
 * back to the last commit, an added file only leaves version control (kept on disk), and a new
 * file is never deleted by it (Delete… is the command that deletes files). The prompt says each.
 */
export function discardPrompt(repoName: string, files: readonly FileChange[], one: boolean, staged: readonly FileChange[] = []): { message: string; detail: string; button: string } {
  const added = addedPaths(staged);
  const tracked = files.filter((f) => !f.untracked);
  const others = tracked.filter((f) => !added.has(f.path));
  // A file staged and changed again is listed in both groups: count it once.
  const n = new Set(tracked.map((f) => f.path)).size;
  const kept = new Set(files.filter((f) => f.untracked).map((f) => f.path)).size;
  const message = one ? localize("Discard changes in \"{0}\"?", (tracked[0] ?? files[0]).path) : localize("Discard changes in {0} in {1}?", plural(n, "file"), repoName);
  const detail: string[] = [];
  if (others.length > 0) detail.push(localize("This can't be undone.{0}", staged.some((f) => !added.has(f.path)) ? localize(" Staged changes are discarded too.") : ""));
  if (added.size === 1) detail.push(localize("The added file leaves version control and stays on disk as a new file."));
  if (added.size > 1) detail.push(localize("The {0} added files leave version control and stay on disk as new files.", added.size));
  if (kept > 0) detail.push(localize(kept === 1 ? "The new file stays: Delete… removes it." : "The {0} new files stay: Delete… removes them.", kept));
  return { message, detail: detail.join(" "), button: one ? localize("Discard File") : localize("Discard Changes") };
}

const byPath = (a: FileChange, b: FileChange) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** Add to VCS, as git will show it: the new files staged as added. Shown at once; the read that follows confirms it. */
export function withAdded(w: RepoWork, paths: ReadonlySet<string>): RepoWork {
  const moved = w.changes.filter((f) => f.untracked && paths.has(f.path));
  if (moved.length === 0) return w;
  return { ...w, changes: w.changes.filter((f) => !moved.includes(f)), staged: [...w.staged, ...moved.map(({ untracked: _, ...f }) => ({ ...f, status: "A" as const }))].sort(byPath) };
}

/** Remove from VCS, as git will show it: the added files untracked again, edits since included. */
export function withUnadded(w: RepoWork, paths: ReadonlySet<string>): RepoWork {
  const moved = new Set(w.staged.filter((f) => f.status === "A" && !f.untracked && paths.has(f.path)).map((f) => f.path));
  if (moved.size === 0) return w;
  return {
    ...w, staged: w.staged.filter((f) => !moved.has(f.path)),
    changes: [...w.changes.filter((f) => !moved.has(f.path)), ...[...moved].map((path): FileChange => ({ path, added: 0, deleted: 0, status: "A", untracked: true }))].sort(byPath),
  };
}

/** Delete, as git will show it: the files gone from both lists. */
export function withoutFiles(w: RepoWork, paths: ReadonlySet<string>): RepoWork {
  return { ...w, staged: w.staged.filter((f) => !paths.has(f.path)), changes: w.changes.filter((f) => !paths.has(f.path)) };
}

/** Delete…'s prompt: new files (unversioned, or added and never committed) go from the disk. */
export function deletePrompt(repoName: string, paths: readonly string[], one: boolean): { message: string; detail: string; button: string } {
  return {
    message: one ? localize("Delete \"{0}\"?", paths[0]) : localize("Delete {0} in {1}?", plural(paths.length, "file"), repoName),
    detail: paths.length === 1 ? localize("The file is deleted from disk. This can't be undone.") : localize("The files are deleted from disk. This can't be undone."),
    button: localize("Delete"),
  };
}


export interface UNode {
  kind: "repo" | "group" | "folder" | "file";
  /** Stable across re-renders so VS Code keeps expand state. */
  id: string;
  label: string;
  description: string;
  tooltip: string;
  /** Menus key off it: repo.stageable|readonly, group|folder.staged|changes[.readonly], file.staged|changes[.untracked|.deleted][.readonly]. */
  contextValue: string;
  repoId: string;
  group?: Group;
  path?: string;
  file?: FileChange;
  children: UNode[];
}

function fileStat(f: FileChange): string {
  if (f.untracked) return localize("new");
  if (f.added === null) return localize("binary");
  const counts = `+${f.added} −${f.deleted}`;
  return f.oldPath ? `← ${f.oldPath}  ${counts}` : counts;
}

function describeTree(nodes: readonly TreeNode[], parent: string, base: string, w: RepoWork, group: Group): UNode[] {
  const ro = w.canStage ? "" : ".readonly";
  return nodes.map((n): UNode => {
    if (n.kind === "folder") {
      const path = parent ? `${parent}/${n.name}` : n.name;
      return { kind: "folder", id: `${base}/d:${path}`, label: n.name, description: String(n.count), tooltip: path, contextValue: `folder.${group}${ro}`, repoId: w.repoId, group, path, children: describeTree(n.children, path, base, w, group) };
    }
    const f = n.file;
    return {
      kind: "file", id: `${base}/f:${f.path}`, label: n.name, description: fileStat(f), tooltip: f.oldPath ? `${f.oldPath} → ${f.path}` : f.path,
      contextValue: `file.${group}${f.untracked ? ".untracked" : f.status === "D" ? ".deleted" : ""}${ro}`, repoId: w.repoId, group, path: f.path, file: f, children: [],
    };
  });
}

/** Everything the Uncommitted view shows, as plain data. The VS Code adapter only maps it to TreeItems. */
export function describeUncommitted(works: readonly RepoWork[]): { message: string | undefined; roots: UNode[] } {
  const roots = works.filter((w) => distinctPaths(w).length > 0).map((w): UNode => {
    const ro = w.canStage ? "" : ".readonly";
    const groups: UNode[] = [];
    for (const [group, list, label] of [["staged", w.staged, localize("Staged")], ["changes", w.changes, localize("Changes")]] as const) {
      if (list.length === 0) continue;
      const id = `${w.repoId}/${group}`;
      groups.push({ kind: "group", id, label, description: String(list.length), tooltip: localize("{0} in {1}", label, w.name), contextValue: `group.${group}${ro}`, repoId: w.repoId, group, children: describeTree(fileTree(list), "", id, w, group) });
    }
    return {
      kind: "repo", id: w.repoId, label: w.name, description: plural(distinctPaths(w).length, "file"),
      tooltip: w.canStage ? localize("{0}: uncommitted changes", w.name) : localize("{0}: staging needs VS Code's Git to have this repository open.", w.name),
      contextValue: w.canStage ? "repo.stageable" : "repo.readonly", repoId: w.repoId, children: groups,
    };
  });
  return { message: roots.length === 0 ? localize(NO_UNCOMMITTED_VIEW) : undefined, roots };
}

/** The Uncommitted view's description (next to its title): how much is uncommitted, and where. */
export function viewLabel(t: { files: number; repos: number }): string {
  if (t.files === 0) return "";
  return `${plural(t.files, "file")} · ${plural(t.repos, "repository", "repositories")}`;
}

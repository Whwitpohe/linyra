import { localize } from "./i18n";
// Uncommitted work as the Log's switch and the Uncommitted view show it. Pure: no vscode import.
import { fileTree, type TreeNode } from "./fileTree";
import type { FileChange } from "./types";

export interface RepoWork {
  repoId: string;
  root: string;
  name: string;
  head: string | null;
  /** What a commit now would contain: the index against the last commit. */
  staged: FileChange[];
  /** What is not staged yet: the working tree against the index, untracked files included. */
  changes: FileChange[];
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

/** Distinct files by kind: new (added or untracked), deleted, modified (the rest). */
export function meter(w: RepoWork): { added: number; modified: number; deleted: number } {
  const kind = new Map<string, "added" | "modified" | "deleted">();
  for (const f of [...w.staged, ...w.changes]) {
    const k = f.status === "A" || f.untracked ? "added" : f.status === "D" ? "deleted" : "modified";
    if (!kind.has(f.path) || k !== "modified") kind.set(f.path, k);
  }
  const out = { added: 0, modified: 0, deleted: 0 };
  for (const k of kind.values()) out[k]++;
  return out;
}

export function tags(w: RepoWork): string[] {
  const out: string[] = [];
  if (w.staged.length > 0) out.push(w.changes.length === 0 ? localize("all staged") : localize("{0} staged", w.staged.length));
  const news = w.changes.filter((f) => f.untracked).length;
  if (news > 0) out.push(localize("{0} new", news));
  return out;
}

export function previewLabel(w: RepoWork): string {
  const paths = distinctPaths(w);
  return `${plural(paths.length, "file")} · ${paths.join(", ")}`;
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

export function discardPrompt(repoName: string, files: readonly FileChange[], one: boolean, staged: readonly FileChange[] = []): { message: string; detail: string; button: string } {
  // A file staged and changed again is listed in both groups: count it once.
  const n = new Set(files.map((f) => f.path)).size;
  const news = discardPlan(files, staged).remove.length;
  const message = one ? localize("Discard changes in \"{0}\"?", files[0].path) : localize("Discard changes in {0} in {1}?", plural(n, "file"), repoName);
  let extra = "";
  if (staged.length > 0) extra += localize(" Staged changes are discarded too.");
  if (news > 0) extra += one || news === n ? (news === 1 ? localize(" This deletes the new file.") : localize(" This deletes the new files.")) : localize(" {0} will be deleted.", plural(news, "new file"));
  return { message, detail: localize("This can't be undone.{0}", extra), button: one ? localize("Discard File") : localize("Discard All") };
}

/** Files a commit-all takes, as git.smartCommitChanges says: every change, or tracked files only. */
export function commitCount(w: RepoWork, changes: "all" | "tracked"): number {
  return new Set(w.changes.filter((f) => changes === "all" || !f.untracked).map((f) => f.path)).size;
}

export type CommitStep = "message" | "commitAll" | "askStageAll" | "nothing";

/** What Commit… does first, as VS Code's own commit: staged files, else git.enableSmartCommit or ask. */
export function commitStep(staged: number, changes: number, smartCommit: boolean): CommitStep {
  if (staged > 0) return "message";
  if (changes === 0) return "nothing";
  return smartCommit ? "commitAll" : "askStageAll";
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

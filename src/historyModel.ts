// File History and Folder History, the parts with no vscode in them: the uncommitted row's data
// (from work the uncommitted store already read: no git process), the two revisions a two-row
// selection compares, and the filters Folder History sets.
import type { FilterState } from "./filterModel";
import type { HistoryWork } from "./protocol";
import type { Commit, FileChange } from "./types";
import type { RepoWork } from "./uncommittedModel";

/**
 * The file's uncommitted change, from its repository's work: null when it has none. A file
 * staged and changed again is one change, HEAD to the working tree: its status is the stronger
 * one (new or deleted wins), its lines the two halves' sum (null when either half is binary).
 */
export function historyWorkOf(w: RepoWork | undefined, path: string): HistoryWork | null {
  if (!w) return null;
  const named = (f: FileChange) => f.path === path || f.oldPath === path;
  const staged = w.staged.find(named);
  const change = w.changes.find(named);
  const halves = [staged, change].filter((f): f is FileChange => f !== undefined);
  if (halves.length === 0) return null;
  const untracked = change?.untracked === true;
  const status = untracked ? "A" : change?.status === "D" ? "D" : staged?.status ?? change?.status ?? "M";
  const binary = halves.some((f) => f.added === null || f.deleted === null);
  const oldPath = staged?.oldPath ?? change?.oldPath;
  return {
    path: (change ?? staged)!.path, ...(oldPath ? { oldPath } : {}), status, untracked, staged: staged !== undefined, partlyStaged: staged !== undefined && change !== undefined,
    added: binary ? null : halves.reduce((n, f) => n + (f.added ?? 0), 0),
    deleted: binary ? null : halves.reduce((n, f) => n + (f.deleted ?? 0), 0),
  };
}

/** One side of a revision diff: the file at a commit, or nothing (ref null) where it did not exist. */
export interface RevisionSide { ref: string | null; path: string }

/**
 * Two File History rows: the file at the older one, then at the newer one (the Log lists newer
 * first, so `rows` is in list order). A row that deleted the file has nothing on its side.
 * undefined when a row has no file (it was not read as a file history).
 */
export function revisionPair(rows: readonly [Commit, Commit]): { before: RevisionSide; after: RevisionSide } | undefined {
  const [newer, older] = rows;
  if (!newer.file || !older.file) return undefined;
  return {
    before: { ref: older.file.status === "D" ? null : older.sha, path: older.file.path },
    after: { ref: newer.file.status === "D" ? null : newer.sha, path: newer.file.path },
  };
}

/**
 * Folder History is the Log's own Path filter, set for one folder of one repository: every
 * commit that touched it, of all time, by anyone. The branch selection and the order stay.
 */
export function folderFilter(f: FilterState, repoId: string, path: string): FilterState {
  return { ...f, path, repoIds: [repoId], date: "all", from: undefined, to: undefined, text: "", author: "", mine: false, authors: undefined };
}

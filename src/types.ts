import type { CommitReference } from "./commitReferences";

export interface Repo {
  /** Absolute repository root; stable identity across messages. */
  id: string;
  /** Display label; unique within one workspace (see repos.ts). */
  name: string;
  root: string;
}

/** The pseudo-commit id of a repository's uncommitted changes (git's own null id). */
export const UNCOMMITTED = "0".repeat(40);

export interface Commit {
  repoId: string;
  sha: string;
  /** Committer date, unix seconds — the only sort key unrelated repos share. */
  time: number;
  author: string;
  email: string;
  subject: string;
  parents: string[];
  /** Selected branches used for this repository's query. */
  ref?: string;
  /** Branches, HEAD and tags pointing directly at this commit, from Git's decoration field. */
  refs?: CommitReference[];
  /**
   * File history only: the file as it was in this commit (it may have been renamed since), and
   * the lines this commit added and deleted in it (null: binary; absent: not read).
   */
  file?: { path: string; oldPath?: string; status?: ChangeStatus; added?: number | null; deleted?: number | null };
}

/** What a commit did to a file, from `git show --raw`: Added, Modified, Deleted, Renamed, Copied, Type-changed. */
export type ChangeStatus = "A" | "M" | "D" | "R" | "C" | "T";

export interface FileChange {
  path: string;
  /** Set for renames. */
  oldPath?: string;
  /** null for binary files. */
  added: number | null;
  deleted: number | null;
  status?: ChangeStatus;
  /** Uncommitted changes only: every change is in the index (git add). */
  staged?: boolean;
  /** Uncommitted changes only: a new file git does not track yet. */
  untracked?: boolean;
  /** Staged uncommitted changes only: the index's blob id. */
  blob?: string;
}

export interface RepoFailure {
  repoId: string;
  name: string;
  reason: string;
}

export function commitKey(c: { repoId: string; sha: string }): string {
  return `${c.repoId}\0${c.sha}`;
}

/** 40-hex (SHA-1) or 64-hex (SHA-256) object name. Guards every ref that crosses the webview boundary. */
export function isSha(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(s);
}

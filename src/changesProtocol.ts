import type { ChangeStatus } from "./types";
import type { CommitReference } from "./commitReferences";

export interface ChangeRow {
  id: string;
  kind: "file" | "folder" | "repo";
  label: string;
  description: string;
  tooltip: string;
  contextValue: string;
  path?: string;
  oldPath?: string;
  status?: ChangeStatus;
  added?: number | null;
  deleted?: number | null;
  staged?: boolean;
  untracked?: boolean;
  unchanged?: boolean;
  combined?: boolean;
  collapsed?: boolean;
  children?: ChangeRow[];
}

export interface CommitDetails {
  repoId: string;
  repoName: string;
  sha: string;
  title: string;
  body: string;
  author: string;
  email: string;
  time: number;
  accent?: number;
  refs?: CommitReference[];
  /** The branches containing the commit (commitReferences.ts), read after the rest: absent until then. */
  containing?: CommitReference[];
  /** The commit's parents: each one selects that commit in the Log. */
  parents?: string[];
}

export interface ChangesPage {
  type: "changes";
  key: string;
  description: string;
  message?: string;
  roots: ChangeRow[];
  /** All Files still filters the commit's changes, including folders not expanded on screen. */
  searchRoots?: ChangeRow[];
  details: CommitDetails[];
  focusId?: string;
  allFiles?: boolean;
}

/** Only row ids cross back into the host; paths and diff arguments come from its current model. */
export type ChangesMessage =
  | { type: "action"; action: "allFiles" | "changedFiles" | "clearSelection" | "expandAll" | "openOnRemote" | "openChangesEditor" }
  | { type: "ready" }
  | { type: "expand"; id: string }
  | { type: "open"; id: string }
  | { type: "selection"; ids: string[] }
  | { type: "copy"; sha: string; field: "sha" | "message" }
  /** A parent hash in the commit details: select that commit in the Log. */
  | { type: "selectCommit"; repoId: string; sha: string };

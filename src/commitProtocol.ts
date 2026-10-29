// Messages between the Commit side bar's webview and the extension host.
import type { CommitRow } from "./commitModel";

export interface CommitState {
  type: "state";
  roots: CommitRow[];
  /** Instead of the tree: nothing uncommitted, or not read yet. */
  notice?: string;
  /** "5 files · 2 repositories" above the tree. */
  summary: string;
  /** What the Commit button takes, under it. */
  checkedLabel: string;
  checkedFiles: number;
  /** A commit is running: the buttons wait for it. */
  busy: boolean;
}

export type CommitHostMessage =
  | CommitState
  /** Sent once a webview is ready: the message typed before (kept per workspace). */
  | { type: "draft"; text: string; amend: boolean }
  /** Amend ticked with an empty box: the last commit's message, to edit. */
  | { type: "amendMessage"; text: string }
  /** Every repository committed: the box empties. */
  | { type: "committed" };

export type CommitWebviewMessage =
  | { type: "ready" }
  | { type: "check"; ids: string[]; on: boolean }
  | { type: "selection"; ids: string[] }
  /** Show Diff (HEAD ↔ working tree); preview: a click, not Enter. */
  | { type: "diff"; id: string; preview: boolean }
  | { type: "openFile"; id: string }
  /** The selected rows, or the checked files when none is selected. */
  | { type: "rollback" }
  | { type: "refresh" }
  | { type: "draft"; text: string; amend: boolean }
  | { type: "amend"; on: boolean; text: string }
  | { type: "commit"; message: string; amend: boolean; push: boolean };

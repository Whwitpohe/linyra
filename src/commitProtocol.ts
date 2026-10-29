// Messages between the Commit side bar's message box (a webview below the native tree) and the host.

export interface CommitState {
  type: "state";
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
  | { type: "draft"; text: string; amend: boolean }
  | { type: "amend"; on: boolean; text: string }
  | { type: "commit"; message: string; amend: boolean; push: boolean };

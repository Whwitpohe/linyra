// Messages between the Commit side bar's message box (a webview below the native tree) and the host.

export interface CommitState {
  type: "state";
  /** What the Commit button takes, under it. */
  checkedLabel: string;
  checkedFiles: number;
  /** A commit is running: the buttons wait for it. */
  busy: boolean;
  /** AI can write the message: the ✨ button shows. */
  ai?: boolean;
}

export type CommitHostMessage =
  | CommitState
  /** Sent once a webview is ready: the message typed before, and the options (kept per workspace). */
  | { type: "draft"; text: string; amend: boolean; signOff: boolean; author: string }
  /** Commit Message History: the message picked, into the box. */
  | { type: "message"; text: string }
  /** Author… set (or cleared: ""). */
  | { type: "author"; author: string }
  /** Amend ticked with an empty box: the last commit's message, to edit. */
  | { type: "amendMessage"; text: string }
  /** Every repository committed: the box empties. */
  | { type: "committed" }
  /**
   * ✨: the AI message so far (done: false, streamed into the box), then once more done. The
   * final text goes in as one undoable edit; no text when done means the box goes back as it was
   * (stopped, or `error`).
   */
  | { type: "generated"; text: string; done: boolean; error?: string }
  /** ✨ started (from the button, or the command): the box keeps what it had, for Undo. */
  | { type: "generating" };

export type CommitWebviewMessage =
  | { type: "ready" }
  | { type: "draft"; text: string; amend: boolean; signOff: boolean }
  | { type: "amend"; on: boolean; text: string }
  /** Ctrl+M or the History button. */
  | { type: "history" }
  /** The Author… button, or its × (clear: back to the repository's own git user). */
  | { type: "author"; clear?: boolean }
  | { type: "commit"; message: string; amend: boolean; push: boolean; signOff: boolean }
  /** ✨ pressed: a message for the checked files; `text`, the box's text, is the user's hint. */
  | { type: "generate"; text: string }
  /** ✨ pressed again (or Esc) while it writes. */
  | { type: "generateStop" };

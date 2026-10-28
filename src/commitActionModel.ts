import { isValidRef } from "./filterModel";
import { isSha } from "./types";

/** The Log's commit-row actions that change a repository (the JetBrains Log's set). */
export type CommitAction = "cherryPick" | "revert" | "reset" | "checkout" | "newBranch" | "newTag" | "undo" | "reword";
export type ResetMode = "soft" | "mixed" | "hard";
export const RESET_MODES: readonly ResetMode[] = ["soft", "mixed", "hard"];

/**
 * Explicit argv, never shell text. The commit is a full hash (checked), so it can never be read
 * as an option. A merge commit is cherry-picked or reverted against its first parent, the
 * branch it was merged into — what the JetBrains Log does too.
 */
export const commitCommands = {
  cherryPick: (sha: string, merge: boolean) => ["cherry-pick", ...(merge ? ["-m", "1"] : []), check(sha)],
  revert: (sha: string, merge: boolean) => ["revert", "--no-edit", ...(merge ? ["-m", "1"] : []), check(sha)],
  reset: (sha: string, mode: ResetMode) => ["reset", `--${mode}`, check(sha), "--"],
  checkout: (sha: string) => ["checkout", "--detach", check(sha), "--"],
  newBranch: (sha: string, name: string) => ["checkout", "-b", checkName(name), check(sha), "--"],
  newTag: (sha: string, name: string) => ["tag", checkName(name), check(sha)],
  /** Undo Commit: the branch steps back one commit; its changes stay staged. */
  undo: (sha: string) => ["reset", "--soft", `${check(sha)}~1`, "--"],
  /** Edit Commit Message: the message (on stdin) replaces HEAD's, nothing staged is added. */
  reword: () => ["commit", "--amend", "--only", "--allow-empty", "--file=-"],
  /** Remote-tracking branches that already have the commit: undoing or rewording it rewrites published history. */
  pushedTo: (sha: string) => ["branch", "--remotes", "--contains", check(sha), "--format=%(refname:short)"],
};

/** A new subject line in front of the message's body (kept as it was). */
export function rewordMessage(message: string, subject: string): string {
  const lines = message.replace(/\r\n/g, "\n").split("\n");
  const body = lines.slice(1).join("\n").replace(/^\n+/, "");
  return body.trim() ? `${subject.trim()}\n\n${body.replace(/\s+$/, "")}\n` : `${subject.trim()}\n`;
}

function check(sha: string): string {
  if (!isSha(sha)) throw new Error(`not a commit hash: ${sha}`);
  return sha;
}

function checkName(name: string): string {
  if (!isValidRef(name)) throw new Error(`not a valid name: ${name}`);
  return name;
}

/** Why a new branch or tag name cannot be used; undefined when it can. Messages are localize keys. */
export function newRefProblem(name: string, taken: readonly string[], kind: "branch" | "tag"): string | undefined {
  const n = name.trim();
  if (!isValidRef(n)) return kind === "branch" ? "Enter a valid branch name." : "Enter a valid tag name.";
  if (taken.includes(n)) return kind === "branch" ? "A local branch with this name already exists." : "A tag with this name already exists.";
  return undefined;
}

/** `git for-each-ref --format=%(refname:short) refs/tags` (or refs/heads) → the names. */
export function parseRefNames(output: string): string[] {
  return output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/**
 * What a failed action left behind, from git's own words (LC_ALL=C): a cherry-pick or revert
 * that stopped on conflicts is in progress and must be finished or aborted in Source Control.
 * A localize key, or undefined for git's message as is.
 */
export function stoppedReason(action: CommitAction, stderr: string): string | undefined {
  if (action !== "cherryPick" && action !== "revert") return undefined;
  // First: git's "now empty" note itself mentions "conflict resolution".
  if (/nothing to commit|previous cherry-pick is now empty|empty commit/i.test(stderr)) {
    return "its changes are already on the checked-out branch";
  }
  if (/\bconflict/i.test(stderr) || /could not (apply|revert)/i.test(stderr)) {
    return action === "cherryPick"
      ? "the cherry-pick stopped on conflicts. Resolve them in Source Control, then commit, or run git cherry-pick --abort"
      : "the revert stopped on conflicts. Resolve them in Source Control, then commit, or run git revert --abort";
  }
  return undefined;
}

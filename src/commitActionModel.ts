import { isValidRef } from "./filterModel";
import { localize } from "./i18n";
import { isSha } from "./types";

/** The Log's commit-row actions that change a repository (the JetBrains Log's set). */
export type CommitAction = "cherryPick" | "revert" | "reset" | "checkout" | "newBranch" | "newTag" | "undo" | "reword" | "pushUpTo";
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

/** stoppedReason for a cherry-pick or revert with nothing left to apply: it is skipped, not left in progress. */
export const ALREADY_APPLIED = "its changes are already on the checked-out branch";

/**
 * What a failed action left behind, from git's own words (LC_ALL=C): a cherry-pick or revert
 * that stopped on conflicts is in progress and must be finished or aborted in Source Control.
 * A localize key, or undefined for git's message as is. `output`: its stderr, then its stdout.
 */
export function stoppedReason(action: CommitAction, output: string): string | undefined {
  if (action !== "cherryPick" && action !== "revert") return undefined;
  // Whole lines git starts itself, never words of a subject: "error: could not apply 1a2b3c4...
  // Allow empty commit" is a conflict, and the empty note's "conflict resolution" is not one.
  const lines = output.split(/\r?\n/);
  if (lines.some((l) => /^CONFLICT \(/.test(l) || /^error: could not (apply|revert) [0-9a-f]{4,}\.\.\./.test(l))) {
    return action === "cherryPick"
      ? "the cherry-pick stopped on conflicts. Resolve them in Source Control, then commit, or run git cherry-pick --abort"
      : "the revert stopped on conflicts. Resolve them in Source Control, then commit, or run git revert --abort";
  }
  // A cherry-pick says so on stderr; a revert only prints git commit's status on stdout.
  if (lines.some((l) => /^The previous cherry-pick is now empty\b/.test(l) || /^(nothing to commit|nothing added to commit|no changes added to commit)\b/.test(l))) return ALREADY_APPLIED;
  return undefined;
}

/**
 * Several cherry-picks (or reverts) in one repository, in the order given. One with nothing left
 * to apply (its changes are already there) is skipped and the next one goes on; any other failure
 * stops the rest: `error`, with stoppedReason's word for it.
 */
export async function applyEach(action: "cherryPick" | "revert", shas: readonly string[], apply: (sha: string) => Promise<unknown>, skip: () => Promise<unknown>, textOf: (e: unknown) => string): Promise<{ applied: number; empty: number; error?: unknown; reason?: string }> {
  let applied = 0, empty = 0;
  for (const sha of shas) {
    try {
      await apply(sha);
      applied++;
    } catch (e) {
      const reason = stoppedReason(action, textOf(e));
      if (reason !== ALREADY_APPLIED) return { applied, empty, error: e, reason };
      await skip();
      empty++;
    }
  }
  return { applied, empty };
}

/** What a reset moves: commits on HEAD and not on the target (they leave), and on the target only (they arrive). */
export function resetDistanceArgs(sha: string, notOn?: string): string[] {
  return ["rev-list", "--left-right", "--count", `HEAD...${check(sha)}`, ...(notOn === undefined ? [] : notOn === "" ? ["--not", "--remotes"] : ["--not", `refs/remotes/${checkName(notOn)}`]), "--"];
}

/**
 * Reset Current Branch to Here's confirmation: how many commits leave the branch (and how many of
 * them are already pushed), what arrives when the target is off the branch, and what happens to
 * the files. Never just "Reset?".
 */
export function resetPrompt(o: { branch: string; target: string; repo: string; mode: ResetMode; leaving: number; pushed: number; upstream?: string; arriving: number }): { message: string; detail: string; button: string } {
  const commits = (n: number) => localize(n === 1 ? "{0} commit" : "{0} commits", n);
  const lines: string[] = [];
  if (o.leaving > 0) {
    lines.push(o.pushed > 0
      ? localize(o.leaving === 1 ? "{0} leaves {1} (already pushed to {3})." : "{0} leave {1} ({2} already pushed to {3}).", commits(o.leaving), o.branch, String(o.pushed), o.upstream ?? localize("a remote"))
      : localize(o.leaving === 1 ? "{0} leaves {1}." : "{0} leave {1}.", commits(o.leaving), o.branch));
  }
  if (o.arriving > 0) lines.push(localize("{0} gets {1} from {2}.", o.branch, commits(o.arriving), o.target));
  if (o.leaving === 0 && o.arriving === 0) lines.push(localize("{0} is already at {1}: only the files change.", o.branch, o.target));
  lines.push(o.mode === "hard" ? localize("Uncommitted changes are deleted. This cannot be undone.")
    : o.mode === "soft" ? localize("Their changes stay in your files, staged.") : localize("Their changes stay in your files, unstaged."));
  if (o.pushed > 0) lines.push(localize("Pushed commits come back with the next pull; to remove them from the remote too, the next push needs a force push."));
  return { message: localize("Reset {0} to {1} in {2}?", o.branch, o.target, o.repo), detail: lines.join("\n"), button: o.mode === "hard" ? localize("Reset and Delete Changes") : localize("Reset") };
}

/** "Could not cherry-pick 1a2b3c4 in acme-web: …". */
export function commitFailed(action: CommitAction, sha: string, repo: string, why: string): string {
  switch (action) {
    case "cherryPick": return localize("Could not cherry-pick {0} in {1}: {2}.", sha, repo, why);
    case "revert": return localize("Could not revert {0} in {1}: {2}.", sha, repo, why);
    case "reset": return localize("Could not reset to {0} in {1}: {2}.", sha, repo, why);
    case "checkout": return localize("Could not check out {0} in {1}: {2}.", sha, repo, why);
    case "newBranch": return localize("Could not create a branch at {0} in {1}: {2}.", sha, repo, why);
    case "newTag": return localize("Could not create a tag at {0} in {1}: {2}.", sha, repo, why);
    case "undo": return localize("Could not undo {0} in {1}: {2}.", sha, repo, why);
    case "reword": return localize("Could not edit the message of {0} in {1}: {2}.", sha, repo, why);
    case "pushUpTo": return localize("Could not push up to {0} in {1}: {2}.", sha, repo, why);
  }
}

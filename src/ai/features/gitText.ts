// The git reads the AI features make: one commit's message and patch, uncommitted work against
// the last commit, a range's commits and diff, a conflict's three versions. Read-only, explicit
// argv. Pure: no vscode import.
import { isValidRef } from "../../filterModel";
import { EMPTY_TREE } from "../../workingTree";
import { splitPatch, type FileDiff } from "./context";

/** Patches read the same whatever the user's diff config says: no color, no external tool, renames found. */
const PATCH = ["--no-color", "--no-ext-diff", "--no-textconv", "-M", "--unified=3"];
/** Most commits a range read lists (its diff is limited by the prompt's budget). */
export const RANGE_MAX = 200;

/** One commit: author, date and full message, then its patch (merges against their first parent, as the Log's diffs). */
export function commitPatchArgs(sha: string): string[] {
  return ["show", "--format=%H%x00%an%x00%ae%x00%at%x00%B%x1e", "--patch", ...PATCH, "--diff-merges=first-parent", sha, "--"];
}

export interface CommitText { sha: string; author: string; email: string; time: number; message: string; files: FileDiff[] }

export function parseCommitPatch(stdout: string): CommitText {
  const end = stdout.indexOf("\x1e");
  const head = end < 0 ? stdout : stdout.slice(0, end);
  const [sha = "", author = "", email = "", time = "0", ...message] = head.split("\0");
  return { sha, author, email, time: Number(time) || 0, message: message.join("\0").replace(/\s+$/, ""), files: splitPatch(end < 0 ? "" : stdout.slice(end + 1)) };
}

/** Uncommitted work: the working tree (staged or not) against the last commit, or everything before the first one. Untracked files are not in it. */
export function wipPatchArgs(head: string | null): string[] {
  return ["diff", ...PATCH, head ?? EMPTY_TREE, "--"];
}

/** A range given as two refs: both must be refs git accepts, never options. */
export function rangeOk(base: string, tip: string): boolean {
  return [base, tip].every((r) => r === "HEAD" || r === "@{upstream}" || isValidRef(r));
}

/** The commits on `tip` that `base` does not have, newest first. */
export function rangeLogArgs(base: string, tip: string, max = RANGE_MAX): string[] {
  return ["log", `--max-count=${max}`, "--no-color", "--format=%h%x00%an%x00%at%x00%s%x00%b%x1e", `${base}..${tip}`, "--"];
}

export interface RangeCommit { sha: string; author: string; time: number; subject: string; body: string }

export function parseRangeLog(stdout: string): RangeCommit[] {
  return stdout.split("\x1e").map((r) => r.replace(/^\n+/, "")).filter((r) => r.includes("\0")).map((r) => {
    const [sha = "", author = "", time = "0", subject = "", ...body] = r.split("\0");
    return { sha, author, time: Number(time) || 0, subject, body: body.join("\0").trim() };
  });
}

/** What `tip` changed since it split from `base` (three dots: the merge base, as a pull request shows it). */
export function rangePatchArgs(base: string, tip: string): string[] {
  return ["diff", ...PATCH, `${base}...${tip}`, "--"];
}

/** The files a merge, rebase or cherry-pick left conflicted. */
export function unmergedArgs(): string[] {
  return ["diff", "--name-only", "--diff-filter=U", "-z"];
}

export const parseNames = (stdout: string): string[] => stdout.split("\0").map((s) => s.replace(/^\n+/, "")).filter(Boolean);

/** One side of a conflicted file from the index: 1 the common ancestor, 2 ours, 3 theirs. */
export function stageArgs(stage: 1 | 2 | 3, path: string): string[] {
  return ["show", `:${stage}:${path}`];
}

/** A file as it is at a commit (Compare's predicted conflicts read both tips and their merge base). */
export function blobArgs(sha: string, path: string): string[] {
  return ["show", `${sha}:${path}`];
}

export function mergeBaseArgs(a: string, b: string): string[] {
  return ["merge-base", a, b];
}

/** Recent subjects of the current branch, for a commit message in the repository's own style. */
export function recentSubjectsArgs(n = 10): string[] {
  return ["log", `--max-count=${n}`, "--no-merges", "--format=%s", "HEAD", "--"];
}

/** What a repository is in the middle of, from which of git's state files exist in its git dir. */
export type Operation = "merge" | "rebase" | "cherry-pick" | "revert";
export function operationOf(exists: (name: string) => boolean): Operation | undefined {
  if (exists("rebase-merge") || exists("rebase-apply")) return "rebase";
  if (exists("MERGE_HEAD")) return "merge";
  if (exists("CHERRY_PICK_HEAD")) return "cherry-pick";
  if (exists("REVERT_HEAD")) return "revert";
  return undefined;
}

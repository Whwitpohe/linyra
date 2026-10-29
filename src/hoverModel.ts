// The commit hover card's wording and the reads behind it. Pure: no DOM, no vscode.
import { kindCounts, lineTotals, totalFiles, type KindCounts } from "./changeKinds";
import { parseShow } from "./commitDetail";
import { localize } from "./i18n";
import { absoluteTime, relativeTime } from "./webview/view";

/** What one `git show` adds to the card: the whole message, and the files and lines it changed. */
export interface HoverDetail {
  message: string;
  kinds: KindCounts;
  files: number;
  added: number;
  deleted: number;
}

/**
 * Where the checked-out branch would be merged: its upstream remote's default branch (that
 * remote's symbolic HEAD), and how far the branch is from it. Read for the HEAD row only.
 */
export interface MergeTarget {
  /** "origin/main" */
  name: string;
  /** The checked-out branch it is the target of ("develop"). */
  branch: string;
  ahead: number;
  behind: number;
}

/** My commit: its email is the repository's user.email (case-insensitive, as mail addresses are). */
export function isMine(email: string, me: string | undefined): boolean {
  return !!me && me.trim().toLowerCase() === email.trim().toLowerCase();
}

/** "You" for my commits, as GitLens and the JetBrains Log say it; otherwise the author's name. */
export function authorLabel(author: string, mine: boolean): string {
  return mine ? localize("You") : author;
}

/** "3d ago (2026-09-20 12:00)": the row's relative time, and the moment it stands for. */
export function whenLabel(now: number, time: number, ago = relativeTime(now, time)): string {
  return `${ago} (${absoluteTime(time)})`;
}

const BODY_LINES = 24;
const BODY_CHARS = 2000;

/**
 * The message below its subject (the card shows the subject from the row at once): blank lines
 * at either end dropped, a long body cut to what a hover can hold, with an ellipsis.
 */
export function bodyOf(message: string): string {
  const lines = message.replace(/\r\n/g, "\n").split("\n");
  let rest = lines.slice(1);
  while (rest.length && !rest[0].trim()) rest = rest.slice(1);
  while (rest.length && !rest[rest.length - 1].trim()) rest = rest.slice(0, -1);
  let body = rest.slice(0, BODY_LINES).join("\n");
  const cut = rest.length > BODY_LINES || body.length > BODY_CHARS;
  if (body.length > BODY_CHARS) body = body.slice(0, BODY_CHARS);
  return cut ? `${body.trimEnd()}…` : body;
}

/** A commit's card detail from `git show` (commitDetail's showArgs). */
export function detailOf(stdout: string): HoverDetail {
  const { message, files } = parseShow(stdout);
  const kinds = kindCounts(files);
  const lines = lineTotals(files);
  return { message, kinds, files: totalFiles(kinds), added: lines.added, deleted: lines.deleted };
}

/** "1 file changed", "6 files changed". */
export function filesLabel(n: number): string {
  return n === 1 ? localize("1 file changed") : localize("{0} files changed", n);
}

/**
 * One for-each-ref for the merge target: the checked-out branch's upstream remote, and each
 * remote's symbolic HEAD (its default branch, as clone or `git remote set-head` left it).
 */
export function remoteHeadArgs(branch: string): string[] {
  return ["for-each-ref", "--format=%(refname)%00%(symref)%00%(upstream:remotename)", `refs/heads/${branch}`, "refs/remotes/*/HEAD"];
}

/** A ref the card may hand to rev-list: a remote branch, nothing an option or a range could hide in. */
const SAFE_REMOTE_REF = /^refs\/remotes\/[^\s\0~^:?*[\\]+$/;

/**
 * The full name of the merge target ("refs/remotes/origin/main"): the HEAD of the branch's
 * upstream remote; origin's (or the only remote's) when the branch has no upstream there.
 */
export function pickMergeTarget(stdout: string, branch: string): string | undefined {
  const heads = new Map<string, string>();
  let upstream: string | undefined;
  for (const line of stdout.split("\n")) {
    const [ref, symref, remote] = line.replace(/\r$/, "").split("\0");
    if (ref === `refs/heads/${branch}`) upstream = remote || undefined;
    const m = /^refs\/remotes\/(.+)\/HEAD$/.exec(ref ?? "");
    if (m && symref && SAFE_REMOTE_REF.test(symref) && !symref.includes("..")) heads.set(m[1], symref);
  }
  const remote = upstream && heads.has(upstream) ? upstream : heads.has("origin") ? "origin" : heads.size === 1 ? [...heads.keys()][0] : undefined;
  return remote ? heads.get(remote) : undefined;
}

/** Commits on each side: left, the commit and not the target (ahead); right, the target and not the commit (behind). */
export function countArgs(sha: string, target: string): string[] {
  return ["rev-list", "--left-right", "--count", `${sha}...${target}`, "--"];
}

export function parseCounts(stdout: string): { ahead: number; behind: number } | undefined {
  const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(stdout);
  return m ? { ahead: Number(m[1]), behind: Number(m[2]) } : undefined;
}

/** "refs/remotes/origin/main" → "origin/main". */
export const shortRemoteRef = (ref: string): string => ref.replace(/^refs\/remotes\//, "");

/** A branch is not merged into itself: main tracking origin/main has no merge target to show. */
export function showsMergeTarget(t: MergeTarget): boolean {
  const slash = t.name.indexOf("/");
  return slash < 0 || t.name.slice(slash + 1) !== t.branch;
}

/** "Merge target origin/main · 3 ahead · 1 behind" (the parts that are not zero). */
export function mergeTargetLabel(t: MergeTarget): string {
  const parts = [localize("Merge target {0}", t.name)];
  if (t.ahead) parts.push(localize("{0} ahead", t.ahead));
  if (t.behind) parts.push(localize("{0} behind", t.behind));
  if (!t.ahead && !t.behind) parts.push(localize("up to date"));
  return parts.join(" · ");
}

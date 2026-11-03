// Resolve Conflicts with AI: for each conflicted file, the common ancestor, ours and theirs from
// the index, and a proposed merge the user accepts file by file (or takes to the merge editor).
// Explain Conflicts: Compare's predicted conflicts, read-only. Pure: no vscode import.
import { localize } from "../../i18n";
import type { AiRequest } from "../types";
import { fenced, languageLine, type Limits, LIMITS } from "./context";
import type { Operation } from "./gitText";

export const MERGE_SYSTEM = `You resolve git merge conflicts in one file.
You get the common ancestor (base), "ours" and "theirs", and the file as git left it with conflict markers.

Rules:
- Produce the complete merged file: keep every change from both sides unless they truly contradict; then prefer the combination that keeps both intents working, and say so.
- Keep everything outside the conflicts exactly as it is in the file with markers: whitespace, line endings, ordering, comments.
- Never leave conflict markers (<<<<<<<, =======, >>>>>>>) in the result.
- Reply with the merged file inside one fenced block whose info string is "merged", fenced with the run of backticks the request names (longer than any in the file, so the file's own code fences stay inside the block), then one line starting with "Note:" saying what you chose where it was not obvious.`;

/** Who "ours" and "theirs" are depends on what git is doing: in a rebase, ours is the branch being rebased onto. */
export function sideLabels(op: Operation | undefined, head: string): { ours: string; theirs: string } {
  switch (op) {
    case "rebase": return { ours: `the branch being rebased onto (${head})`, theirs: "your commit being replayed" };
    case "cherry-pick": return { ours: `the current branch (${head})`, theirs: "the commit being cherry-picked" };
    case "revert": return { ours: `the current branch (${head})`, theirs: "the reverse of the commit being reverted" };
    default: return { ours: `the current branch (${head})`, theirs: "the branch being merged in" };
  }
}

export interface ConflictInput {
  repo: string;
  path: string;
  operation: Operation | undefined;
  head: string;
  /** undefined: the side has no such file (added on one side only, or deleted). */
  base: string | undefined;
  ours: string | undefined;
  theirs: string | undefined;
  current: string;
}

/** Too large to send whole: the user resolves it in the merge editor. */
export function conflictTooLarge(c: Pick<ConflictInput, "base" | "ours" | "theirs" | "current">, limits: Limits = LIMITS): boolean {
  return (c.base?.length ?? 0) + (c.ours?.length ?? 0) + (c.theirs?.length ?? 0) + c.current.length > limits.totalChars;
}

const version = (label: string, text: string | undefined) => `${label}:\n${text === undefined ? "(no such file on this side)" : fenced(text)}`;

/** A conflicted file's versions, as the answer is checked against them. */
export type MergeFile = { current: string; base?: string; ours?: string; theirs?: string };

/** The longest run of `mark` (a backtick or a tilde) in any of the file's versions. */
const longestRun = (mark: string, f: MergeFile): number =>
  Math.max(0, ...[f.base, f.ours, f.theirs, f.current].flatMap((t) => (t ?? "").split(mark === "`" ? /[^`]+/ : /[^~]+/).map((r) => r.length)));

/** The fence the merged file is asked in: longer than any run of backticks in its versions, so no line of the file can close it. */
export const mergeFence = (f: MergeFile): string => "`".repeat(Math.max(3, longestRun("`", f) + 1));

export function mergeRequest(c: ConflictInput, signal: AbortSignal, onText?: (delta: string) => void): AiRequest {
  const labels = sideLabels(c.operation, c.head);
  const fence = mergeFence(c);
  const content = [
    `Repository ${c.repo}, file \`${c.path}\`, during a ${c.operation ?? "merge"}.`,
    `"Ours" is ${labels.ours}; "theirs" is ${labels.theirs}.`,
    "",
    version("Base (common ancestor)", c.base),
    version("Ours", c.ours),
    version("Theirs", c.theirs),
    version("The file now, with conflict markers", c.current),
    "",
    `Reply with the merged file between a line ${fence}merged and a line ${fence}, then the Note line.`,
  ].join("\n");
  return { system: MERGE_SYSTEM, turns: [{ role: "user", content }], maxTokens: 32_000, signal, onText };
}

const MARKER = /^(<{7}|={7}|>{7})(\s|$)/m;
const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([\w-]*)/;

export type MergeAnswer = { ok: true; content: string; note: string } | { ok: false; reason: "noBlock" | "markers" | "changed" | "short" };

/**
 * The line that closes the block opened at `open` with `run`: the first fence at least as long
 * when no run in the file is as long (CommonMark's rule); otherwise the file's own fences look
 * the same, and the block ends at the last fence of its length before the answer's Note.
 */
function blockEnd(lines: readonly string[], open: number, run: string, f: MergeFile): number | undefined {
  const unique = run.length > longestRun(run[0], f);
  const closers: number[] = [];
  for (let i = open + 1; i < lines.length; i++) {
    const m = /^ {0,3}(`+|~+)[ \t]*$/.exec(lines[i]);
    if (!m || m[1][0] !== run[0] || m[1].length < run.length || (!unique && m[1].length !== run.length)) continue;
    if (unique) return i;
    closers.push(i);
  }
  let note = -1;
  for (let i = lines.length - 1; i > (closers[0] ?? lines.length); i--) if (/^Note:/.test(lines[i])) { note = i; break; }
  const before = closers.filter((i) => note < 0 || i < note);
  return (before.length ? before : closers).at(-1);
}

/** What lies outside the conflicts of a file with markers, each part as lines: before the first, between them, after the last. Undefined without (or with unbalanced) markers. */
export function outsideConflicts(current: string): string[][] | undefined {
  const parts: string[][] = [[]];
  let inside = false;
  for (const line of current.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^<{7}(\s|$)/.test(line)) {
      if (inside) return undefined;
      inside = true;
    } else if (/^>{7}(\s|$)/.test(line)) {
      if (!inside) return undefined;
      inside = false;
      parts.push([]);
    } else if (!inside) {
      parts[parts.length - 1].push(line);
    }
  }
  return inside || parts.length < 2 ? undefined : parts;
}

/**
 * Whether a proposal keeps the text outside the conflicts as the file has it (trailing spaces and
 * blank lines at the end aside): the start, each part between conflicts in order, and the end.
 */
function keepsOutside(content: string, current: string): boolean {
  const parts = outsideConflicts(current);
  if (!parts) return true;
  const trimEnd = (lines: string[]) => { const out = lines.map((l) => l.trimEnd()); while (out.length && out[out.length - 1] === "") out.pop(); return out; };
  const lines = trimEnd(content.replace(/\r\n?/g, "\n").split("\n"));
  const head = parts[0].map((l) => l.trimEnd()), tail = trimEnd(parts[parts.length - 1]);
  const at = (part: string[], i: number) => part.every((l, k) => lines[i + k] === l);
  if (!at(head, 0) || lines.length < head.length + tail.length || !at(tail, lines.length - tail.length)) return false;
  let pos = head.length;
  for (const part of parts.slice(1, -1).map((p) => p.map((l) => l.trimEnd()))) {
    if (part.every((l) => l === "")) continue;
    let found = -1;
    for (let i = pos; i + part.length <= lines.length - tail.length && found < 0; i++) if (at(part, i)) found = i;
    if (found < 0) return false;
    pos = found + part.length;
  }
  return true;
}

/**
 * The merged file from the answer: the "merged" block (or the only one), never one with conflict
 * markers left in it, one that drops or changes the text outside the conflicts (a block cut off
 * at a fence of the file's own), or one far shorter than both sides.
 */
export function parseMerge(answer: string, f: MergeFile): MergeAnswer {
  const lines = answer.replace(/\r\n?/g, "\n").split("\n");
  let open = lines.findIndex((l) => FENCE.exec(l)?.[2] === "merged");
  if (open < 0) {
    // No block named merged: the only block there is, if there is just one.
    const opens: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      const m = FENCE.exec(lines[i]);
      if (!m) continue;
      opens.push(i);
      i = blockEnd(lines, i, m[1], { current: "" }) ?? lines.length;
    }
    if (opens.length !== 1) return { ok: false, reason: "noBlock" };
    open = opens[0];
  }
  const end = blockEnd(lines, open, FENCE.exec(lines[open])![1], f);
  if (end === undefined) return { ok: false, reason: "noBlock" };
  const content = lines.slice(open + 1, end).join("\n");
  if (MARKER.test(content)) return { ok: false, reason: "markers" };
  const merged = matchEol(content, f.current);
  if (!keepsOutside(merged, f.current)) return { ok: false, reason: "changed" };
  if (f.ours !== undefined && f.theirs !== undefined && merged.length < Math.min(f.ours.length, f.theirs.length) / 2) return { ok: false, reason: "short" };
  const note = lines.slice(end + 1).find((l) => /^Note:/.test(l))?.replace(/^Note:\s*/, "").trim() ?? "";
  return { ok: true, content: merged, note };
}

/** Why there is no proposal, as the review step says it. */
export function mergeProblem(reason: Exclude<MergeAnswer, { ok: true }>["reason"]): string {
  switch (reason) {
    case "markers": return localize("the proposal still has conflict markers.");
    case "changed": return localize("the proposal leaves out or changes text outside the conflicts (cut off?). Resolve it in the merge editor.");
    case "short": return localize("the proposal is much shorter than either side (cut off?). Resolve it in the merge editor.");
    default: return localize("the answer had no merged file.");
  }
}

/** The proposal in the conflicted file's own line endings, ending in a newline when that file does. */
export function matchEol(content: string, sample: string): string {
  const crlf = sample.includes("\r\n");
  let out = content.replace(/\r\n/g, "\n");
  if (/\n$/.test(sample) && !out.endsWith("\n")) out += "\n";
  return crlf ? out.replace(/\n/g, "\r\n") : out;
}

export type ReviewChoice = "accept" | "editor" | "skip" | "stop";

export interface ReviewItem { id: ReviewChoice; label: string; description: string }

/**
 * One conflicted file's one decision, asked while the proposal and the file are side by side:
 * Accept and Stage, Open in Merge Editor, Skip, and Stop while other files are left. Without a
 * proposal (`reason` says why) there is nothing to accept. Esc is Skip: the run goes on.
 */
export function reviewStep(o: { repo: string; path: string; index: number; total: number; note?: string; reason?: string }): { title: string; placeHolder: string; items: ReviewItem[] } {
  const left = o.total - o.index;
  const items: ReviewItem[] = [];
  if (o.reason === undefined) items.push({ id: "accept", label: `$(check) ${localize("Accept and Stage")}`, description: localize("write the proposal to the file and git add it") });
  items.push(
    { id: "editor", label: `$(git-merge) ${localize("Open in Merge Editor")}`, description: localize("resolve it yourself") },
    { id: "skip", label: `$(arrow-right) ${localize("Skip")}`, description: localize("leave it conflicted (Esc)") },
  );
  if (left > 0) items.push({ id: "stop", label: `$(debug-stop) ${localize("Stop")}`, description: left === 1 ? localize("leave the last file for now") : localize("leave the other {0} files for now", left) });
  return {
    title: o.total > 1 ? localize("Resolve Conflicts with AI ({0} of {1}): {2} in {3}", o.index, o.total, o.path, o.repo) : localize("Resolve Conflicts with AI: {0} in {1}", o.path, o.repo),
    placeHolder: o.reason !== undefined ? localize("No proposal: {0}", o.reason)
      : o.note ? localize("The model says: {0}", o.note) : localize("The proposal is on the left, the file on the right."),
    items,
  };
}

/** The end of a run: how many files were staged, whether it stopped early, and that the operation is the user's to continue. */
export function resolveReport(o: { accepted: number; reviewed: number; total: number; operations: readonly (Operation | undefined)[] }): string {
  const ops = new Set(o.operations);
  const op = ops.size === 1 ? [...ops][0] : "several";
  const next = op === "rebase" ? localize("Continue the rebase in Source Control once every file is resolved.")
    : op === "cherry-pick" ? localize("Continue the cherry-pick in Source Control once every file is resolved.")
    : op === "revert" ? localize("Continue the revert in Source Control once every file is resolved.")
    : op === "several" ? localize("Continue each repository's operation in Source Control once every file is resolved.")
    : localize("Continue the merge in Source Control once every file is resolved.");
  const done = o.reviewed < o.total
    ? localize("Linyra AI: {0} of {1} conflicted files resolved and staged; stopped before the other {2}.", o.accepted, o.total, o.total - o.reviewed)
    : localize("Linyra AI: {0} of {1} conflicted files resolved and staged.", o.accepted, o.total);
  return `${done} ${next}`;
}

export const EXPLAIN_CONFLICTS_SYSTEM = `You explain predicted merge conflicts between two branches, without resolving them.
For each file: what each side changed in the conflicting area, why they collide, and the likely right way to merge them (which side to keep, or how to combine).
Markdown, a short section per file, plain words. Name the sides by their branch names.`;

export interface PredictedConflict {
  path: string;
  base: string | undefined;
  left: string | undefined;
  right: string | undefined;
}

export function explainConflictsRequest(repo: string, left: string, right: string, files: readonly PredictedConflict[], language: string, signal: AbortSignal, onText?: (delta: string) => void): AiRequest {
  const body = files.map((f) => [`### \`${f.path}\``, version("Base (merge base)", f.base), version(left, f.left), version(right, f.right)].join("\n")).join("\n\n");
  return {
    system: EXPLAIN_CONFLICTS_SYSTEM,
    turns: [{ role: "user", content: `Repository ${repo}: merging ${left} into ${right} would conflict in these files. Explain the conflicts.\n${languageLine(language)}\n\n${body}` }],
    signal, onText,
  };
}

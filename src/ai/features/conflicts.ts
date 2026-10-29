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
- Reply with the merged file inside one fenced block whose info string is "merged", then one line starting with "Note:" saying what you chose where it was not obvious.`;

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

export function mergeRequest(c: ConflictInput, signal: AbortSignal, onText?: (delta: string) => void): AiRequest {
  const labels = sideLabels(c.operation, c.head);
  const content = [
    `Repository ${c.repo}, file \`${c.path}\`, during a ${c.operation ?? "merge"}.`,
    `"Ours" is ${labels.ours}; "theirs" is ${labels.theirs}.`,
    "",
    version("Base (common ancestor)", c.base),
    version("Ours", c.ours),
    version("Theirs", c.theirs),
    version("The file now, with conflict markers", c.current),
  ].join("\n");
  return { system: MERGE_SYSTEM, turns: [{ role: "user", content }], maxTokens: 32_000, signal, onText };
}

const MARKER = /^(<{7}|={7}|>{7})(\s|$)/m;

export type MergeAnswer = { ok: true; content: string; note: string } | { ok: false; reason: "noBlock" | "markers" };

/** The merged file from the answer: the "merged" block (or the only one), never one with conflict markers left in it. */
export function parseMerge(answer: string, eolOf: string): MergeAnswer {
  const blocks = [...answer.matchAll(/^(`{3,})([\w-]*)[^\n]*\n([\s\S]*?)\n?\1[ \t]*$/gm)];
  const block = blocks.find((b) => b[2] === "merged") ?? (blocks.length === 1 ? blocks[0] : undefined);
  if (!block) return { ok: false, reason: "noBlock" };
  const content = block[3];
  if (MARKER.test(content)) return { ok: false, reason: "markers" };
  const note = /^Note:\s*(.*)$/m.exec(answer.slice((block.index ?? 0) + block[0].length))?.[1]?.trim() ?? "";
  return { ok: true, content: matchEol(content, eolOf), note };
}

/** The proposal in the conflicted file's own line endings, ending in a newline when that file does. */
export function matchEol(content: string, sample: string): string {
  const crlf = sample.includes("\r\n");
  let out = content.replace(/\r\n/g, "\n");
  if (/\n$/.test(sample) && !out.endsWith("\n")) out += "\n";
  return crlf ? out.replace(/\n/g, "\r\n") : out;
}

/** What Accept writes, in the confirmation: the file, and that it is staged; the merge goes on only when the user continues it. */
export function acceptPrompt(repo: string, path: string, op: Operation | undefined): { message: string; detail: string; button: string } {
  const what = op === "rebase" ? localize("The rebase is not continued") : op === "cherry-pick" ? localize("The cherry-pick is not continued")
    : op === "revert" ? localize("The revert is not continued") : localize("The merge is not continued");
  return {
    message: localize("Write the proposed merge to {0} in {1} and stage it?", path, repo),
    detail: localize("Linyra writes the file and runs git add on it. {0}: finish it in Source Control once every file is resolved.", what),
    button: localize("Accept and Stage"),
  };
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

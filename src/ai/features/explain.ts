// Explain: one or several commits, uncommitted work, unpushed commits, a branch against the
// current one. The answer is Markdown, streamed into a preview. Pure: no vscode import.
import type { AiRequest } from "../types";
import { fenced, languageLine, leftOutNote, type Budgeted } from "./context";
import type { RangeCommit } from "./gitText";

export const EXPLAIN_SYSTEM = `You explain changes in git repositories to a developer who works in them.
Linyra shows one merged log of several repositories, so a change may span repositories; each is named.

How to answer:
- Markdown. Start with a one-paragraph summary of what changed and why, as far as the diff and messages show.
- Then a short section per repository (when there are several) or per area of the code: what each change does, in plain words.
- Point out anything risky or surprising: behavior changes, removed checks, migrations, configuration, public API changes.
- Name files with their repository-relative paths in backticks. Do not repeat the diff. Do not invent intent the changes do not show.
- Some files' diffs are left out (excluded by the user's settings, binary or too large); say so only if it matters.
- Be brief: a reader should take it in within a minute.`;

export interface CommitInput {
  repo: string;
  sha: string;
  author: string;
  /** Unix seconds. */
  time: number;
  message: string;
  diffs: Budgeted;
}

const isoDate = (sec: number) => (sec > 0 ? new Date(sec * 1000).toISOString().slice(0, 10) : "");

function commitBlock(c: CommitInput): string {
  return [
    `### ${c.repo} ${c.sha.slice(0, 10)} — ${c.author}${c.time ? `, ${isoDate(c.time)}` : ""}`,
    fenced(c.message || "(no message)", "text"),
    ...(c.diffs.sections.length ? [fenced(c.diffs.sections.join(""), "diff")] : ["(no diff shown)"]),
    leftOutNote(c.diffs),
  ].filter(Boolean).join("\n");
}

/** Explain Commit: one commit, or several selected together (explained as one combined change). */
export function explainCommitsRequest(commits: readonly CommitInput[], language: string, signal: AbortSignal, onText?: (delta: string) => void): AiRequest {
  const ask = commits.length === 1 ? "Explain this commit." : `Explain these ${commits.length} commits as one combined change, oldest first in the story.`;
  return { system: EXPLAIN_SYSTEM, turns: [{ role: "user", content: [ask, languageLine(language), "", ...commits.map(commitBlock)].join("\n") }], signal, onText };
}

export interface WorkInput {
  repo: string;
  branch?: string;
  diffs: Budgeted;
}

function workBlock(w: WorkInput): string {
  return [`### ${w.repo}${w.branch ? ` (on ${w.branch})` : ""}`, ...(w.diffs.sections.length ? [fenced(w.diffs.sections.join(""), "diff")] : ["(no diff shown)"]), leftOutNote(w.diffs)].filter(Boolean).join("\n");
}

/** Explain Uncommitted Changes: the work of every repository given, against its last commit. */
export function explainWorkRequest(works: readonly WorkInput[], language: string, signal: AbortSignal, onText?: (delta: string) => void): AiRequest {
  const ask = works.length === 1 ? "Explain these uncommitted changes." : `Explain these uncommitted changes across ${works.length} repositories.`;
  return { system: EXPLAIN_SYSTEM, turns: [{ role: "user", content: [ask, languageLine(language), "", ...works.map(workBlock)].join("\n") }], signal, onText };
}

export interface RangeInput {
  repo: string;
  /** What the range is measured against ("origin/main", "the current branch develop"). */
  base: string;
  tip: string;
  commits: readonly RangeCommit[];
  /** More commits than listed. */
  more: boolean;
  diffs: Budgeted;
}

export function commitList(commits: readonly RangeCommit[], more: boolean): string {
  if (commits.length === 0) return "(no commits)";
  return commits.map((c) => `- ${c.sha} ${c.subject} (${c.author}${c.time ? `, ${isoDate(c.time)}` : ""})${c.body ? `\n  ${c.body.split("\n").filter(Boolean).slice(0, 6).join("\n  ")}` : ""}`).join("\n") + (more ? "\n- … (more, older)" : "");
}

function rangeBlock(r: RangeInput): string {
  return [`### ${r.repo}: ${r.tip} against ${r.base}`, "Commits:", commitList(r.commits, r.more), "Diff since they split:",
    ...(r.diffs.sections.length ? [fenced(r.diffs.sections.join(""), "diff")] : ["(no diff shown)"]), leftOutNote(r.diffs)].filter(Boolean).join("\n");
}

/** Explain Unpushed Commits (tip: the branch, base: its upstream) or Explain Branch (base: the current branch). */
export function explainRangeRequest(kind: "unpushed" | "branch", ranges: readonly RangeInput[], language: string, signal: AbortSignal, onText?: (delta: string) => void): AiRequest {
  const ask = kind === "unpushed"
    ? "Explain what these unpushed commits will bring to the remote when pushed."
    : "Explain what this branch did compared with the current branch: what merging it would bring.";
  return { system: EXPLAIN_SYSTEM, turns: [{ role: "user", content: [ask, languageLine(language), "", ...ranges.map(rangeBlock)].join("\n") }], signal, onText };
}

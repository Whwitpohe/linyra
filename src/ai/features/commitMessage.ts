// Generate Commit Message (the Commit side bar's ✨) and the stash message of Stash Changes…:
// one message for the checked files of every repository, in the repositories' own style.
// Pure: no vscode import.
import type { AiRequest } from "../types";
import { fenced, leftOutNote, stripFences, type Budgeted } from "./context";

export const COMMIT_SYSTEM = `You write git commit messages.
The changes may span several repositories: they are committed together with one message, so write one message that covers all of them.

Format:
- A subject line of at most 72 characters, in the imperative mood ("Add", "Fix", not "Added").
- If the subject alone does not explain the change, a blank line and a short body (wrapped at 72) saying what changed and why.
- Follow the style of the repository's recent subjects when they show one (for example "feat(api): …" conventional commits, a ticket prefix, or plain sentences). Never invent ticket numbers.
- Describe behavior, not file lists. No Markdown headings, no code fences, no quotes around the message, no sign-off lines.
Reply with the commit message only.`;

export interface CommitRepoInput {
  repo: string;
  branch?: string;
  /** The repository's latest subjects, newest first (its style). */
  recent: readonly string[];
  diffs: Budgeted;
}

export interface CommitMessageInput {
  repos: readonly CommitRepoInput[];
  /** linyra.ai.commitMessageInstructions: the user's own rules, which win over the defaults. */
  instructions: string;
  /** What the box held: kept as the user's hint when it is not empty. */
  draft: string;
}

export function commitMessageRequest(input: CommitMessageInput, signal: AbortSignal, onText?: (delta: string) => void): AiRequest {
  const parts: string[] = [];
  if (input.instructions.trim()) parts.push("The user's rules for commit messages (these win over the defaults):", fenced(input.instructions.trim(), "text"), "");
  if (input.draft.trim()) parts.push("The user started this message; keep its intent:", fenced(input.draft.trim(), "text"), "");
  for (const r of input.repos) {
    parts.push(`### ${r.repo}${r.branch ? ` (on ${r.branch})` : ""}`);
    if (r.recent.length) parts.push("Recent subjects:", r.recent.slice(0, 10).map((s) => `- ${s}`).join("\n"));
    parts.push(...(r.diffs.sections.length ? [fenced(r.diffs.sections.join(""), "diff")] : ["(no diff shown)"]));
    const note = leftOutNote(r.diffs);
    if (note) parts.push(note);
    parts.push("");
  }
  return { system: COMMIT_SYSTEM, turns: [{ role: "user", content: `Write the commit message for these changes.\n\n${parts.join("\n").trim()}` }], maxTokens: 600, signal, onText };
}

/**
 * The message as the box takes it, also while it streams: no fence, no quotes or "Commit
 * message:" label around it, no trailing spaces, at most one blank line in a row.
 */
export function cleanCommitMessage(text: string, final = true): string {
  let t = text.replace(/\r\n/g, "\n");
  // While streaming, an opening fence may have come without its closing one yet.
  t = final ? stripFences(t) : t.replace(/^\s*```[\w-]*\n?/, "").replace(/\n?```\s*$/, "");
  t = t.replace(/^\s*(?:\*\*)?(?:suggested )?commit message:?(?:\*\*)?\s*\n?/i, "");
  t = t.split("\n").map((l) => l.replace(/\s+$/, "")).join("\n").replace(/\n{3,}/g, "\n\n");
  t = final ? t.trim() : t.replace(/^\s+/, "");
  const quoted = /^(["'`])([\s\S]*)\1$/.exec(t);
  return final && quoted && !quoted[2].includes(quoted[1]) ? quoted[2].trim() : t;
}

export const STASH_SYSTEM = `You name git stashes.
Reply with one line of at most 60 characters saying what the uncommitted changes are about, in the imperative or as a short noun phrase ("WIP: retry the upload once", "Login form validation").
No quotes, no Markdown, nothing else.`;

export function stashMessageRequest(repo: string, branch: string | undefined, diffs: Budgeted, signal: AbortSignal, onText?: (delta: string) => void): AiRequest {
  const body = [`### ${repo}${branch ? ` (on ${branch})` : ""}`, ...(diffs.sections.length ? [fenced(diffs.sections.join(""), "diff")] : ["(no diff shown)"]), leftOutNote(diffs)].filter(Boolean).join("\n");
  return { system: STASH_SYSTEM, turns: [{ role: "user", content: `Name the stash of these changes.\n\n${body}` }], maxTokens: 100, signal, onText };
}

/** One line, at most 72 characters, no quotes. */
export function cleanStashMessage(text: string): string {
  const line = cleanCommitMessage(text).split("\n").find((l) => l.trim()) ?? "";
  const t = line.trim().replace(/^["'`]|["'`]$/g, "");
  return t.length > 72 ? `${t.slice(0, 71).trimEnd()}…` : t;
}

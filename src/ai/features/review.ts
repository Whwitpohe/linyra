// Review Changes: uncommitted work, a commit, or a branch against the current one, read by the
// model as a reviewer would. Findings come back as JSON and are shown most severe first, each
// with a link to its file and line. Pure: no vscode import.
import type { AiRequest } from "../types";
import { fenced, languageLine, leftOutNote, parseJsonObject, str, type Budgeted } from "./context";

export const REVIEW_SYSTEM = `You review code changes in git repositories, as a careful senior colleague would.
The changes may span several repositories; each is named.

Look for, in this order: bugs and wrong behavior, security problems (injection, secrets, unsafe input), data loss, race conditions and error handling, breaking API or configuration changes, missing tests for risky logic, then readability.
Do not report style nits a formatter would fix. Do not praise. Report only what the diff shows; if unsure, say so in the detail.

Line numbers: use the line in the NEW version of the file (count from the "+" side of the hunk header "@@ -a,b +c,d @@").
Reply with one JSON object only:
{"summary": "<one or two sentences>", "findings": [{"severity": "critical" | "high" | "medium" | "low" | "info", "repo": "<repository>", "file": "<path as in the diff>", "line": <number or 0>, "title": "<short>", "detail": "<what is wrong and how to fix it>"}]}`;

export interface ReviewInput {
  repo: string;
  /** What is reviewed, for the heading ("uncommitted changes", "commit abc1234", "feature/x against develop"). */
  what: string;
  diffs: Budgeted;
}

export function reviewRequest(inputs: readonly ReviewInput[], language: string, signal: AbortSignal): AiRequest {
  const body = inputs.map((r) => [`### ${r.repo}: ${r.what}`, ...(r.diffs.sections.length ? [fenced(r.diffs.sections.join(""), "diff")] : ["(no diff shown)"]), leftOutNote(r.diffs)].filter(Boolean).join("\n")).join("\n\n");
  return { system: REVIEW_SYSTEM, turns: [{ role: "user", content: `Review these changes.\n${languageLine(language)} (JSON keys and severity values stay in English.)\n\n${body}` }], json: true, maxTokens: 4000, signal };
}

export type Severity = "critical" | "high" | "medium" | "low" | "info";
export const SEVERITIES: readonly Severity[] = ["critical", "high", "medium", "low", "info"];
export interface Finding { severity: Severity; repo: string; file: string; line: number; title: string; detail: string }
export interface Review { summary: string; findings: Finding[] }

/**
 * The model's review: known severities (others count as info), files that were in the diff
 * (a finding on another file keeps its text, not its link), most severe first, then by file and line.
 */
export function parseReview(answer: string, inputs: readonly { repo: string; files: readonly string[] }[]): Review | undefined {
  const o = parseJsonObject(answer);
  if (!o) return undefined;
  const files = new Map(inputs.map((i) => [i.repo, new Set(i.files)]));
  const raw = Array.isArray(o.findings) ? o.findings as unknown[] : [];
  const findings = raw.flatMap((x): Finding[] => {
    if (!x || typeof x !== "object") return [];
    const f = x as Record<string, unknown>;
    const title = str(f.title).trim(), detail = str(f.detail).trim();
    if (!title && !detail) return [];
    const severity = SEVERITIES.find((s) => s === str(f.severity).toLowerCase()) ?? "info";
    let repo = str(f.repo);
    if (!files.has(repo)) repo = inputs.find((i) => i.files.includes(str(f.file)))?.repo ?? (inputs.length === 1 ? inputs[0].repo : "");
    const file = files.get(repo)?.has(str(f.file)) ? str(f.file) : "";
    const line = typeof f.line === "number" && Number.isInteger(f.line) && f.line > 0 && file ? f.line : 0;
    return [{ severity, repo, file, line, title: title || detail.split("\n")[0], detail: title ? detail : "" }];
  });
  findings.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || a.repo.localeCompare(b.repo) || a.file.localeCompare(b.file) || a.line - b.line);
  return { summary: str(o.summary).trim(), findings };
}

export interface ReviewWords {
  title: string;
  noFindings: string;
  severity: Record<Severity, string>;
}

/** Markdown: the summary, then a section per severity; each finding links to its file and line (`link` makes the URI). */
export function renderReview(review: Review, words: ReviewWords, link: (repo: string, file: string, line: number) => string | undefined): string {
  const parts = [`# ${words.title}`, ""];
  if (review.summary) parts.push(review.summary, "");
  if (review.findings.length === 0) parts.push(words.noFindings);
  for (const s of SEVERITIES) {
    const list = review.findings.filter((f) => f.severity === s);
    if (list.length === 0) continue;
    parts.push(`## ${words.severity[s]} (${list.length})`, "");
    for (const f of list) {
      const where = f.file ? `${f.repo ? `${f.repo}/` : ""}${f.file}${f.line ? `:${f.line}` : ""}` : f.repo;
      const target = f.file ? link(f.repo, f.file, f.line) : undefined;
      const place = where ? (target ? ` — [${escapeLink(where)}](${target})` : ` — \`${where}\``) : "";
      parts.push(`- **${escapeMd(f.title)}**${place}`);
      if (f.detail) parts.push(...f.detail.split("\n").map((l) => `  ${l}`));
    }
    parts.push("");
  }
  return `${parts.join("\n").trimEnd()}\n`;
}

const escapeMd = (s: string) => s.replace(/([*_`[\]])/g, "\\$1");
const escapeLink = (s: string) => s.replace(/([[\]])/g, "\\$1");

/** A file: URI with the line VS Code's Markdown preview opens it at. */
export function fileLink(root: string, file: string, line: number): string {
  const abs = `${root.replace(/\\/g, "/").replace(/\/$/, "")}/${file}`;
  const path = abs.startsWith("/") ? abs : `/${abs}`;
  return `file://${encodeURI(path).replace(/[?#]/g, encodeURIComponent)}${line > 0 ? `#L${line}` : ""}`;
}

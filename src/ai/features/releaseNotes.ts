// Changelog / release notes: from commits selected in the Log, or from Compare's commits only on
// ◀. The model groups and rewrites them (Features, Fixes, Other); the commits' messages are its
// only input. Pure: no vscode import.
import type { AiRequest } from "../types";
import { languageLine, parseJsonObject, str, strings } from "./context";
import { commitList } from "./explain";
import type { RangeCommit } from "./gitText";

export const NOTES_SYSTEM = `You write release notes from git commit messages.
The commits may come from several repositories; each is named.

Rules:
- Group every user-visible change into "feat" (new features and improvements), "fix" (bug fixes) or "other" (everything else worth a line: dependencies, performance, documentation).
- Merge commits that are one change into one line; leave out merge commits, version bumps and pure chores nobody using the software would notice.
- Each line is one short sentence for the people using the software, not the commit subject copied. No trailing period.
- Keep the short hashes and the repository of the commits a line comes from.
- Reply with one JSON object only: {"feat": [{"text": "…", "repo": "acme-web", "commits": ["abc1234"]}], "fix": [...], "other": [...]}.`;

export interface NotesSection {
  repo: string;
  /** Compare: the two sides ("release-1.4 → main"); the Log's selection: none. */
  range?: string;
  commits: readonly RangeCommit[];
}

export function notesRequest(sections: readonly NotesSection[], language: string, signal: AbortSignal): AiRequest {
  const body = sections.map((s) => `### ${s.repo}${s.range ? ` (${s.range})` : ""}\n${commitList(s.commits, false)}`).join("\n\n");
  return { system: NOTES_SYSTEM, turns: [{ role: "user", content: `Write release notes for these commits.\n${languageLine(language)}\n\n${body}` }], json: true, maxTokens: 2000, signal };
}

export type NotesGroup = "feat" | "fix" | "other";
export interface NoteLine { text: string; repo: string; commits: string[] }
export type Notes = Record<NotesGroup, NoteLine[]>;
export const GROUPS: readonly NotesGroup[] = ["feat", "fix", "other"];

/**
 * The model's notes, kept to what was asked: lines with text, hashes that were in the input,
 * repositories that were in it. Undefined when the answer is not the JSON asked for.
 */
export function parseNotes(answer: string, sections: readonly NotesSection[]): Notes | undefined {
  const o = parseJsonObject(answer);
  if (!o) return undefined;
  const repos = new Set(sections.map((s) => s.repo));
  const shas = new Set(sections.flatMap((s) => s.commits.map((c) => c.sha)));
  const notes: Notes = { feat: [], fix: [], other: [] };
  let any = false;
  for (const g of GROUPS) {
    const lines = Array.isArray(o[g]) ? o[g] as unknown[] : [];
    for (const raw of lines) {
      const l = (raw && typeof raw === "object" ? raw : { text: raw }) as Record<string, unknown>;
      const text = str(l.text).replace(/\s+/g, " ").trim().replace(/\.$/, "");
      if (!text) continue;
      const repo = repos.has(str(l.repo)) ? str(l.repo) : sections.length === 1 ? sections[0].repo : "";
      notes[g].push({ text, repo, commits: strings(l.commits).filter((s) => shas.has(s)) });
      any = true;
    }
  }
  return any ? notes : undefined;
}

/** Without the model's grouping (it answered no JSON): Conventional Commits prefixes decide, subjects as they are. */
export function fallbackNotes(sections: readonly NotesSection[]): Notes {
  const notes: Notes = { feat: [], fix: [], other: [] };
  for (const s of sections) {
    for (const c of s.commits) {
      if (/^merge\b/i.test(c.subject)) continue;
      const m = /^(\w+)(?:\([^)]*\))?!?:\s*(.*)$/.exec(c.subject);
      const group: NotesGroup = m && /^feat/i.test(m[1]) ? "feat" : m && /^fix/i.test(m[1]) ? "fix" : "other";
      notes[group].push({ text: (m ? m[2] : c.subject).trim() || c.subject, repo: s.repo, commits: [c.sha] });
    }
  }
  return notes;
}

/** Markdown: a heading per group that has lines, each line with its repository and hashes. */
export function renderNotes(notes: Notes, title: string, headings: Record<NotesGroup, string>): string {
  const parts = [`# ${title}`];
  for (const g of GROUPS) {
    if (notes[g].length === 0) continue;
    parts.push("", `## ${headings[g]}`, "", ...notes[g].map((l) => {
      const where = [l.repo, ...l.commits].filter(Boolean).join(" ");
      return `- ${l.text}${where ? ` (${where})` : ""}`;
    }));
  }
  return `${parts.join("\n")}\n`;
}

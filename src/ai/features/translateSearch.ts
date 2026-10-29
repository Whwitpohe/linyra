// AI Search: a question in plain words → the Log's search syntax (GitLens' operators, plus repo:).
// The model sees names only (repositories, authors, branches), never content. Pure: no vscode import.
import type { AiRequest } from "../types";
import { parseJsonObject, str } from "./context";

/** The operators the search box takes (plan §3.E), as the model is told them. */
const OPERATORS = `Operators (combine with spaces; several values of one operator mean "any of"; quote values with spaces):
- bare words or message:<text>   commit message contains the text (alias =:)
- -message:<text>                message does NOT contain the text (never together with message:)
- author:<name or email>         commit author (alias @:); author:@me is the current user
- committer:<name or email>      committer; committer:@me is the current user
- commit:<hash>                  one commit by its hash (alias #:)
- file:<path or glob>            commits touching the path (alias ?:); quote for an exact path; ** for any depth
- change:<text>                  commits adding or removing this text in a diff (alias ~:); slow, add a date too
- type:merge | type:tip | type:wip   merge commits, branch tips, uncommitted work (alias is:)
- after:<date> / before:<date>   since / until (aliases since: >: and until: <:); dates as 2026-10-01, 1.week.ago, yesterday
- ref:<branch, tag or a..b>      only history of that ref or range (alias ^:)
- repo:<repository name>         only that repository`;

export const SEARCH_SYSTEM = `You translate a question about git history into Linyra's search syntax.
Linyra shows one merged log of several git repositories. Its search box takes these operators:

${OPERATORS}

Rules:
- Use only the operators above. Use the names given as context exactly as written (repository, author, branch names).
- Leave out what the question does not ask for. Prefer the fewest operators that answer it.
- Dates: today is given; write absolute dates (YYYY-MM-DD) or git's relative forms (2.weeks.ago).
- "my" / "mine" / "I" means author:@me.
- Reply with one JSON object only: {"query": "<the search text>", "note": "<one short sentence on anything you could not express, or empty>"}.`;

export interface SearchNames {
  repos: readonly string[];
  authors: readonly string[];
  branches: readonly string[];
  /** Today, YYYY-MM-DD. */
  today: string;
}

const MAX_NAMES = 200;
const list = (names: readonly string[]) => (names.length ? names.slice(0, MAX_NAMES).join(", ") + (names.length > MAX_NAMES ? `, … (${names.length - MAX_NAMES} more)` : "") : "(none known)");

export function searchRequest(text: string, names: SearchNames, signal: AbortSignal): AiRequest {
  const context = [`Today: ${names.today}`, `Repositories: ${list(names.repos)}`, `Authors: ${list(names.authors)}`, `Branches: ${list(names.branches)}`].join("\n");
  return { system: SEARCH_SYSTEM, turns: [{ role: "user", content: `${context}\n\nQuestion: ${text.trim()}` }], json: true, maxTokens: 400, signal };
}

/** Operators the answer may use (aliases included); anything else that looks like one is dropped. */
const KNOWN = new Set(["message", "=", "-message", "author", "@", "committer", "commit", "#", "file", "?", "change", "~", "type", "is", "after", "since", ">", "before", "until", "<", "ref", "^", "repo"]);

/** The search text from the model's answer: one line, and only known operators (an unknown one stays as plain words). */
export function parseSearchAnswer(answer: string): { query: string; note: string } | undefined {
  const o = parseJsonObject(answer);
  let query = (o ? str(o.query) : answer.trim().split("\n")[0] ?? "").replace(/[\r\n]+/g, " ").trim();
  if (!query) return undefined;
  // "foo:bar" with an operator the box does not know would read as a message search for the whole token: keep only the value.
  query = query.replace(/(^|\s)(-?[A-Za-z]+|[=@#?~<>^]):(?=\S)/g, (m, space: string, op: string) => (KNOWN.has(op.toLowerCase()) ? `${space}${op.toLowerCase()}:` : space));
  return { query: query.replace(/\s+/g, " ").trim(), note: o ? str(o.note).trim() : "" };
}

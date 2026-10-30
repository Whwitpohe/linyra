// The Log's search language, after GitLens 19.5's: words, "quoted phrases" and operators such as
// author: or file:, each pushed down into `git log` as git's own flags (constraint 1: git does the
// searching, JavaScript only merges what it returns). Pure: no vscode, no DOM.
import { authorPatterns, escapeRegex, isValidRef, normalizePath, regexProblem, type FilterState } from "./filterModel";
import { localize } from "./i18n";
import type { Codicon } from "./webview/codicons";

export type SearchOperator =
  | "message:" | "-message:" | "author:" | "committer:" | "commit:" | "file:" | "change:"
  | "type:" | "after:" | "before:" | "ref:" | "repo:";

/** A line of help with examples: `text` has {0}, {1}… where each of `code` goes, drawn as code. */
export interface SearchExample {
  text: string;
  code: readonly string[];
}

export interface OperatorInfo {
  operator: SearchOperator;
  /** Other spellings, as GitLens has them (and sha:, Linyra's own before this language). */
  aliases: readonly string[];
  /** The suggestions list's second line: what the operator gets you, as GitLens has it. */
  description: () => string;
  /** The suggestions list's help line while the caret is in this operator's value. */
  example: () => SearchExample;
  /** The suggestions list's icon, GitLens's for the same operator. */
  icon: Codicon;
}

/** In the order the suggestions list shows them: GitLens's, then repo:, Linyra's own. */
export const OPERATORS: readonly OperatorInfo[] = [
  {
    operator: "message:", aliases: ["=:"], icon: "comment",
    description: () => localize("Search commit messages to quickly find specific changes or features"),
    example: () => ({ text: localize("Use quotes to search for phrases, e.g. {0} or {1}"), code: ['message:"add retry"', '=:"bug fix"'] }),
  },
  {
    operator: "-message:", aliases: [], icon: "comment",
    description: () => localize("Exclude commits whose message contains a term"),
    example: () => ({ text: localize("Use to filter out noisy commits, e.g. {0}. Cannot be combined with {1} in the same search"), code: ["-message:wip", "message:"] }),
  },
  {
    operator: "author:", aliases: ["@:"], icon: "person",
    description: () => localize("Filter by author to see contributions from specific team members"),
    example: () => ({ text: localize("Use a name or email, e.g. {0}, {1}, or {2} for your own commits"), code: ["author:dana", "@:rin", "@me"] }),
  },
  {
    operator: "committer:", aliases: [], icon: "person",
    description: () => localize("Filter by committer to see who applied specific changes"),
    example: () => ({ text: localize("Use a name or email, e.g. {0}, or {1} for commits you committed"), code: ["committer:dana", "@me"] }),
  },
  {
    operator: "commit:", aliases: ["#:", "sha:"], icon: "git-commit",
    description: () => localize("Jump to a specific commit using its SHA"),
    example: () => ({ text: localize("Use a full or short commit SHA, e.g. {0} or {1}"), code: ["commit:4ce3a", "#:4ce3a"] }),
  },
  {
    operator: "ref:", aliases: ["^:"], icon: "git-branch",
    description: () => localize("Filter to a specific branch or tag (solo), or compare ranges to see unique commits, in the repositories that have it"),
    example: () => ({ text: localize("Use a branch or tag, e.g. {0} or {1}, or a range to compare, e.g. {2} (commits in {3} but not in {4})"), code: ["ref:main", "^:v1.4.0", "ref:main..feature", "feature", "main"] }),
  },
  {
    operator: "type:", aliases: ["is:"], icon: "symbol-misc",
    description: () => localize("Filter by commit type — branch & tag tips, merges, or working tree changes"),
    example: () => ({ text: localize("Use {0} for branch and tag tips, {1} for merge commits, or {2} for uncommitted changes"), code: ["type:tip", "type:merge", "is:wip"] }),
  },
  {
    operator: "file:", aliases: ["?:"], icon: "file",
    description: () => localize("Track file changes across history (supports glob patterns)"),
    example: () => ({ text: localize("Use a path or file name, e.g. {0}, or a glob, e.g. {1}"), code: ["file:package.json", "?:src/**/*.ts"] }),
  },
  {
    operator: "change:", aliases: ["~:"], icon: "diff",
    description: () => localize("Search code changes to find when specific functions or patterns were modified"),
    example: () => ({ text: localize("Use a code snippet, e.g. {0}, or with Use Regular Expression on, a pattern such as {1}"), code: ['change:"function upload"', '~:"import.*React"'] }),
  },
  {
    operator: "after:", aliases: ["since:", ">:"], icon: "calendar",
    description: () => localize("Filter by date range using absolute dates or relative times"),
    example: () => ({ text: localize("Use a date, e.g. {0}, or a relative date, e.g. {1} or {2}"), code: ["after:2026-10-01", "since:3.weeks.ago", ">:1.month.ago"] }),
  },
  {
    operator: "before:", aliases: ["until:", "<:"], icon: "calendar",
    description: () => localize("Filter by date range using absolute dates or relative times"),
    example: () => ({ text: localize("Use a date, e.g. {0}, or a relative date, e.g. {1} or {2}"), code: ["before:2026-10-01", "until:3.weeks.ago", "<:1.month.ago"] }),
  },
  {
    operator: "repo:", aliases: [], icon: "repo",
    description: () => localize("Only these repositories (within the ticked ones)"),
    example: () => ({ text: localize("Use a repository name, with * for any characters, e.g. {0} or {1}"), code: ["repo:acme-web", "repo:acme-*"] }),
  },
];

/** Every spelling, longest first, so no spelling hides a longer one. Case-sensitive, as in GitLens. */
const SPELLINGS: readonly [string, SearchOperator][] = OPERATORS
  .flatMap((o): [string, SearchOperator][] => [[o.operator, o.operator], ...o.aliases.map((a): [string, SearchOperator] => [a, o.operator])])
  .sort((a, b) => b[0].length - a[0].length);

export const TYPE_VALUES = ["merge", "tip", "wip"] as const;

/** One word, phrase or operator with its value, as written. */
export interface SearchToken {
  /** [start, end) of the whole token in the text. */
  start: number;
  end: number;
  /** The canonical operator: "message:" for a plain word, "author:" for @me, "commit:" for a hash. */
  operator: SearchOperator;
  /** How the operator was written ("" for a plain word, "@:" for an alias). */
  spelling: string;
  /** Where the value starts; the value runs to `end`. */
  valueStart: number;
  /** The value as typed, quotes included. */
  raw: string;
  /** The value without its quotes. */
  value: string;
  /** A quoted value: a phrase, or an exact path. */
  quoted: boolean;
}

export interface SearchError {
  message: string;
  start: number;
  end: number;
}

export interface ParsedSearch {
  /** Each operator's values, unquoted, in order, without repeats. */
  operations: Map<SearchOperator, string[]>;
  errors: SearchError[];
  /** Every token, for highlighting and for the suggestions at the caret. */
  ranges: SearchToken[];
  /** Operators still waiting for their value ("author:" being typed): the query is not run yet. */
  pending: SearchToken[];
}

const HASH_WORD = /^[0-9a-f]{7,64}$/i;
const HASH_VALUE = /^[0-9a-f]{4,64}$/i;

function startsOperator(text: string, at: number): [string, SearchOperator] | undefined {
  return SPELLINGS.find(([s]) => text.startsWith(s, at));
}

function unquote(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  return raw.length > 1 && raw.endsWith('"') ? raw.slice(1, -1) : raw.slice(1);
}

/** The box's text → its tokens and each operator's values. Errors here need no toggles or repositories. */
export function parseSearch(text: string): ParsedSearch {
  const ranges: SearchToken[] = [];
  const n = text.length;
  // A quoted value runs to its closing quote (or the end, while it is being typed); any other to the next space.
  const readValue = (from: number): [string, number] => {
    if (text[from] === '"') {
      const close = text.indexOf('"', from + 1);
      const end = close < 0 ? n : close + 1;
      return [text.slice(from, end), end];
    }
    let end = from;
    while (end < n && !/\s/.test(text[end])) end++;
    return [text.slice(from, end), end];
  };
  let i = 0;
  while (i < n) {
    if (/\s/.test(text[i])) { i++; continue; }
    const start = i;
    const op = startsOperator(text, i);
    if (op) {
      let at = i + op[0].length;
      // "author: dana": one space may follow an operator, unless another operator starts after it.
      if (text[at] === " " && at + 1 < n && !/\s/.test(text[at + 1]) && !startsOperator(text, at + 1)) at++;
      const [raw, end] = readValue(at);
      ranges.push({ start, end: Math.max(end, i + op[0].length), operator: op[1], spelling: op[0], valueStart: at, raw, value: unquote(raw), quoted: raw.startsWith('"') });
      i = Math.max(end, i + op[0].length);
      continue;
    }
    const [raw, end] = readValue(i);
    const operator: SearchOperator = raw === "@me" ? "author:" : HASH_WORD.test(raw) ? "commit:" : "message:";
    ranges.push({ start, end, operator, spelling: "", valueStart: start, raw, value: unquote(raw), quoted: raw.startsWith('"') });
    i = end;
  }

  const operations = new Map<SearchOperator, string[]>();
  const pending: SearchToken[] = [];
  const errors: SearchError[] = [];
  for (const t of ranges) {
    if (t.raw === "") { pending.push(t); continue; }
    // "", author:"" and a lone @ are nothing to search for.
    let value = t.operator === "commit:" ? t.value.toLowerCase() : t.value;
    if ((t.operator === "author:" || t.operator === "committer:") && value !== "@me" && value.startsWith("@")) value = value.slice(1);
    if (value.trim() === "") continue;
    const list = operations.get(t.operator) ?? [];
    if (!list.includes(value)) list.push(value);
    operations.set(t.operator, list);
  }
  const first = (op: SearchOperator) => ranges.find((t) => t.operator === op && t.raw !== "");
  if (operations.has("message:") && operations.has("-message:")) {
    const t = first("-message:")!;
    errors.push({ message: localize("message: and -message: cannot be used together: git leaves out every message pattern once one is left out."), start: t.start, end: t.end });
  }
  return { operations, errors, ranges, pending };
}

/** What a file: value means as a pathspec. */
export interface FileTerm {
  /** exact: quoted; glob: has **; pattern: a path or wildcards, as typed; substring: a bare name. */
  kind: "exact" | "glob" | "pattern" | "substring";
  /** Normalized: forward slashes, no ./ or trailing /. */
  path: string;
  spec: string;
}

/** A file: value as a pathspec, by GitLens's rules; undefined when it could leave the repository. */
export function fileTerm(value: string, quoted: boolean, icase: boolean): FileTerm | undefined {
  const path = normalizePath(value);
  if (path === undefined) return undefined;
  if (quoted) return { kind: "exact", path, spec: `:(literal)${path}` };
  if (path.includes("**")) return { kind: "glob", path, spec: `:(glob${icase ? ",icase" : ""})${path}` };
  // As typed: "src/" is a folder, though tidied to "src".
  if (/[./\\*?|![\]{}]/.test(value)) return { kind: "pattern", path, spec: `${icase ? ":(icase)" : ""}${path}` };
  return { kind: "substring", path, spec: `${icase ? ":(icase)" : ""}*${path}*` };
}

/**
 * One file: term inside the Path box's folder or file (a literal path): a pathspec for the files that
 * match both, null when none can, "unsupported" when git's pathspecs cannot say it.
 */
export function fileWithin(t: FileTerm, base: string, icase: boolean): string | null | "unsupported" {
  const fold = (s: string) => (icase && t.kind !== "exact" ? s.toLowerCase() : s);
  const under = (p: string, dir: string) => fold(p) === fold(dir) || fold(p).startsWith(`${fold(dir)}/`);
  const magic = (glob: boolean) => (glob ? `:(glob${icase ? ",icase" : ""})` : icase ? ":(icase)" : "");
  if (t.kind === "substring") return fold(base).includes(fold(t.path)) ? `:(literal)${base}` : `${magic(false)}${base}/*${t.path}*`;
  const wild = t.kind === "exact" ? -1 : t.path.search(/[*?[]/);
  if (wild < 0) return under(t.path, base) ? t.spec : under(base, t.path) ? `:(literal)${base}` : null;
  // Leading wildcards match at any depth: inside the folder, they still do.
  if (wild === 0) return `${magic(t.kind === "glob")}${base}/${t.path}`;
  const literal = fold(t.path.slice(0, wild));
  if (literal.startsWith(`${fold(base)}/`)) return t.spec;
  return fold(base).startsWith(literal) ? "unsupported" : null;
}

const UNITS: Record<string, number> = { second: 1, minute: 60, hour: 3600, day: 86_400, week: 7 * 86_400 };

function localMidnight(unix: number, daysBack = 0): number {
  const d = new Date(unix * 1000);
  return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysBack).getTime() / 1000);
}

/**
 * An after:/before: value as unix seconds. A day (2026-10-01, today, yesterday) starts at local
 * midnight: after: includes it, before: ends just before it. Relative times (1.week.ago, 3 days ago,
 * 2.months.ago) count back from now. undefined when it is not one of these.
 */
export function searchDate(value: string, now: number, edge: "after" | "before"): number | undefined {
  const v = value.trim().toLowerCase();
  const day = (start: number | undefined) => (start === undefined ? undefined : edge === "after" ? start : start - 1);
  const ymd = /^(\d{4})-(\d{2})-(\d{2})(?:[ t](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(v);
  if (ymd) {
    const [y, m, d, hh, mm, ss] = ymd.slice(1).map((x) => (x === undefined ? undefined : Number(x)));
    const date = new Date(y!, m! - 1, d!, hh ?? 0, mm ?? 0, ss ?? 0);
    if (date.getFullYear() !== y || date.getMonth() !== m! - 1 || date.getDate() !== d) return undefined;
    const t = Math.floor(date.getTime() / 1000);
    return hh === undefined ? day(t) : t;
  }
  if (v === "now") return now;
  if (v === "today") return day(localMidnight(now));
  if (v === "yesterday") return day(localMidnight(now, 1));
  const rel = /^(\d+)[. ]?(second|minute|hour|day|week|month|year)s?(?:[. ]ago)?$/.exec(v);
  if (!rel) return undefined;
  const count = Number(rel[1]);
  if (UNITS[rel[2]] !== undefined) return now - count * UNITS[rel[2]];
  const d = new Date(now * 1000);
  if (rel[2] === "month") d.setMonth(d.getMonth() - count);
  else d.setFullYear(d.getFullYear() - count);
  return Math.floor(d.getTime() / 1000);
}

/** A ref: value: a branch, tag, hash or HEAD, with ~n/^n, or a range of them (a..b, a...b). */
export function isRefValue(value: string): boolean {
  const revision = (term: string) => {
    const base = term.replace(/(?:[~^]\d*)+$/, "");
    return HASH_VALUE.test(base) || isValidRef(base);
  };
  const range = /^(.*?)(\.\.\.?)(.*)$/.exec(value);
  if (!range) return value !== "" && revision(value);
  const [, a, , b] = range;
  return (a !== "" || b !== "") && (a === "" || revision(a)) && (b === "" || revision(b));
}

/** A repo: value against a repository name: ignoring case, with * for any characters. */
export function repoMatches(value: string, name: string): boolean {
  const pattern = value.split("*").map(escapeRegex).join(".*");
  return new RegExp(`^${pattern}$`, "i").test(name);
}

export type SearchToggles = Pick<FilterState, "matchCase" | "regex" | "wholeWord" | "matchAll">;

/** The query, resolved: what each repository's git log is asked. The same for every repository. */
export interface SearchPlan {
  errors: SearchError[];
  pending: SearchToken[];
  /** commit: values. A hash lookup ignores the rest of the query, as GitLens does. */
  hashes: string[];
  messages: string[];
  /** -message: values (git's --invert-grep). */
  excluded: string[];
  /** author: values; "@me" is each repository's own user.email. */
  authors: string[];
  committers: string[];
  change?: string;
  merges: boolean;
  tips: boolean;
  /** type:wip: the webview shows the Uncommitted side. */
  wip: boolean;
  since?: number;
  until?: number;
  /** ref: values, in place of the branches. */
  refs: string[];
  /** repo: values. */
  repos: string[];
  /** file: as pathspecs, inside the Path box when it is set; undefined without file:. */
  pathspecs?: string[];
}

export interface SearchContext {
  /** Known repository names: a repo: naming none of them is an error. */
  repoNames?: readonly string[];
}

/**
 * The box's text with the filter's toggles and Path box → the plan, with every error the box shows.
 * `now` fixes relative dates (the first page's, so paging does not drift).
 */
export function planSearch(f: Pick<FilterState, "text" | "path"> & SearchToggles, now: number, ctx: SearchContext = {}): SearchPlan {
  const parsed = parseSearch(f.text);
  const errors = [...parsed.errors];
  const icase = !f.matchCase;
  const tokens = (op: SearchOperator) => parsed.ranges.filter((t) => t.operator === op && t.raw !== "" && t.value.trim() !== "");
  const fail = (t: SearchToken, message: string) => errors.push({ message, start: t.start, end: t.end });
  const values = (op: SearchOperator) => parsed.operations.get(op) ?? [];

  if (f.regex) {
    for (const op of ["message:", "-message:", "author:", "committer:", "change:"] as const) {
      for (const t of tokens(op)) {
        const problem = t.value === "@me" ? undefined : regexProblem(t.value);
        if (problem) fail(t, localize("Invalid regular expression: {0}", problem));
      }
    }
  }
  for (const t of tokens("commit:")) if (!HASH_VALUE.test(t.value)) fail(t, localize("commit: takes a commit hash of 4 to 64 hexadecimal digits: {0}", t.value));
  const plan: SearchPlan = { errors, pending: parsed.pending, hashes: values("commit:").filter((v) => HASH_VALUE.test(v)),
    messages: values("message:"), excluded: values("-message:"), authors: values("author:"), committers: values("committer:"),
    merges: false, tips: false, wip: false, refs: [], repos: values("repo:") };

  const changes = tokens("change:");
  if (changes.length > 1) fail(changes[1], localize("Search for one change: at a time: git looks for one text per search."));
  plan.change = changes[0]?.value;

  for (const t of tokens("type:")) {
    const v = t.value.toLowerCase();
    if (v === "merge") plan.merges = true;
    else if (v === "tip") plan.tips = true;
    else if (v === "wip") plan.wip = true;
    else if (v === "stash") fail(t, localize("type:stash is not available: the Log does not list stashes."));
    else fail(t, localize("type: takes merge, tip or wip: {0}", t.value));
  }

  for (const [op, edge] of [["after:", "after"], ["before:", "before"]] as const) {
    for (const t of tokens(op)) {
      const at = searchDate(t.value, now, edge);
      if (at === undefined) fail(t, localize("Not a date: {0}. Use 2026-10-01, 1.week.ago or yesterday.", t.value));
      else if (edge === "after") plan.since = Math.max(plan.since ?? at, at);
      else plan.until = Math.min(plan.until ?? at, at);
    }
  }

  for (const t of tokens("ref:")) {
    if (isRefValue(t.value)) { if (!plan.refs.includes(t.value)) plan.refs.push(t.value); }
    else fail(t, localize("Not a branch, tag, commit or range: {0}", t.value));
  }

  if (ctx.repoNames) {
    for (const t of tokens("repo:")) {
      if (!ctx.repoNames.some((name) => repoMatches(t.value, name))) fail(t, localize("No repository is named {0}", t.value));
    }
  }

  const files = tokens("file:").flatMap((t) => {
    const term = fileTerm(t.value, t.quoted, icase);
    if (!term) fail(t, localize("{0}: file: paths are relative to each repository: no leading / or :, and no ..", t.value));
    return term ? [{ t, term }] : [];
  });
  if (files.length > 0) {
    const base = f.path === undefined ? undefined : normalizePath(f.path);
    if (base === undefined) plan.pathspecs = [...new Set(files.map((x) => x.term.spec))];
    else if (/[*?[]/.test(base)) fail(files[0].t, localize("file: cannot narrow a glob in the Path box. Clear one of them."));
    else {
      const specs = files.map((x) => ({ x, spec: fileWithin(x.term, base, icase) }));
      const unsupported = specs.find((s) => s.spec === "unsupported");
      const inside = [...new Set(specs.flatMap((s) => (s.spec && s.spec !== "unsupported" ? [s.spec] : [])))];
      if (unsupported) fail(unsupported.x.t, localize("file:{0} and the Path box ({1}) cannot be combined. Clear one of them.", unsupported.x.t.value, base));
      else if (inside.length === 0) fail(files[0].t, localize("file:{0} is outside the Path box ({1}).", files[0].t.value, base));
      else plan.pathspecs = inside;
    }
  }
  return plan;
}

/** The query in the box can run: nothing invalid, no operator waiting for its value. */
export function runnable(plan: Pick<SearchPlan, "errors" | "pending">): boolean {
  return plan.errors.length === 0 && plan.pending.length === 0;
}

/** author:@me or committer:@me: each repository's user.email is needed before its log. */
export function usesMe(text: string): boolean {
  const ops = parseSearch(text).operations;
  return !!ops.get("author:")?.includes("@me") || !!ops.get("committer:")?.includes("@me");
}

/** The ticked repositories narrowed by repo: (all of them without it). */
export function searchRepos<R extends { name: string }>(plan: Pick<SearchPlan, "repos">, repos: readonly R[]): R[] {
  return plan.repos.length === 0 ? [...repos] : repos.filter((r) => plan.repos.some((v) => repoMatches(v, r.name)));
}

/** Values with @me for this repository; [] when every value was @me and it has no user.email. */
function withMe(values: readonly string[], me: string | undefined): string[] {
  return values.flatMap((v) => (v !== "@me" ? [v] : me ? [me] : []));
}

/** author: or committer: values that only @me could have filled, in a repository with no user.email. */
export function searchSkips(plan: Pick<SearchPlan, "authors" | "committers">, me: string | undefined): boolean {
  return (plan.authors.length > 0 && withMe(plan.authors, me).length === 0) || (plan.committers.length > 0 && withMe(plan.committers, me).length === 0);
}

/**
 * A word's edges in POSIX extended expressions: \b is GNU's, and macOS' regex (git's there) has
 * none, so Whole Word found nothing on a Mac. These hold in glibc's, BSD's and git's own regex alike.
 */
const WORD_START = "(^|[^[:alnum:]_])";
const WORD_END = "([^[:alnum:]_]|$)";

/** Whole Word: a word's edge on each side that starts or ends with a word character (or around a whole expression). */
function wholeWord(pattern: string, raw: string, regex: boolean): string {
  if (regex) return `${WORD_START}(${pattern})${WORD_END}`;
  return `${/^\w/.test(raw) ? WORD_START : ""}${pattern}${/\w$/.test(raw) ? WORD_END : ""}`;
}

/** The same expression for JavaScript, which reads no POSIX classes (bothPattern's shortcut only). */
const forJs = (q: string): string => q.replaceAll("[^[:alnum:]_]", "[^\\p{L}\\p{N}_]");

/**
 * Expressions matching a line that contains both p and q, literally: one each for "p, then q", "q,
 * then p", and every way the two overlap; or the longer one alone when it contains the other.
 */
function bothLiteral(p: string, q: string, icase: boolean): string[] {
  const fold = (s: string) => (icase ? s.toLowerCase() : s);
  const P = fold(p);
  const Q = fold(q);
  if (P.includes(Q)) return [escapeRegex(p)];
  if (Q.includes(P)) return [escapeRegex(q)];
  const out = [`${escapeRegex(p)}.*${escapeRegex(q)}`, `${escapeRegex(q)}.*${escapeRegex(p)}`];
  for (let k = Math.min(p.length, q.length) - 1; k > 0; k--) {
    if (P.endsWith(Q.slice(0, k))) out.push(escapeRegex(p + q.slice(k)));
    if (Q.endsWith(P.slice(0, k))) out.push(escapeRegex(q + p.slice(k)));
  }
  return out;
}

/** The same for a literal p and an expression q: p alone when q matches inside it. */
function bothPattern(p: string, q: string, icase: boolean): string[] {
  try {
    const js = forJs(q);
    if (new RegExp(js, `${icase ? "i" : ""}${js !== q ? "u" : ""}`).test(p)) return [escapeRegex(p)];
  } catch {
    // git judges what JavaScript cannot read.
  }
  return [`${escapeRegex(p)}.*(${q})`, `(${q}).*${escapeRegex(p)}`];
}

/**
 * One repository's search flags for git log: messages, authors, committers, change: and type:,
 * then how git reads the patterns. `me` is that repository's user.email.
 *
 * The Author box (chips, typed name, Me) and author: must both hold, but git ORs --author flags:
 * each pair becomes expressions that need both in the author line, so git still does the matching.
 */
export function searchFlags(plan: SearchPlan, f: FilterState, me?: string): string[] {
  const regex = f.regex === true;
  const icase = !f.matchCase;
  const word = f.wholeWord === true;
  const picked = authorPatterns(f, me);
  const queryAuthors = withMe(plan.authors, me);
  const both = picked.length > 0 && queryAuthors.length > 0;
  const ere = regex || word || both;
  // An invalid expression (the box refuses it) is searched as text rather than failing every repository.
  const term = (v: string) => {
    const pattern = regex && regexProblem(v) === undefined ? v : ere ? escapeRegex(v) : v;
    return word ? wholeWord(pattern, v, regex && pattern === v) : pattern;
  };
  const grep = [...plan.messages, ...plan.excluded].map((v) => `--grep=${term(v)}`);
  const authors = both
    ? picked.flatMap((p) => queryAuthors.flatMap((q) => (!regex && !word ? bothLiteral(p, q, icase) : bothPattern(p, term(q), icase))))
    : picked.length > 0 ? picked.map((p) => (ere ? escapeRegex(p) : p)) : queryAuthors.map(term);
  const committers = withMe(plan.committers, me).map(term);

  const args: string[] = [];
  const patterns = grep.length + authors.length + committers.length > 0;
  if (icase && (patterns || plan.change !== undefined)) args.push("--regexp-ignore-case");
  if (patterns) args.push(ere ? "--extended-regexp" : "--fixed-strings");
  args.push(...grep);
  if (plan.messages.length > 1 && f.matchAll) args.push("--all-match");
  if (plan.excluded.length > 0 && plan.messages.length === 0) args.push("--invert-grep");
  args.push(...[...new Set(authors)].map((a) => `--author=${a}`));
  args.push(...committers.map((c) => `--committer=${c}`));
  if (plan.change !== undefined) {
    const c = plan.change;
    if (regex && regexProblem(c) === undefined) args.push(`-G${word ? wholeWord(c, c, true) : c}`);
    else if (word) args.push("--pickaxe-regex", `-S${wholeWord(escapeRegex(c), c, false)}`);
    else args.push(`-S${c}`);
  }
  if (plan.merges) args.push("--merges");
  if (plan.tips) args.push("--simplify-by-decoration");
  return args;
}

/** The query without type:wip (the Uncommitted side shows it; the rest still filters commits). */
export function withoutWip(text: string): string {
  const wip = parseSearch(text).ranges.filter((t) => t.operator === "type:" && t.value.toLowerCase() === "wip");
  let out = text;
  for (const t of [...wip].reverse()) out = out.slice(0, t.start) + out.slice(t.end);
  return out.replace(/\s{2,}/g, " ").trim();
}

/** What the suggestions list offers at the caret. */
export type Completion =
  /** A new or partly typed operator; [start, end) is replaced. */
  | { kind: "operator"; start: number; end: number; prefix: string }
  /** The value of an operator; [start, end) is replaced. */
  | { kind: "value"; operator: SearchOperator; start: number; end: number; prefix: string };

export function completionAt(text: string, caret: number): Completion | null {
  const ranges = parseSearch(text).ranges;
  const t = ranges.find((x) => caret >= x.start && caret <= x.end);
  if (!t) {
    // "author: |": the one space an operator may have before its value.
    const before = ranges.find((x) => x.raw === "" && x.end === caret - 1 && text[caret - 1] === " ");
    return before ? { kind: "value", operator: before.operator, start: caret, end: caret, prefix: "" } : { kind: "operator", start: caret, end: caret, prefix: "" };
  }
  if (t.spelling === "") {
    // A plain word being typed (or @me): it may be the start of an operator.
    if (t.quoted) return null;
    return { kind: "operator", start: t.start, end: t.end, prefix: text.slice(t.start, caret) };
  }
  if (caret < t.start + t.spelling.length) return { kind: "operator", start: t.start, end: t.start + t.spelling.length, prefix: text.slice(t.start, caret) };
  const prefix = unquote(text.slice(t.valueStart, Math.max(caret, t.valueStart)));
  return { kind: "value", operator: t.operator, start: t.valueStart, end: t.end, prefix };
}

/** Operators whose name or an alias starts with what is typed (all of them for nothing typed). */
export function operatorsFor(prefix: string): OperatorInfo[] {
  const p = prefix.toLowerCase();
  return OPERATORS.filter((o) => [o.operator, ...o.aliases].some((s) => s.startsWith(p)));
}

/** A value as the box writes it: quoted when it has a space or a quote. */
export function quoteValue(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, "")}"` : value;
}

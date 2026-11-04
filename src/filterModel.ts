import { HISTORY_FORMAT, LOG_FORMAT, startedRecords } from "./gitLog";
import { localize } from "./i18n";
import { parseSearch, planSearch, searchFlags, type SearchPlan } from "./searchQuery";
import { isSha, type Repo } from "./types";

export type DatePreset = "24h" | "7d" | "30d" | "all" | "custom";

export interface FilterState {
  /** The search box's query: words, a hash, or operators such as author: and file: (searchQuery.ts). */
  text: string;
  /** Matched against "Name <email>" by git's --author; "" = anyone. */
  author: string;
  /** "Me": each repository's own user.email, one more author beside the others. */
  mine: boolean;
  /**
   * Authors picked as chips (0.2.0). A commit by any of them, by the typed `author`, or by
   * Me matches: git combines several --author flags as "any of". Absent = none.
   */
  authors?: string[];
  /**
   * Only commits that touched this path, relative to each repository's root (0.2.0): a
   * file, a folder (everything inside it) or a glob. Absent = anywhere.
   */
  path?: string;
  /** Legacy single selection; "" with no branches means all local and remote branches. */
  branch: string;
  /** Multiple selected branches. An empty selection means all branches. */
  branches?: string[];
  /** Date order by default; topology groups incoming histories below their merges. */
  sort?: "date" | "topo";
  /** The message search (and author patterns) match case exactly; absent = ignore case. */
  matchCase?: boolean;
  /** The message search is an extended regular expression; absent = literal text. */
  regex?: boolean;
  /** Whole Word: search terms match whole words only (\b…\b). */
  wholeWord?: boolean;
  /** Match All: a commit must match every message term (git's --all-match), not any of them. */
  matchAll?: boolean;
  /** null = every repository; [] = none. */
  repoIds: string[] | null;
  date: DatePreset;
  /** YYYY-MM-DD, local days, only meaningful when date === "custom". */
  from?: string;
  to?: string;
}

/**
 * Where the next page for one repository starts: a position in git's own walk
 * order. Never a date — git emits a child before its parents, so a commit with
 * a backwards clock would make a date cursor skip real history.
 */
export interface RepoCursor {
  skip: number;
}

export const DEFAULT_FILTER: FilterState = { text: "", author: "", mine: false, branch: "", repoIds: null, date: "24h" };

/**
 * The query's first commit: hash (a bare word of 7 to 64 hex digits, or commit:, #: or sha: with 4
 * or more). Ordinary words such as "face" remain message searches.
 */
export function hashQuery(text: string): string | undefined {
  return parseSearch(text).operations.get("commit:")?.find((v) => /^[0-9a-f]{4,64}$/.test(v));
}

const PRESETS: readonly DatePreset[] = ["24h", "7d", "30d", "all", "custom"];
const PRESET_SECONDS = { "24h": 86_400, "7d": 7 * 86_400, "30d": 30 * 86_400 } as const;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** ISO-8601 UTC. git reads this exactly; it does NOT read `@<unix>` in --since/--until. */
export function gitDate(unix: number): string {
  return new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function localDay(day: string | undefined, time: "00:00:00" | "23:59:59"): number | undefined {
  if (!day || !DAY.test(day)) return undefined;
  const ms = new Date(`${day}T${time}`).getTime();
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

export function sinceOf(f: FilterState, now: number): number | undefined {
  if (f.date === "all") return undefined;
  if (f.date === "custom") return localDay(f.from, "00:00:00");
  return now - PRESET_SECONDS[f.date];
}

export function untilOf(f: FilterState): number | undefined {
  return f.date === "custom" ? localDay(f.to, "23:59:59") : undefined;
}

/**
 * git's ref-name rules (git check-ref-format), so any real branch is accepted —
 * "feature@x", "fix/#12", "fix/ü" — while options and revision syntax are not.
 * The ref is also passed after --end-of-options and before --.
 */
export function isValidRef(ref: string): boolean {
  if (!ref || ref === "@" || ref.startsWith("-") || ref.startsWith("/") || ref.endsWith("/") || ref.endsWith(".")) return false;
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(ref) || ref.includes("..") || ref.includes("@{") || ref.includes("//")) return false;
  return ref.split("/").every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"));
}

export const MAX_BRANCHES = 100;

/** Explicit array wins over an older saved single branch, including an empty array. */
export function selectedBranches(f: Pick<FilterState, "branch" | "branches">): string[] {
  const raw = Array.isArray(f.branches) ? f.branches : f.branch ? [f.branch] : [];
  return [...new Set(raw.filter((b) => typeof b === "string" && isValidRef(b)))].slice(0, MAX_BRANCHES);
}

function revisionArgs(refs: readonly string[]): string[] {
  return refs.length ? ["--end-of-options", ...refs] : ["--branches", "--remotes", "HEAD"];
}

interface ArgOptions {
  pageSize: number;
  now: number;
  cursor?: RepoCursor;
  /** This repository's user.email, for "Me". */
  me?: string;
  /** Resolved revisions to walk; absent = the filter's selection or all branches. */
  ref?: string;
  refs?: readonly string[];
  /** The search box's query, resolved once per page (planSearch); absent = resolved here. */
  search?: SearchPlan;
}

function buildArgs(format: string, f: FilterState, o: ArgOptions, extra: readonly string[], paths: readonly string[] = [], revisions = true): string[] {
  const args = ["log", format, `--max-count=${o.pageSize}`, "--decorate=full"];
  if (f.sort === "topo") args.push("--topo-order");
  // The query's messages, authors (with the Author box's), committers, change: and type:, as git's
  // own flags; after: and before: narrow the date range further.
  const search = o.search ?? planSearch(f, o.now);
  args.push(...searchFlags(search, f, o.me));
  const since = latest(sinceOf(f, o.now), search.since);
  if (since !== undefined) args.push(`--since=${gitDate(since)}`);
  const until = earliest(untilOf(f), search.until);
  if (until !== undefined) args.push(`--until=${gitDate(until)}`);
  if (o.cursor && o.cursor.skip > 0) args.push(`--skip=${o.cursor.skip}`);
  args.push(...extra);
  // After --end-of-options: revisions, never options. After --: paths, never
  // revisions, so a branch named like a folder ("docs") is not ambiguous.
  if (revisions) args.push(...revisionArgs(o.refs ?? (o.ref ? [o.ref] : selectedBranches(f))));
  args.push("--", ...paths);
  return args;
}

/** A literal string as a POSIX extended regular expression. */
export function escapeRegex(text: string): string {
  return text.replace(/[.[\]()*+?{}|^$\\]/g, "\\$&");
}

/**
 * The platform git runs on, read where this module runs beside it (the extension host). A webview
 * has no process: the host tells it (SearchContext.platform), and until then \b is let through.
 */
const HOST_PLATFORM: NodeJS.Platform | undefined = typeof process === "undefined" ? undefined : process.platform;

/**
 * Why a search box expression cannot be sent to git in regex mode; undefined when it can. The box
 * reads JavaScript's syntax (its parser checks it), and git's POSIX expressions must say the same
 * (toEre).
 */
export function regexProblem(text: string, platform: NodeJS.Platform | undefined = HOST_PLATFORM): string | undefined {
  try {
    new RegExp(text);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  const ere = toEre(text, platform);
  return "problem" in ere ? ere.problem : undefined;
}

/** A search box expression as git reads it (toEre); one regexProblem refuses is searched as text. */
export function gitRegex(text: string, platform: NodeJS.Platform | undefined = HOST_PLATFORM): string {
  const ere = toEre(text, platform);
  return "pattern" in ere ? ere.pattern : escapeRegex(text);
}

/** JavaScript's class escapes in POSIX's words: on their own, and inside a bracket expression. */
const CLASSES: Record<string, string> = { d: "[0-9]", D: "[^0-9]", s: "[[:space:]]", S: "[^[:space:]]", w: "[[:alnum:]_]", W: "[^[:alnum:]_]" };
const CLASS_ITEMS: Record<string, string> = { d: "0-9", s: "[:space:]", w: "[:alnum:]_" };
const POSIX_CLASSES = new Set(["alnum", "alpha", "blank", "cntrl", "digit", "graph", "lower", "print", "punct", "space", "upper", "xdigit"]);
/** RE_DUP_MAX on macOS, the least every POSIX regex takes (glibc's is higher). */
const MAX_REPEAT = 255;

type Ere = { pattern: string; end: number } | { problem: string };

const jsOnly = (what: string): Ere => ({ problem: localize("JavaScript's {0} is not in git's regular expressions", what) });

/**
 * A search box expression (JavaScript's syntax) as a POSIX extended expression that glibc, macOS
 * and Git for Windows read alike. glibc reads \d as d, so \d \s \w and \D \S \W become bracket
 * expressions; an escaped punctuation character and a { that is no quantifier become literal; a
 * [...] class is rebuilt by POSIX's rules, where a backslash is a character. What git's expressions
 * cannot say is a problem, rather than an error from every repository or a search that silently
 * finds nothing: (?...) groups and lookaround, lazy quantifiers, back-references and other letter
 * escapes. \b and \B stay as written where git reads them (glibc, Git for Windows); macOS' expressions
 * have neither and would find nothing, so there they are a problem.
 */
function toEre(text: string, platform: NodeJS.Platform | undefined): Ere {
  let out = "";
  // What came last can take a quantifier: a { after it is one, if it reads as one.
  let atom = false;
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (c === "\\") {
      const d = text[i + 1] ?? "";
      if (d === "b" || d === "B") {
        if (platform === "darwin") return { problem: localize("{0} is not in git's regular expressions on macOS: use Match Whole Word", `\\${d}`) };
        // A word's edge takes no quantifier: a { after it is a character.
        out += `\\${d}`;
        i += 2;
        atom = false;
        continue;
      }
      if (CLASSES[d]) out += CLASSES[d];
      else if (/[0-9A-Za-z]/.test(d)) return jsOnly(`\\${d}`);
      else out += escapeRegex(d);
      i += 2;
      atom = true;
      continue;
    }
    if (c === "[") {
      const bracket = bracketToEre(text, i);
      if ("problem" in bracket) return bracket;
      out += bracket.pattern;
      i = bracket.end;
      atom = true;
      continue;
    }
    if (c === "(" && text[i + 1] === "?") return jsOnly(text.slice(i, text[i + 2] === "<" && "=!".includes(text[i + 3] ?? "") ? i + 4 : i + 3));
    const interval = c === "{" && atom ? /^\{(\d+)(?:,(\d*))?\}/.exec(text.slice(i)) : null;
    if (c === "*" || c === "+" || c === "?" || interval) {
      const q = interval ? interval[0] : c;
      if (interval && Math.max(Number(interval[1]), Number(interval[2] || 0)) > MAX_REPEAT) return { problem: localize("git repeats at most 255 times: {0}", q) };
      if (text[i + q.length] === "?") return jsOnly(`${q}?`);
      out += q;
      i += q.length;
      atom = false;
      continue;
    }
    out += c === "{" || c === "}" ? `\\${c}` : c;
    atom = c !== "(" && c !== "|" && c !== "^" && c !== "$";
    i++;
  }
  return { pattern: out, end: text.length };
}

/**
 * A JavaScript class from the [ at `start` as a POSIX bracket expression: ] first, then the
 * characters, ranges and classes, then [, ^ and - where they are characters too.
 */
function bracketToEre(text: string, start: number): Ere {
  let i = start + 1;
  const negate = text[i] === "^";
  if (negate) i++;
  // JavaScript: [] matches nothing and [^] anything; to git, [] and [^] open a class holding ].
  if (text[i] === "]") return jsOnly(negate ? "[^]" : "[]");
  const chars = new Set<string>();
  const parts: string[] = [];
  const member = (): { char: string } | { item: string } | { problem: string } | undefined => {
    const c = text[i];
    if (c === undefined || c === "]") return undefined;
    if (c === "\\") {
      const d = text[i + 1] ?? "";
      i += 2;
      if (CLASS_ITEMS[d]) return { item: CLASS_ITEMS[d] };
      // \D \S \W have no form inside a bracket expression; \b is a backspace there.
      if (/[0-9A-Za-z]/.test(d)) return { problem: localize("JavaScript's {0} is not in git's regular expressions", `[\\${d}]`) };
      return { char: d };
    }
    // A POSIX class typed as one ([[:alpha:]]) is one: JavaScript would read [, :, a… and a ].
    const posix = /^\[:([a-z]+):\]/.exec(text.slice(i));
    if (posix && POSIX_CLASSES.has(posix[1])) {
      i += posix[0].length;
      return { item: posix[0] };
    }
    i++;
    return { char: c };
  };
  for (let m = member(); m; m = member()) {
    if ("problem" in m) return m;
    if ("item" in m) {
      parts.push(m.item);
      continue;
    }
    // A range: a character, -, a character. Next to a class, JavaScript reads the - as itself.
    if (text[i] === "-" && text[i + 1] !== "]" && text[i + 1] !== undefined) {
      i++;
      const to = member();
      if (to && "problem" in to) return to;
      if (to && "char" in to) {
        // Ends that POSIX reads by their place in the class: write those as characters.
        if (`${m.char}${to.char}`.split("").some((x) => "[]^-".includes(x))) return jsOnly(`${m.char}-${to.char}`);
        parts.push(`${m.char}-${to.char}`);
        continue;
      }
      chars.add("-");
      if (to) parts.push(to.item);
    }
    chars.add(m.char);
  }
  if (text[i] !== "]") return { problem: "Unterminated character class" };
  const take = (c: string) => chars.delete(c);
  const [close, open, caret, dash] = [take("]"), take("["), take("^"), take("-")];
  // [ last but for ^ and -, so it never starts [: [. or [=; ^ never first unless it negates.
  const lead = `${close ? "]" : ""}${[...chars].join("")}${parts.join("")}${open ? "[" : ""}`;
  if (!lead && caret && !dash) return { pattern: negate ? "[^^]" : "\\^", end: i + 1 };
  const body = lead ? `${lead}${caret ? "^" : ""}${dash ? "-" : ""}` : `${dash ? "-" : ""}${caret ? "^" : ""}`;
  return { pattern: `[${negate ? "^" : ""}${body}]`, end: i + 1 };
}

const latest = (a: number | undefined, b: number | undefined) => (a === undefined ? b : b === undefined ? a : Math.max(a, b));
const earliest = (a: number | undefined, b: number | undefined) => (a === undefined ? b : b === undefined ? a : Math.min(a, b));

/**
 * The Log's git log for one repository. file: replaces the Path box's pathspec with the files that
 * match both; ref: walks its revisions instead of the branches, and --ignore-missing lets a
 * repository without one skip it (one without any lists nothing) at no extra git process.
 */
export function logArgs(f: FilterState, o: ArgOptions): string[] {
  const search = o.search ?? planSearch(f, o.now);
  const path = f.path === undefined ? undefined : normalizePath(f.path);
  const paths = search.pathspecs ?? (path ? [pathspecOf(path)] : []);
  if (search.refs.length === 0) return buildArgs(LOG_FORMAT, f, { ...o, search }, [], paths);
  return buildArgs(LOG_FORMAT, f, { ...o, search, refs: search.refs }, ["--ignore-missing"], paths);
}

/**
 * A path filter as typed, made safe for a pathspec: trimmed, forward slashes, no leading
 * `./` or trailing `/`. undefined when it could leave the repository (absolute, `..`) or
 * switch on other pathspec magic (a leading `:`), or holds control characters.
 */
export function normalizePath(raw: string): string | undefined {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(raw)) return undefined;
  const p = raw.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  if (p === "" || p.startsWith("/") || p.startsWith(":") || /^[A-Za-z]:/.test(p)) return undefined;
  if (p.split("/").some((seg) => seg === "..")) return undefined;
  return p;
}

/** The pathspec for a normalized path: literal, or git's glob magic when it has glob characters. */
export function pathspecOf(path: string): string {
  if (!/[*?[]/.test(path)) return `:(literal)${path}`;
  // A glob without a folder ("*.ts") matches at any depth, like .gitignore and plain
  // git log -- '*.ts'; under :(glob) it would only match at the root.
  return path.includes("/") ? `:(glob)${path}` : `:(glob)**/${path}`;
}

/**
 * One file's history with the Log's filters: the commits the --follow walks found
 * (historyPathsArgs), given on stdin (historyInput) with --no-walk, so the filters choose among
 * exactly those and a later file that reused an old name stays out. Every name the file has had
 * is a pathspec, so each commit shows its change. No --follow here: it cannot page with --skip,
 * and it stops following when the rename commit itself is filtered out. --no-walk comes after
 * --max-count, which turns walking back on; it sorts by date unless the walk's own order is kept.
 *
 * --raw gives each row its status letter (and a rename's old name), --numstat its lines added
 * and deleted, in the same process. The line counts cost git a diff of the file per commit:
 * measured 2026-10-29 (Windows, git 2.55, a page of 200), +12–37 ms on real files with 60–140
 * commits, +100 ms (46 → 146 ms) on a 1,500-line file with 5,000 commits.
 */
export function historyArgs(f: FilterState, o: ArgOptions & { paths: readonly string[]; walkOrder?: boolean }): string[] {
  const commits = [`--no-walk=${o.walkOrder ? "unsorted" : "sorted"}`, "--stdin"];
  // Literal: a route folder like app/[id]/ is a name, not a glob matching app/i/.
  return buildArgs(HISTORY_FORMAT, f, o, ["--raw", "--numstat", "-z", "-M", ...commits], o.paths.map((p) => `:(literal)${p}`), false);
}

/** historyArgs' stdin: the commits the --follow walks found, one per line. */
export function historyInput(follow: Pick<FileFollow, "commits">): string {
  return [...follow.commits.keys()].map((sha) => `${sha}\n`).join("");
}

/**
 * Unfiltered, unpaged --follow walk: each commit git lists for the file, with its name there. In
 * the Log's order, which decides where git switches to an older name.
 */
export function historyPathsArgs(path: string, ref?: string | readonly string[], topo = false): string[] {
  return ["log", "--follow", "--name-status", "-z", "-M", "--format=%x1e%H", ...(topo ? ["--topo-order"] : []),
    ...revisionArgs(typeof ref === "string" ? [ref] : ref ?? []), "--", `:(literal)${path}`];
}

/** What one --follow walk found. */
export interface FollowWalk {
  /** The file's names, newest first; always starts with its current path. */
  names: string[];
  /** Each commit the walk lists, in its order, with the file's name in it. */
  commits: Map<string, string>;
  /** The walk went back through a rename (or copy). */
  renamed: boolean;
}

/** A file's history to page through: what its --follow walks found, together. */
export interface FileFollow {
  names: string[];
  /** A commit two walks list keeps the first one's name. */
  commits: Map<string, string>;
  /** One --topo-order walk: git keeps its order (--no-walk=unsorted); otherwise git sorts by date. */
  walkOrder: boolean;
}

/** A --follow walk's output (historyPathsArgs): RS, the hash and NUL, then one change of the file. */
export function parseFollow(stdout: string, path: string): FollowWalk {
  const walk: FollowWalk = { names: [path], commits: new Map(), renamed: false };
  const add = (p: string) => {
    if (!walk.names.includes(p)) walk.names.push(p);
  };
  for (const record of startedRecords(stdout)) {
    const [sha, status, first, second] = record.split("\0");
    const m = /^\n*([AMDRCT])\d*$/.exec(status ?? "");
    if (!isSha(sha) || !m) continue;
    const two = m[1] === "R" || m[1] === "C";
    const name = two ? second : first;
    if (!name || (two && !first)) continue; // cut off by a killed process
    walk.commits.set(sha, name);
    if (two) {
      add(first);
      walk.renamed = true;
    }
    add(name);
  }
  return walk;
}

/** Several tips' walks as one history; `topo`: the walks ran in topological order. */
export function followUnion(walks: readonly FollowWalk[], path: string, topo: boolean): FileFollow {
  const follow: FileFollow = { names: [path], commits: new Map(), walkOrder: topo && walks.length === 1 };
  for (const walk of walks) {
    for (const name of walk.names) if (!follow.names.includes(name)) follow.names.push(name);
    for (const [sha, name] of walk.commits) if (!follow.commits.has(sha)) follow.commits.set(sha, name);
  }
  return follow;
}

export const MAX_AUTHORS = 20;

/**
 * Me as git's author and committer lines name it ("Name <email>"): the whole address in its angle
 * brackets, so dan@example.com is not jordan@example.com or dan@example.com.au.
 */
export function meAuthor(email: string): string {
  return `<${email.trim()}>`;
}

/**
 * Every author pattern for one repository: the chips, what is being typed, and Me (that
 * repository's user.email, if it has one: meAuthor). Trimmed, blank-free, de-duplicated ignoring case.
 */
export function authorPatterns(f: FilterState, me?: string): string[] {
  const all = [...(f.authors ?? []), f.author, f.mine && me?.trim() ? meAuthor(me) : ""].map((a) => a.trim()).filter((a) => a !== "");
  const seen = new Set<string>();
  return all.filter((a) => {
    const k = a.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Authors besides Me: with none, a repository without user.email has nothing to show. */
export function hasOtherAuthors(f: FilterState): boolean {
  return authorPatterns({ ...f, mine: false }).length > 0;
}

export function selectRepos(f: FilterState, repos: readonly Repo[]): Repo[] {
  if (f.repoIds === null) return [...repos];
  const ids = new Set(f.repoIds);
  return repos.filter((r) => ids.has(r.id));
}

function pathOf(raw: unknown): { path?: string } {
  const p = typeof raw === "string" ? normalizePath(raw) : undefined;
  return p ? { path: p } : {};
}

function authorsOf(raw: unknown): { authors?: string[] } {
  if (!Array.isArray(raw)) return {};
  const authors = raw.filter((a): a is string => typeof a === "string" && a.trim() !== "").slice(0, MAX_AUTHORS);
  return authors.length > 0 ? { authors } : {};
}

export function sanitizeFilter(raw: unknown): FilterState {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const date = PRESETS.find((p) => p === r.date) ?? DEFAULT_FILTER.date;
  const f: FilterState = {
    text: typeof r.text === "string" ? r.text : "",
    author: typeof r.author === "string" ? r.author : "",
    mine: r.mine === true,
    ...authorsOf(r.authors),
    ...pathOf(r.path),
    branch: typeof r.branch === "string" && isValidRef(r.branch) ? r.branch : "",
    repoIds: Array.isArray(r.repoIds) ? r.repoIds.filter((x): x is string => typeof x === "string") : null,
    date,
  };
  if (Array.isArray(r.branches)) {
    const branches = selectedBranches({ branch: "", branches: r.branches as string[] });
    f.branch = "";
    if (branches.length) f.branches = branches;
  }
  if (r.sort === "topo") f.sort = "topo";
  if (r.matchCase === true) f.matchCase = true;
  if (r.regex === true) f.regex = true;
  if (r.wholeWord === true) f.wholeWord = true;
  if (r.matchAll === true) f.matchAll = true;
  if (date === "custom") {
    if (typeof r.from === "string" && DAY.test(r.from)) f.from = r.from;
    if (typeof r.to === "string" && DAY.test(r.to)) f.to = r.to;
  }
  return f;
}

/** True when only typed fields (search text, author, path) changed: those are debounced. */
export function sameExceptText(a: FilterState, b: FilterState): boolean {
  const ids = (x: FilterState) => (x.repoIds === null ? null : x.repoIds.join("\0"));
  const authors = (x: FilterState) => (x.authors ?? []).join("\0");
  const branches = (f: FilterState) => selectedBranches(f).sort().join("\0");
  return a.mine === b.mine && !a.matchCase === !b.matchCase && !a.regex === !b.regex && !a.wholeWord === !b.wholeWord && !a.matchAll === !b.matchAll && authors(a) === authors(b) && branches(a) === branches(b) && a.sort === b.sort && a.date === b.date && a.from === b.from && a.to === b.to && ids(a) === ids(b);
}

/** Nothing changed (a click on what is already shown): the Log has nothing to read again. */
export function sameFilter(a: FilterState, b: FilterState): boolean {
  return sameExceptText(a, b) && a.text === b.text && a.author === b.author && (a.path ?? "") === (b.path ?? "");
}

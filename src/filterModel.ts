import { HISTORY_FORMAT, LOG_FORMAT } from "./gitLog";
import type { Repo } from "./types";

export type DatePreset = "24h" | "7d" | "30d" | "all" | "custom";

export interface FilterState {
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

/** Ordinary words such as "face" remain message searches; sha: accepts Git's 4-char minimum. */
export function hashQuery(text: string): string | undefined {
  const value = text.trim();
  if (/^[a-f\d]{7,64}$/i.test(value)) return value.toLowerCase();
  return /^sha:([a-f\d]{4,64})$/i.exec(value)?.[1].toLowerCase();
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
}

function buildArgs(format: string, f: FilterState, o: ArgOptions, extra: readonly string[], paths: readonly string[] = []): string[] {
  const args = ["log", format, `--max-count=${o.pageSize}`, "--decorate=full"];
  if (f.sort === "topo") args.push("--topo-order");
  const text = f.text.trim();
  const authors = authorPatterns(f, o.me);
  // Literal and case-insensitive unless asked otherwise; git ANDs --author with --grep, ORs
  // several --author flags, and applies these matching flags to both. Authors stay literal:
  // in regex mode they are escaped.
  // An invalid expression (the webview marks it) is searched as text rather than failing every repository.
  const regex = f.regex === true && !!text && regexProblem(text) === undefined;
  if (text || authors.length > 0) {
    if (!f.matchCase) args.push("--regexp-ignore-case");
    args.push(regex ? "--extended-regexp" : "--fixed-strings");
  }
  if (text) args.push(`--grep=${text}`);
  for (const a of authors) args.push(`--author=${regex ? escapeRegex(a) : a}`);
  const since = sinceOf(f, o.now);
  if (since !== undefined) args.push(`--since=${gitDate(since)}`);
  const until = untilOf(f);
  if (until !== undefined) args.push(`--until=${gitDate(until)}`);
  if (o.cursor && o.cursor.skip > 0) args.push(`--skip=${o.cursor.skip}`);
  args.push(...extra);
  // After --end-of-options: revisions, never options. After --: paths, never
  // revisions, so a branch named like a folder ("docs") is not ambiguous.
  args.push(...revisionArgs(o.refs ?? (o.ref ? [o.ref] : selectedBranches(f))));
  args.push("--", ...paths);
  return args;
}

/** A literal string as a POSIX extended regular expression. */
export function escapeRegex(text: string): string {
  return text.replace(/[.[\]()*+?{}|^$\\]/g, "\\$&");
}

/**
 * Why a message search cannot be sent to git in regex mode; undefined when it can. JavaScript's
 * parser stands in for git's POSIX one: it accepts every ERE that matters here.
 */
export function regexProblem(text: string): string | undefined {
  try {
    new RegExp(text);
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export function logArgs(f: FilterState, o: ArgOptions): string[] {
  const path = f.path === undefined ? undefined : normalizePath(f.path);
  return buildArgs(LOG_FORMAT, f, o, [], path ? [pathspecOf(path)] : []);
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
 * One file's history with the Log's filters: every name the file has had is a
 * pathspec (see historyPathsArgs). No --follow: it cannot page with --skip, and
 * it stops following when the rename commit itself is filtered out.
 *
 * --raw gives each row its status letter (and a rename's old name), --numstat its lines added
 * and deleted, in the same process. The line counts cost git a diff of the file per commit:
 * measured 2026-10-29 (Windows, git 2.55, a page of 200), +12–37 ms on real files with 60–140
 * commits, +100 ms (46 → 146 ms) on a 1,500-line file with 5,000 commits.
 */
export function historyArgs(f: FilterState, o: ArgOptions & { paths: readonly string[] }): string[] {
  // Literal: a route folder like app/[id]/ is a name, not a glob matching app/i/.
  return buildArgs(HISTORY_FORMAT, f, o, ["--raw", "--numstat", "-z", "-M"], o.paths.map((p) => `:(literal)${p}`));
}

/** Unfiltered, unpaged --follow walk that only collects the names a file has had. */
export function historyPathsArgs(path: string, ref?: string | readonly string[]): string[] {
  return ["log", "--follow", "--name-status", "-z", "-M", "--format=%x1e", ...revisionArgs(typeof ref === "string" ? [ref] : ref ?? []), "--", `:(literal)${path}`];
}

/** The file's names, newest first; always starts with its current path. */
export function parseHistoryPaths(stdout: string, path: string): string[] {
  const names = [path];
  const add = (p: string | undefined) => {
    if (p && !names.includes(p)) names.push(p);
  };
  const t = stdout.split(/[\x00\x1e]/);
  for (let i = 0; i < t.length; i++) {
    const m = /^\n*([AMDRCT])\d*$/.exec(t[i]);
    if (!m) continue;
    if (m[1] === "R" || m[1] === "C") {
      add(t[i + 1]);
      add(t[i + 2]);
      i += 2;
    } else {
      add(t[i + 1]);
      i += 1;
    }
  }
  return names;
}

export const MAX_AUTHORS = 20;

/**
 * Every author pattern for one repository: the chips, what is being typed, and Me (that
 * repository's user.email, if it has one). Trimmed, blank-free, de-duplicated ignoring case.
 */
export function authorPatterns(f: FilterState, me?: string): string[] {
  const all = [...(f.authors ?? []), f.author, f.mine ? me ?? "" : ""].map((a) => a.trim()).filter((a) => a !== "");
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
  return a.mine === b.mine && !a.matchCase === !b.matchCase && !a.regex === !b.regex && authors(a) === authors(b) && branches(a) === branches(b) && a.sort === b.sort && a.date === b.date && a.from === b.from && a.to === b.to && ids(a) === ids(b);
}

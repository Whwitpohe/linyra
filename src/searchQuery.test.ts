import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DEFAULT_FILTER, gitDate, hashQuery, logArgs, sameExceptText, sanitizeFilter, type FilterState } from "./filterModel";
import { gitEnv, makeRepo } from "./fixtures";
import { runGit } from "./git";
import { LOG_FORMAT } from "./gitLog";
import { fetchPage } from "./logQuery";
import {
  completionAt, fileTerm, fileWithin, isRefValue, OPERATORS, operatorsFor, parseSearch, planSearch, quoteValue, repoMatches,
  runnable, searchDate, searchFlags, searchRepos, searchSkips, usesMe, withoutWip,
} from "./searchQuery";
import { emptyState } from "./webview/view";

const NOW = 1790164800; // 2026-09-23T12:00:00Z
const ALL: FilterState = { ...DEFAULT_FILTER, date: "all" };
const plan = (text: string, f: Partial<FilterState> = {}, repoNames?: string[]) => planSearch({ ...ALL, ...f, text }, NOW, { repoNames });
const flags = (text: string, f: Partial<FilterState> = {}, me?: string) => searchFlags(plan(text, f), { ...ALL, ...f, text }, me);
const args = (text: string, f: Partial<FilterState> = {}, me?: string) => logArgs({ ...ALL, ...f, text }, { pageSize: 200, now: NOW, me });
const ops = (text: string) => Object.fromEntries(parseSearch(text).operations);
const errors = (text: string, f: Partial<FilterState> = {}, repoNames?: string[]) => plan(text, f, repoNames).errors.map((e) => e.message);
const local = (day: string, time = "00:00:00") => Math.floor(new Date(`${day}T${time}`).getTime() / 1000);

// ── Parsing: words, phrases and operators, as GitLens reads them ────────────
{
  assert.deepStrictEqual(ops("retry uploader"), { "message:": ["retry", "uploader"] }, "each word is its own message: term");
  assert.deepStrictEqual(ops('"retry uploader" fix'), { "message:": ["retry uploader", "fix"] }, "a quoted phrase is one term");
  assert.deepStrictEqual(ops('message:"bug fix" =:wip'), { "message:": ["bug fix", "wip"] }, "message: and its alias =:");
  assert.deepStrictEqual(ops("author:dana @:rin @me"), { "author:": ["dana", "rin", "@me"] }, "author:, @: and a bare @me");
  assert.deepStrictEqual(ops("author:@rin author:@me"), { "author:": ["rin", "@me"] }, "a leading @ is dropped, except in @me");
  assert.deepStrictEqual(ops("committer:@me"), { "committer:": ["@me"] });
  assert.deepStrictEqual(ops("4ce3a1b0 #:abcd sha:ABCDEF commit:1234"), { "commit:": ["4ce3a1b0", "abcd", "abcdef", "1234"] }, "a 7+ hex word is a hash; commit:, #: and sha: take 4+");
  assert.deepStrictEqual(ops("face decade"), { "message:": ["face", "decade"] }, "short hex-looking words stay words");
  assert.deepStrictEqual(ops("file:*.ts ?:src/ change:retry ~:Retry()"), { "file:": ["*.ts", "src/"], "change:": ["retry", "Retry()"] });
  assert.deepStrictEqual(ops("type:merge is:tip"), { "type:": ["merge", "tip"] });
  assert.deepStrictEqual(ops("after:2026-10-01 since:1.week.ago >:yesterday before:x until:y <:z"), { "after:": ["2026-10-01", "1.week.ago", "yesterday"], "before:": ["x", "y", "z"] });
  assert.deepStrictEqual(ops("ref:main ^:v1.0.0 ref:main..feature"), { "ref:": ["main", "v1.0.0", "main..feature"] });
  assert.deepStrictEqual(ops("repo:acme-web repo:acme-*"), { "repo:": ["acme-web", "acme-*"] });
  assert.deepStrictEqual(ops("-message:wip"), { "-message:": ["wip"] });
  assert.deepStrictEqual(ops("Author:dana"), { "message:": ["Author:dana"] }, "operators are case-sensitive, as in GitLens");
  assert.deepStrictEqual(ops("docs: explain"), { "message:": ["docs:", "explain"] }, "a word ending in : is not an operator");
  assert.deepStrictEqual(ops("retry retry"), { "message:": ["retry"] }, "repeats are dropped");
  console.log("ok - parse: words, phrases, every operator and alias, @me and hashes");
}
{
  assert.deepStrictEqual(ops("author: dana"), { "author:": ["dana"] }, "one space may follow an operator");
  const p = parseSearch("author: file:x.ts");
  assert.deepStrictEqual([p.pending.map((t) => t.operator), Object.fromEntries(p.operations)], [["author:"], { "file:": ["x.ts"] }], "not when another operator follows it");
  assert.deepStrictEqual(parseSearch("fix author:").pending.map((t) => [t.operator, t.start, t.end]), [["author:", 4, 11]], "an operator without its value is pending");
  assert.deepStrictEqual(parseSearch("fix author: ").pending.length, 1, "with a trailing space too");
  assert.deepStrictEqual(parseSearch('author:"" ""').operations.size, 0, "empty quotes are nothing to search, and not pending");
  assert.deepStrictEqual(parseSearch('author:"" ""').pending.length, 0);
  assert.deepStrictEqual(ops('message:"bug fi'), { "message:": ["bug fi"] }, "an unclosed quote runs to the end while it is typed");
  const r = parseSearch('fix author:"dana s" #:abcd').ranges;
  assert.deepStrictEqual(r.map((t) => [t.start, t.end, t.operator, t.spelling, t.valueStart, t.raw, t.quoted]), [
    [0, 3, "message:", "", 0, "fix", false],
    [4, 19, "author:", "author:", 11, '"dana s"', true],
    [20, 26, "commit:", "#:", 22, "abcd", false],
  ], "ranges: where each token, operator and value is");
  console.log("ok - parse: one space after an operator, pending operators, quotes and ranges");
}

// ── Errors under the box ────────────────────────────────────────────────────
{
  assert.deepStrictEqual(errors("message:fix -message:wip").length, 1, "message: and -message: cannot be combined");
  assert.ok(errors("fix -message:wip")[0].includes("-message:"), "a bare word is a message: term too");
  assert.deepStrictEqual(errors("fix(api", { regex: true }).length, 1, "an invalid expression, in regex mode");
  assert.deepStrictEqual(errors("fix(api"), [], "is plain text otherwise");
  assert.deepStrictEqual(errors("author:@me", { regex: true }), [], "@me is not an expression");
  assert.strictEqual(errors("commit:xyz").length, 1);
  assert.strictEqual(errors("commit:abc").length, 1, "a hash needs 4 digits");
  assert.ok(errors("type:stash")[0].includes("stash"));
  assert.strictEqual(errors("type:branch").length, 1);
  assert.deepStrictEqual(errors("type:MERGE"), []);
  assert.strictEqual(errors("after:someday").length, 1);
  assert.strictEqual(errors("ref:-x ref:a~b ref:..").length, 3);
  assert.strictEqual(errors("change:a change:b").length, 1, "git searches one change at a time");
  assert.strictEqual(errors("file:/etc/passwd file:../x file::(top)x").length, 3, "file: stays inside each repository");
  assert.deepStrictEqual(errors("repo:acme-web", {}, ["acme-web"]), []);
  assert.deepStrictEqual(errors("repo:ACME-*", {}, ["acme-web"]), [], "repo: ignores case and takes *");
  assert.strictEqual(errors("repo:acme-jobs", {}, ["acme-web"]).length, 1, "an unknown repository");
  assert.deepStrictEqual(errors("repo:acme-jobs"), [], "unchecked without the names");
  const e = plan("fix commit:xyz").errors[0];
  assert.deepStrictEqual([e.start, e.end], [4, 14], "each error says where it is");
  assert.ok(runnable(plan("fix author:dana")));
  assert.ok(!runnable(plan("fix author:")), "a pending operator is not run");
  assert.ok(!runnable(plan("commit:xyz")));
  console.log("ok - errors: conflicting, invalid and unknown values, each with its range");
}

// ── Messages: --grep, OR by default, --all-match, --invert-grep ─────────────
{
  assert.deepStrictEqual(flags("retry uploader"), ["--regexp-ignore-case", "--fixed-strings", "--grep=retry", "--grep=uploader"], "literal, any of the words");
  assert.deepStrictEqual(flags("retry uploader", { matchAll: true }), ["--regexp-ignore-case", "--fixed-strings", "--grep=retry", "--grep=uploader", "--all-match"], "Match All: every word");
  assert.deepStrictEqual(flags("retry", { matchAll: true }), ["--regexp-ignore-case", "--fixed-strings", "--grep=retry"], "one term needs no --all-match");
  assert.deepStrictEqual(flags("-message:wip -message:fixup"), ["--regexp-ignore-case", "--fixed-strings", "--grep=wip", "--grep=fixup", "--invert-grep"]);
  assert.deepStrictEqual(flags("ACME", { matchCase: true }), ["--fixed-strings", "--grep=ACME"], "Match Case drops --regexp-ignore-case");
  assert.deepStrictEqual(flags("fix(api|web)", { regex: true }), ["--regexp-ignore-case", "--extended-regexp", "--grep=fix(api|web)"]);
  assert.deepStrictEqual(flags("fix(api", { regex: true }), ["--regexp-ignore-case", "--extended-regexp", "--grep=fix\\(api"], "an invalid expression is searched as text if it reaches git");
  assert.deepStrictEqual(flags("--output=/tmp/x"), ["--regexp-ignore-case", "--fixed-strings", "--grep=--output=/tmp/x"], "a value never becomes an option");
  console.log("ok - messages: words OR together, Match All ANDs them, -message: inverts, toggles pick git's matching");
}
{
  // A word's edges as every POSIX regex reads them (macOS' has no \\b).
  const S = "(^|[^[:alnum:]_])", E = "([^[:alnum:]_]|$)";
  assert.deepStrictEqual(flags("fix", { wholeWord: true }), ["--regexp-ignore-case", "--extended-regexp", `--grep=${S}fix${E}`], "Whole Word: a word's edges around a literal word");
  assert.deepStrictEqual(flags("fix(api)", { wholeWord: true }), ["--regexp-ignore-case", "--extended-regexp", `--grep=${S}fix\\(api\\)`], "only on the sides that are word characters");
  assert.deepStrictEqual(flags("a.b|c", { wholeWord: true, regex: true }), ["--regexp-ignore-case", "--extended-regexp", `--grep=${S}(a.b|c)${E}`], "and around a whole expression");
  assert.ok(!flags("fix", { wholeWord: true }).join(" ").includes("\\b"), "no \\b: GNU's alone");
  console.log("ok - Whole Word wraps literal words and expressions in a word's POSIX edges");
}

// ── Authors and committers, with @me and the Author box ─────────────────────
{
  assert.deepStrictEqual(flags("author:dana author:rin"), ["--regexp-ignore-case", "--fixed-strings", "--author=dana", "--author=rin"], "several authors: any of them");
  assert.deepStrictEqual(flags("@me", {}, "dana@example.com"), ["--regexp-ignore-case", "--fixed-strings", "--author=dana@example.com"], "@me is this repository's user.email");
  assert.deepStrictEqual(flags("author:@rin committer:@me", {}, "dana@example.com"), ["--regexp-ignore-case", "--fixed-strings", "--author=rin", "--committer=dana@example.com"]);
  assert.deepStrictEqual(flags("author:d.n", { regex: true }), ["--regexp-ignore-case", "--extended-regexp", "--author=d.n"], "author: is an expression in regex mode");
  assert.deepStrictEqual(flags("fix", { regex: true, authors: ["d.n+a"] }), ["--regexp-ignore-case", "--extended-regexp", "--grep=fix", "--author=d\\.n\\+a"], "the Author box stays literal");
  assert.ok(searchSkips(plan("author:@me"), undefined), "@me alone in a repository without user.email: nothing is mine there");
  assert.ok(!searchSkips(plan("author:@me author:rin"), undefined), "with another author, it is still searched for them");
  assert.ok(!searchSkips(plan("author:@me"), "dana@example.com"));
  assert.ok(searchSkips(plan("committer:@me"), undefined));
  assert.ok(usesMe("fix @me") && usesMe("committer:@me") && !usesMe("author:rin"));
  console.log("ok - author: and committer: become --author/--committer, @me per repository");
}
{
  // The Author box and author: must both hold; git ORs --author, so each pair becomes expressions.
  assert.deepStrictEqual(flags("author:dana", { authors: ["dana@example.com"] }), ["--regexp-ignore-case", "--extended-regexp", "--author=dana@example\\.com"], "the box's email contains dana: it alone decides");
  assert.deepStrictEqual(flags("author:dana@example.com", { authors: ["dana"] }), ["--regexp-ignore-case", "--extended-regexp", "--author=dana@example\\.com"], "and the other way round");
  assert.deepStrictEqual(flags("author:DANA", { authors: ["dana@example.com"], matchCase: true }), ["--extended-regexp", "--author=dana@example\\.com.*DANA", "--author=DANA.*dana@example\\.com"], "Match Case: DANA is not inside dana@…");
  assert.deepStrictEqual(flags('author:"a <d"', { authors: ["dana@example.com"] }), ["--regexp-ignore-case", "--extended-regexp",
    "--author=dana@example\\.com.*a <d", "--author=a <d.*dana@example\\.com", "--author=a <dana@example\\.com"], "overlapping: one more expression per overlap");
  assert.deepStrictEqual(flags("author:@me", { authors: ["rin"] }, "dana@example.com"), ["--regexp-ignore-case", "--extended-regexp", "--author=rin.*dana@example\\.com", "--author=dana@example\\.com.*rin"]);
  assert.deepStrictEqual(flags("author:d.n", { regex: true, authors: ["dana@example.com"] }), ["--regexp-ignore-case", "--extended-regexp", "--author=dana@example\\.com"], "an expression matching inside the box's value");
  assert.deepStrictEqual(flags("author:^r", { regex: true, authors: ["dana"] }), ["--regexp-ignore-case", "--extended-regexp", "--author=dana.*(^r)", "--author=(^r).*dana"]);
  assert.deepStrictEqual(flags("author:rin", { mine: true }, "dana@example.com"), ["--regexp-ignore-case", "--extended-regexp", "--author=dana@example\\.com.*rin", "--author=rin.*dana@example\\.com"], "Me is in the Author box");
  console.log("ok - author: and the Author box both hold: git matches expressions needing both");
}

// ── change:, type: ──────────────────────────────────────────────────────────
{
  assert.deepStrictEqual(flags("change:Retry()"), ["--regexp-ignore-case", "-SRetry()"], "pickaxe, ignoring case like the messages");
  assert.deepStrictEqual(flags("change:Retry", { matchCase: true }), ["-SRetry"]);
  assert.deepStrictEqual(flags("change:retry\\(", { regex: true }), ["--regexp-ignore-case", "-Gretry\\("], "regex mode: -G");
  assert.deepStrictEqual(flags("change:retry", { wholeWord: true }), ["--regexp-ignore-case", "--pickaxe-regex", "-S(^|[^[:alnum:]_])retry([^[:alnum:]_]|$)"], "Whole Word: -S as an expression");
  assert.deepStrictEqual(flags('~:"func Retry"', { matchCase: true }), ["-Sfunc Retry"], "a quoted snippet");
  assert.deepStrictEqual(flags("type:merge"), ["--merges"]);
  assert.deepStrictEqual(flags("is:tip"), ["--simplify-by-decoration"]);
  assert.deepStrictEqual(flags("type:wip fix"), ["--regexp-ignore-case", "--fixed-strings", "--grep=fix"], "type:wip is the Uncommitted side, not a git flag");
  assert.ok(plan("type:wip").wip);
  assert.strictEqual(withoutWip("fix type:wip  author:dana"), "fix author:dana");
  assert.strictEqual(withoutWip("is:wip"), "");
  console.log("ok - change: is -S or -G, type: is --merges or --simplify-by-decoration, wip is the Uncommitted side");
}

// ── Dates: after: and before:, narrowing the date range ─────────────────────
{
  assert.strictEqual(searchDate("2026-10-01", NOW, "after"), local("2026-10-01"), "a day starts at local midnight");
  assert.strictEqual(searchDate("2026-10-01", NOW, "before"), local("2026-10-01") - 1, "before: ends just before it");
  assert.strictEqual(searchDate("2026-10-01 14:30", NOW, "before"), local("2026-10-01", "14:30:00"), "a time is exact");
  assert.strictEqual(searchDate("2026-02-30", NOW, "after"), undefined, "no such day");
  assert.strictEqual(searchDate("1.week.ago", NOW, "after"), NOW - 7 * 86_400);
  assert.strictEqual(searchDate("3 days ago", NOW, "after"), NOW - 3 * 86_400);
  assert.strictEqual(searchDate("2.hours.ago", NOW, "before"), NOW - 7200);
  assert.strictEqual(searchDate("2.months.ago", NOW, "after"), Math.floor(new Date(new Date(NOW * 1000).setMonth(new Date(NOW * 1000).getMonth() - 2)).getTime() / 1000));
  assert.ok(searchDate("1.year.ago", NOW, "after")! < NOW - 364 * 86_400);
  const midnight = Math.floor(new Date(new Date(NOW * 1000).setHours(0, 0, 0, 0)).getTime() / 1000);
  assert.strictEqual(searchDate("today", NOW, "after"), midnight);
  assert.strictEqual(searchDate("Yesterday", NOW, "after"), Math.floor(new Date(new Date(midnight * 1000).setDate(new Date(midnight * 1000).getDate() - 1)).getTime() / 1000));
  assert.strictEqual(searchDate("now", NOW, "before"), NOW);
  assert.strictEqual(searchDate("next friday", NOW, "after"), undefined);
  const a = args("after:1.week.ago after:2.weeks.ago before:2026-09-30", { date: "30d" });
  assert.deepStrictEqual(a.filter((x) => x.startsWith("--since") || x.startsWith("--until")), [`--since=${gitDate(NOW - 7 * 86_400)}`, `--until=${gitDate(local("2026-09-30") - 1)}`], "the latest after:, the earliest before:, inside the date range");
  assert.ok(args("after:2026-01-01", { date: "24h" }).includes(`--since=${gitDate(NOW - 86_400)}`), "the date range still holds: both apply");
  console.log("ok - dates: days at local midnight, relative times, the narrowest of the query and the date range");
}

// ── file: as pathspecs, and inside the Path box ─────────────────────────────
{
  assert.deepStrictEqual(fileTerm("src/app.ts", true, true), { kind: "exact", path: "src/app.ts", spec: ":(literal)src/app.ts" }, "quoted: exactly this path");
  assert.deepStrictEqual(fileTerm("src/**/*.ts", false, true)?.spec, ":(glob,icase)src/**/*.ts", "** is git's glob");
  assert.deepStrictEqual(fileTerm("src/**/*.ts", false, false)?.spec, ":(glob)src/**/*.ts");
  assert.deepStrictEqual(fileTerm("*.ts", false, true)?.spec, ":(icase)*.ts", "wildcards and paths as they are");
  assert.deepStrictEqual(fileTerm("package.json", false, false)?.spec, "package.json");
  assert.deepStrictEqual(fileTerm("upload", false, true)?.spec, ":(icase)*upload*", "a bare name: anywhere in the path");
  assert.deepStrictEqual(fileTerm(".\\src\\", false, false)?.spec, "src", "backslashes, ./ and a trailing / are tidied");
  assert.strictEqual(fileTerm("../x", false, true), undefined);
  const paths = (text: string, f: Partial<FilterState> = {}) => { const a = args(text, f); return a.slice(a.indexOf("--") + 1); };
  assert.deepStrictEqual(paths('file:*.ts file:"docs/a b.md"'), [":(icase)*.ts", ":(literal)docs/a b.md"], "several file: values: any of them");
  assert.deepStrictEqual(paths("file:*.ts", { matchCase: true }), ["*.ts"]);
  assert.deepStrictEqual(paths("fix", { path: "src" }), [":(literal)src"], "without file:, the Path box as before");
  console.log("ok - file: values become pathspecs by GitLens's rules");
}
{
  assert.strictEqual(fileWithin(fileTerm("client", false, true)!, "src/web", true), ":(icase)src/web/*client*", "a name inside the folder");
  assert.strictEqual(fileWithin(fileTerm("web", false, true)!, "src/web", true), ":(literal)src/web", "the folder itself has the name: all of it");
  assert.strictEqual(fileWithin(fileTerm("*.ts", false, true)!, "src", true), ":(icase)src/*.ts", "a leading wildcard, at any depth inside");
  assert.strictEqual(fileWithin(fileTerm("**/*.ts", false, false)!, "src", false), ":(glob)src/**/*.ts");
  assert.strictEqual(fileWithin(fileTerm("src/web/*.ts", false, false)!, "src", false), "src/web/*.ts", "a pattern already inside");
  assert.strictEqual(fileWithin(fileTerm("src/app.ts", true, true)!, "src", true), ":(literal)src/app.ts", "an exact file inside");
  assert.strictEqual(fileWithin(fileTerm("src", true, true)!, "src/web", true), ":(literal)src/web", "an exact folder around it");
  assert.strictEqual(fileWithin(fileTerm("lib/x.ts", true, true)!, "src", true), null, "outside: nothing");
  assert.strictEqual(fileWithin(fileTerm("lib/*.ts", false, true)!, "src", true), null);
  assert.strictEqual(fileWithin(fileTerm("src/*.ts", false, true)!, "src/web", true), "unsupported", "a pattern across the folder's edge");
  const p = plan("file:*.ts", { path: "src" });
  assert.deepStrictEqual(p.pathspecs, [":(icase)src/*.ts"], "the Path box and file: both hold: files matching both");
  assert.strictEqual(errors('file:"lib/x.ts"', { path: "src" }).length, 1, "nothing can match: said under the box");
  assert.strictEqual(errors("file:src/*.ts", { path: "src/web" }).length, 1);
  assert.strictEqual(errors("file:*.ts", { path: "**/*.sql" }).length, 1, "a glob in the Path box cannot be narrowed");
  console.log("ok - file: inside the Path box: the files matching both, or an error when git cannot say it");
}

// ── ref:, repo:, commit: ────────────────────────────────────────────────────
{
  for (const v of ["main", "origin/release-1.4", "v1.0.0", "HEAD~3", "main^2", "abcd123", "main..feature", "main...feature", "..feature", "main.."]) assert.ok(isRefValue(v), v);
  for (const v of ["", "..", "-x", "a~b", "main@{1}", "a:b", "--all"]) assert.ok(!isRefValue(v), v);
  const a = args("ref:main..feature ref:v1.0.0");
  assert.deepStrictEqual(a.slice(a.indexOf("--ignore-missing")), ["--ignore-missing", "--end-of-options", "main..feature", "v1.0.0", "--"], "ref: replaces the branches; a repository without it skips it");
  assert.ok(!a.includes("--branches"));
  assert.ok(!args("fix").includes("--ignore-missing"));
  const b = logArgs({ ...ALL, text: "ref:main", branches: ["develop"] }, { pageSize: 200, now: NOW, refs: ["refs/heads/develop"] });
  assert.deepStrictEqual(b.slice(b.indexOf("--end-of-options")), ["--end-of-options", "main", "--"], "with the Branch box, ref: is what is walked");
  const repos = ["acme-web", "acme-api", "acme-libs"].map((name) => ({ name }));
  assert.deepStrictEqual(searchRepos(plan("repo:acme-web repo:ACME-LIBS"), repos).map((r) => r.name), ["acme-web", "acme-libs"]);
  assert.deepStrictEqual(searchRepos(plan("repo:acme-a*"), repos).map((r) => r.name), ["acme-api"]);
  assert.deepStrictEqual(searchRepos(plan("fix"), repos).length, 3, "no repo: keeps every repository");
  assert.ok(repoMatches("acme-*", "ACME-web") && !repoMatches("acme", "acme-web"));
  assert.deepStrictEqual(plan("fix 4ce3a1b0 commit:abcd").hashes, ["4ce3a1b0", "abcd"], "commit: is a hash lookup (the rest is ignored)");
  assert.strictEqual(hashQuery("ABCDEF1"), "abcdef1");
  assert.strictEqual(hashQuery("sha:abcd"), "abcd", "sha: still works");
  assert.strictEqual(hashQuery("fix"), undefined);
  assert.strictEqual(hashQuery("commit:xyz"), undefined);
  console.log("ok - ref: walks its revisions with --ignore-missing, repo: narrows by name, commit: looks up hashes");
}

// ── Filter state: the new toggles ───────────────────────────────────────────
{
  const f = sanitizeFilter({ ...ALL, wholeWord: true, matchAll: "yes" });
  assert.deepStrictEqual([f.wholeWord, f.matchAll], [true, undefined]);
  assert.ok(!sameExceptText({ ...ALL, wholeWord: true }, ALL), "toggles reload at once");
  assert.ok(!sameExceptText({ ...ALL, matchAll: true }, ALL));
  assert.ok(sameExceptText({ ...ALL, text: "author:d" }, { ...ALL, text: "author:da" }), "typing is debounced");
  assert.deepStrictEqual(args("fix author:rin"), ["log", LOG_FORMAT, "--max-count=200", "--decorate=full", "--regexp-ignore-case", "--fixed-strings", "--grep=fix", "--author=rin", "--branches", "--remotes", "HEAD", "--"]);
  console.log("ok - Whole Word and Match All are saved and reload at once");
}

// ── Suggestions at the caret ────────────────────────────────────────────────
{
  assert.deepStrictEqual(completionAt("", 0), { kind: "operator", start: 0, end: 0, prefix: "" });
  assert.deepStrictEqual(completionAt("fix au", 6), { kind: "operator", start: 4, end: 6, prefix: "au" });
  assert.deepStrictEqual(completionAt("author:", 7), { kind: "value", operator: "author:", start: 7, end: 7, prefix: "" });
  assert.deepStrictEqual(completionAt("author: ", 8), { kind: "value", operator: "author:", start: 8, end: 8, prefix: "" }, "after the one space an operator may have");
  assert.deepStrictEqual(completionAt("@:da fix", 4), { kind: "value", operator: "author:", start: 2, end: 4, prefix: "da" });
  assert.deepStrictEqual(completionAt('ref:"rel fix', 8), { kind: "value", operator: "ref:", start: 4, end: 12, prefix: "rel" });
  assert.deepStrictEqual(completionAt("fix ", 4), { kind: "operator", start: 4, end: 4, prefix: "" });
  assert.strictEqual(completionAt('"bug fix"', 9), null, "inside a phrase: nothing to suggest");
  assert.deepStrictEqual(operatorsFor("a").map((o) => o.operator), ["author:", "after:"]);
  assert.deepStrictEqual(operatorsFor("@").map((o) => o.operator), ["author:"], "aliases count");
  assert.deepStrictEqual(operatorsFor("<").map((o) => o.operator), ["before:"]);
  assert.strictEqual(operatorsFor("").length, OPERATORS.length);
  assert.deepStrictEqual(operatorsFor("fix"), []);
  assert.strictEqual(quoteValue("dana smith"), '"dana smith"');
  assert.strictEqual(quoteValue("dana"), "dana");
  assert.ok(emptyState({ repoCount: 3, filter: { ...ALL, text: "author:rin file:*.go" } }).body.startsWith("No commit matches “author:rin file:*.go”"), "an empty result names the query");
  assert.ok(emptyState({ repoCount: 3, filter: { ...ALL, text: "retry" } }).body.startsWith("No commit message contains"), "plain words as before");
  console.log("ok - completions: an operator being typed, or the value of one, at the caret");
}

// ── Real git: the flags do what they say ────────────────────────────────────
(async () => {
  {
    // ref: costs no git process of its own: each repository's one git log skips what it lacks.
    const calls: string[][] = [];
    const fake = ["acme-web", "acme-api", "acme-libs"].map((name) => ({ id: `/ws/${name}`, root: `/ws/${name}`, name }));
    const page = await fetchPage({ repos: fake, filter: { ...ALL, text: "ref:release-1.4 fix" }, pageSize: 50, concurrency: 4, now: NOW, prev: null,
      run: async (cwd, a) => { calls.push([cwd, ...a]); return ""; }, signal: new AbortController().signal });
    assert.deepStrictEqual(calls.map((c) => c[1]), ["log", "log", "log"], "one git log per repository, no ref lookups");
    assert.ok(calls.every((c) => c.includes("--ignore-missing") && c.at(-2) === "release-1.4"));
    assert.ok(page.done);
    const pending: string[][] = [];
    await fetchPage({ repos: fake, filter: { ...ALL, text: "fix author:" }, pageSize: 50, concurrency: 4, now: NOW, prev: null,
      run: async (cwd, a) => { pending.push(a); return ""; }, signal: new AbortController().signal });
    assert.strictEqual(pending.length, 0, "a query the box would not send starts no git process");
    const scoped: string[] = [];
    await fetchPage({ repos: fake, filter: { ...ALL, text: "repo:acme-api fix", repoIds: ["/ws/acme-api", "/ws/acme-web"] }, pageSize: 50, concurrency: 4, now: NOW, prev: null,
      run: async (cwd) => { scoped.push(cwd); return ""; }, signal: new AbortController().signal });
    assert.deepStrictEqual(scoped, ["/ws/acme-api"], "repo: within the ticked repositories: no other is spawned");
    const mine: string[] = [];
    await fetchPage({ repos: fake, filter: { ...ALL, text: "@me" }, pageSize: 50, concurrency: 4, now: NOW, prev: null, me: new Map([["/ws/acme-libs", "dana@example.com"]]),
      run: async (cwd) => { mine.push(cwd); return ""; }, signal: new AbortController().signal });
    assert.deepStrictEqual(mine, ["/ws/acme-libs"], "@me: a repository without user.email is not spawned");
    console.log("ok - ref: adds no git process; an unsendable query, repo: and @me spawn nothing they need not");
  }

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "linyra-search-test-"));
  Object.assign(process.env, gitEnv(home));
  const repos = ["acme-web", "acme-api", "acme-libs"].map((name) => ({ id: path.join(home, name), root: path.join(home, name), name }));
  makeRepo(repos[0].root, [
    { time: 100, author: "rin", message: "feat: scaffold web", files: { "src/client.ts": "export {};\n" } },
    { time: 400, author: "dana", message: "fix: guard nil response", files: { "src/client.ts": "export const ok = true;\n" } },
  ], home);
  makeRepo(repos[1].root, [
    { time: 200, author: "dana", message: "feat: scaffold api", files: { "upload.go": "package upload\n" } },
    { time: 500, author: "rin", message: "feat: add retry to uploader", files: { "upload.go": "package upload\n\nfunc Retry() {}\n" } },
  ], home);
  makeRepo(repos[2].root, [{ time: 300, author: "dana", message: "chore: bump deps", files: { "package.json": "{}\n" } }], home);
  const { execFileSync } = await import("child_process");
  execFileSync("git", ["branch", "release-1.4", "HEAD~1"], { cwd: repos[1].root, env: gitEnv(home) });
  const subjects = async (text: string, f: Partial<FilterState> = {}) => (await fetchPage({
    repos, filter: { ...ALL, ...f, text }, pageSize: 200, concurrency: 4, now: 1000, prev: null, run: runGit, signal: new AbortController().signal,
    me: new Map([[repos[0].id, "dana@example.com"]]),
  })).rows.map((c) => c.subject);

  assert.deepStrictEqual(await subjects("author:rin"), ["feat: add retry to uploader", "feat: scaffold web"]);
  assert.deepStrictEqual(await subjects("scaffold guard"), ["fix: guard nil response", "feat: scaffold api", "feat: scaffold web"], "words: any of them");
  assert.deepStrictEqual(await subjects("scaffold web", { matchAll: true }), ["feat: scaffold web"], "Match All: every one");
  assert.deepStrictEqual(await subjects("-message:scaffold"), ["feat: add retry to uploader", "fix: guard nil response", "chore: bump deps"]);
  assert.deepStrictEqual(await subjects("file:client"), ["fix: guard nil response", "feat: scaffold web"], "a bare name anywhere in the path");
  assert.deepStrictEqual(await subjects("file:*.GO"), ["feat: add retry to uploader", "feat: scaffold api"], "ignoring case");
  assert.deepStrictEqual(await subjects("file:*.GO", { matchCase: true }), []);
  assert.deepStrictEqual(await subjects("ref:release-1.4"), ["feat: scaffold api"], "ref: only where a repository has it: the others list nothing");
  assert.deepStrictEqual(await subjects("ref:release-1.4..main"), ["feat: add retry to uploader"], "a range");
  assert.deepStrictEqual(await subjects("ref:nowhere..main"), [], "a range needs both ends");
  assert.deepStrictEqual(await subjects("change:retry()"), ["feat: add retry to uploader"], "pickaxe, ignoring case");
  assert.deepStrictEqual(await subjects("@me"), ["fix: guard nil response"], "@me: only where user.email is known");
  assert.deepStrictEqual(await subjects("deps", { wholeWord: true }), ["chore: bump deps"]);
  assert.deepStrictEqual(await subjects("dep", { wholeWord: true }), [], "Whole Word: a word's edges in git's own expressions");
  assert.deepStrictEqual(await subjects("bump", { wholeWord: true }), ["chore: bump deps"], "a word inside the subject");
  assert.deepStrictEqual(await subjects("chore", { wholeWord: true }), ["chore: bump deps"], "a word at its start");
  assert.deepStrictEqual(await subjects('author:"a <d"', { authors: ["dana@example.com"] }), ["fix: guard nil response", "chore: bump deps", "feat: scaffold api"], "the Author box and author: overlapping in the author line");
  assert.deepStrictEqual(await subjects("author:rin", { authors: ["dana@example.com"] }), [], "both hold: nobody is dana and rin");
  assert.deepStrictEqual(await subjects("repo:acme-web scaffold"), ["feat: scaffold web"]);
  assert.deepStrictEqual(await subjects("type:merge"), []);
  assert.deepStrictEqual(await subjects("before:2000-01-01"), await subjects(""), "dates are pushed down too");
  assert.deepStrictEqual(await subjects("after:2000-01-01"), []);
  assert.deepStrictEqual(await subjects("fix author:"), [], "a pending operator runs nothing");
  console.log("ok - real git: authors, words, Match All, -message:, file:, ref: per repository, change:, @me, Whole Word, AND with the Author box");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

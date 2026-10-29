import * as assert from "assert";
import { HISTORY_FORMAT, LOG_FORMAT } from "./gitLog";
import { authorPatterns, DEFAULT_FILTER, escapeRegex, regexProblem, gitDate, hasOtherAuthors, normalizePath, pathspecOf, historyArgs, historyPathsArgs, isValidRef, logArgs, parseHistoryPaths, sameExceptText, sameFilter, sanitizeFilter, selectRepos, selectedBranches, type FilterState } from "./filterModel";
import type { Repo } from "./types";

const NOW = 1790164800; // 2026-09-23T12:00:00Z
const ALL: FilterState = { ...DEFAULT_FILTER, date: "all" };
const args = (f: FilterState, cursor?: { skip: number }) => logArgs(f, { pageSize: 200, now: NOW, cursor });
const localStart = (day: string) => Math.floor(new Date(`${day}T00:00:00`).getTime() / 1000);
const localEnd = (day: string) => Math.floor(new Date(`${day}T23:59:59`).getTime() / 1000);

// ── gitDate is the ISO form git reads exactly (it ignores `@<unix>`) ────────
{
  assert.strictEqual(gitDate(2000), "1970-01-01T00:33:20Z");
  assert.strictEqual(gitDate(NOW), "2026-09-23T12:00:00Z");
  console.log("ok - gitDate formats ISO-8601 UTC without milliseconds");
}

// ── No filters: the bare log, and no --grep at all ──────────────────────────
{
  assert.deepStrictEqual(args(ALL), ["log", LOG_FORMAT, "--max-count=200", "--decorate=full", "--branches", "--remotes", "HEAD", "--"]);
  assert.deepStrictEqual(args({ ...ALL, text: "   " }), ["log", LOG_FORMAT, "--max-count=200", "--decorate=full", "--branches", "--remotes", "HEAD", "--"]);
  console.log("ok - empty or whitespace search omits --grep entirely");
}

// ── Search is literal and case-insensitive ──────────────────────────────────
{
  assert.deepStrictEqual(args({ ...ALL, text: " ACME-7 " }), ["log", LOG_FORMAT, "--max-count=200", "--decorate=full", "--regexp-ignore-case", "--fixed-strings", "--grep=ACME-7", "--branches", "--remotes", "HEAD", "--"]);
  for (const text of ["fix(api)", "[ACME-7]", ".", "a|b", "^x$"]) {
    const a = args({ ...ALL, text });
    assert.ok(a.includes("--fixed-strings") && a.includes(`--grep=${text}`), `literal: ${text}`);
  }
  console.log("ok - regex metacharacters are searched literally (--fixed-strings)");
}

// ── A search can never become a git option ──────────────────────────────────
{
  const a = args({ ...ALL, text: "--output=/tmp/pwned" });
  assert.ok(a.includes("--grep=--output=/tmp/pwned"));
  assert.ok(!a.includes("--output=/tmp/pwned"), "never a standalone argument");
  console.log("ok - search text stays inside --grep= (argv array, no shell)");
}

// ── Date presets ────────────────────────────────────────────────────────────
{
  assert.ok(args({ ...ALL, date: "24h" }).includes(`--since=${gitDate(NOW - 86_400)}`));
  assert.ok(args({ ...ALL, date: "7d" }).includes(`--since=${gitDate(NOW - 7 * 86_400)}`));
  assert.ok(args({ ...ALL, date: "30d" }).includes(`--since=${gitDate(NOW - 30 * 86_400)}`));
  assert.ok(!args(ALL).some((a) => a.startsWith("--since")));
  console.log("ok - presets map to --since relative to now; All adds none");
}

// ── Custom range is whole local days, inclusive; malformed bounds dropped ──
{
  const a = args({ ...ALL, date: "custom", from: "2026-09-01", to: "2026-09-10" });
  assert.ok(a.includes(`--since=${gitDate(localStart("2026-09-01"))}`));
  assert.ok(a.includes(`--until=${gitDate(localEnd("2026-09-10"))}`));
  const b = args({ ...ALL, date: "custom", from: "09/01/2026" });
  assert.ok(!b.some((x) => x.startsWith("--since") || x.startsWith("--until")));
  console.log("ok - custom from/to cover whole local days; malformed dates are ignored");
}

// ── Cursor: a walk position (--skip), never a date ──────────────────────────
{
  const a = args(ALL, { skip: 3 });
  assert.ok(a.includes("--skip=3"));
  assert.ok(!a.some((x) => x.startsWith("--until")), "paging never adds --until: git's walk order is not date order");
  assert.ok(!args(ALL, { skip: 0 }).some((x) => x.startsWith("--skip")));
  const c = args({ ...ALL, date: "custom", to: "2026-09-10" }, { skip: 5 });
  assert.ok(c.includes(`--until=${gitDate(localEnd("2026-09-10"))}`) && c.includes("--skip=5"), "a custom end date still applies");
  console.log("ok - a cursor adds only --skip; the custom end date is independent of paging");
}

// ── Repo subset ─────────────────────────────────────────────────────────────
{
  const repos: Repo[] = ["acme-web", "acme-api", "acme-libs"].map((n) => ({ id: `/ws/${n}`, root: `/ws/${n}`, name: n }));
  assert.deepStrictEqual(selectRepos(ALL, repos), repos);
  assert.deepStrictEqual(selectRepos({ ...ALL, repoIds: ["/ws/acme-api", "/ws/gone"] }, repos).map((r) => r.name), ["acme-api"]);
  assert.deepStrictEqual(selectRepos({ ...ALL, repoIds: [] }, repos), []);
  console.log("ok - null selects all, a subset selects those, stale ids are ignored");
}

// ── Persisted state is untrusted: sanitize it ───────────────────────────────
{
  assert.deepStrictEqual(sanitizeFilter(undefined), DEFAULT_FILTER);
  assert.deepStrictEqual(sanitizeFilter("garbage"), DEFAULT_FILTER);
  assert.deepStrictEqual(sanitizeFilter({ text: 7, repoIds: ["/a", 3], date: "forever" }), { text: "", author: "", mine: false, branch: "", repoIds: ["/a"], date: "24h" });
  assert.deepStrictEqual(sanitizeFilter({ text: "x", author: "rin", repoIds: null, date: "7d", from: "2026-09-01" }), { text: "x", author: "rin", mine: false, branch: "", repoIds: null, date: "7d" });
  assert.deepStrictEqual(sanitizeFilter({ text: "", author: 4, mine: "yes", repoIds: null, date: "custom", from: "2026-09-01", to: "nope" }), { text: "", author: "", mine: false, branch: "", repoIds: null, date: "custom", from: "2026-09-01" });
  console.log("ok - sanitizeFilter repairs corrupt persisted state");
}

// ── sameExceptText drives the debounce decision ────────────────────────────
{
  assert.ok(sameExceptText({ ...ALL, text: "a" }, { ...ALL, text: "ab" }));
  assert.ok(sameExceptText({ ...ALL, author: "ri" }, { ...ALL, author: "rin" }), "typing an author is debounced like search");
  assert.ok(!sameExceptText(ALL, { ...ALL, date: "7d" }));
  assert.ok(!sameExceptText(ALL, { ...ALL, repoIds: [] }));
  assert.ok(!sameExceptText({ ...ALL, repoIds: ["/a"] }, { ...ALL, repoIds: ["/b"] }));
  assert.ok(!sameExceptText({ ...ALL, date: "custom", from: "2026-09-01" }, { ...ALL, date: "custom", from: "2026-09-02" }));
  console.log("ok - sameExceptText is true only when nothing but the search changed");
}

// ── sameFilter: a click on what is already shown reads nothing again ──────
{
  assert.ok(sameFilter(ALL, { ...ALL }));
  assert.ok(sameFilter({ ...ALL, repoIds: ["/a"], branches: ["main"] }, { ...ALL, repoIds: ["/a"], branches: ["main"] }));
  assert.ok(sameFilter({ ...ALL, path: undefined }, { ...ALL, path: "" }), "no path and an empty one are the same");
  assert.ok(!sameFilter({ ...ALL, text: "a" }, { ...ALL, text: "ab" }));
  assert.ok(!sameFilter({ ...ALL, author: "ri" }, { ...ALL, author: "rin" }));
  assert.ok(!sameFilter(ALL, { ...ALL, path: "src/" }));
  assert.ok(!sameFilter(ALL, { ...ALL, repoIds: [] }));
  console.log("ok - sameFilter is true only when nothing changed");
}

// ── Author is pushed down as --author, literal and case-insensitive ────────
{
  assert.deepStrictEqual(args({ ...ALL, author: " Rin " }), ["log", LOG_FORMAT, "--max-count=200", "--decorate=full", "--regexp-ignore-case", "--fixed-strings", "--author=Rin", "--branches", "--remotes", "HEAD", "--"]);
  const both = args({ ...ALL, text: "ACME-7", author: "dana@example.com" });
  assert.deepStrictEqual(both.filter((a) => a === "--fixed-strings").length, 1, "the literal/case flags are given once");
  assert.ok(both.includes("--grep=ACME-7") && both.includes("--author=dana@example.com"));
  assert.ok(!args({ ...ALL, author: "  " }).some((a) => a.startsWith("--author")), "blank author adds nothing");
  const inj = args({ ...ALL, author: "--output=/tmp/pwned" });
  assert.ok(inj.includes("--author=--output=/tmp/pwned") && !inj.includes("--output=/tmp/pwned"));
  console.log("ok - author becomes one literal, case-insensitive --author= argument");
}
// ── Several authors: one --author per person, which git combines as "any of" ─
{
  const many = args({ ...ALL, authors: ["dana", " rin@example.com "], author: "sa" });
  assert.deepStrictEqual(many.filter((x) => x.startsWith("--author=")), ["--author=dana", "--author=rin@example.com", "--author=sa"], "each chip, plus what is being typed");
  assert.strictEqual(many.filter((x) => x === "--fixed-strings").length, 1, "literal matching once, for all of them");
  const withMe = logArgs({ ...ALL, authors: ["rin"], mine: true }, { pageSize: 200, now: 0, me: "dana@example.com" });
  assert.deepStrictEqual(withMe.filter((x) => x.startsWith("--author=")), ["--author=rin", "--author=dana@example.com"], "Me is one more author, not a replacement");
  assert.deepStrictEqual(args({ ...ALL, authors: ["dana", "Dana", "", "  "] }).filter((x) => x.startsWith("--author=")), ["--author=dana"], "blank and repeated authors add nothing (case-insensitive)");
  assert.deepStrictEqual(authorPatterns({ ...ALL, authors: ["rin"], mine: true }), ["rin"], "without a repo email, Me adds nothing");
  assert.ok(!hasOtherAuthors({ ...ALL, mine: true }) && hasOtherAuthors({ ...ALL, mine: true, authors: ["rin"] }), "Me alone vs Me plus others");
  console.log("ok - several authors become several literal --author= arguments");
}
{
  assert.deepStrictEqual(sanitizeFilter({ ...ALL, authors: ["dana", 3, "", "rin"] }).authors, ["dana", "rin"], "only non-empty strings survive");
  assert.strictEqual(sanitizeFilter({ ...ALL, authors: Array.from({ length: 40 }, (_, i) => `a${i}`) }).authors?.length, 20, "at most 20 authors");
  assert.ok(!("authors" in sanitizeFilter({ ...ALL, authors: [] })), "no chips: the field is left out, like before");
  assert.ok(!sameExceptText({ ...ALL, authors: ["dana"] }, { ...ALL, authors: ["dana", "rin"] }), "adding a chip reloads at once, not after the typing delay");
  assert.ok(sameExceptText({ ...ALL, authors: ["dana"], author: "r" }, { ...ALL, authors: ["dana"], author: "ri" }), "typing is still debounced");
  console.log("ok - the authors list is validated, capped, and reloads at once when it changes");
}

// ── Me: each repository's own user.email ────────────────────────────────────
{
  const a = logArgs({ ...ALL, mine: true }, { pageSize: 200, now: NOW, me: "dana@example.com" });
  assert.ok(a.includes("--author=dana@example.com") && a.includes("--fixed-strings"));
  const both = logArgs({ ...ALL, mine: true, author: "rin" }, { pageSize: 200, now: NOW, me: "dana@example.com" });
  assert.ok(both.includes("--author=dana@example.com") && both.includes("--author=rin"), "Me is one more author beside the typed one (0.2.0: several authors)");
  assert.ok(sanitizeFilter({ ...ALL, mine: true }).mine);
  console.log("ok - Me becomes --author=<that repository's user.email>");
}

// ── File history: the same filters, one path, followed across renames ──────
{
  const a = historyArgs({ ...ALL, text: "fix" }, { pageSize: 200, now: NOW, cursor: { skip: 5 }, paths: ["src/client.ts", "src/old.ts"] });
  assert.strictEqual(a[1], HISTORY_FORMAT);
  assert.ok(a.includes("--grep=fix") && a.includes("--skip=5"));
  assert.ok(!a.includes("--follow"), "no --follow: it cannot page with --skip, and a filtered-out rename would cut the history");
  assert.deepStrictEqual(a.slice(-10), ["--raw", "--numstat", "-z", "-M", "--branches", "--remotes", "HEAD", "--", ":(literal)src/client.ts", ":(literal)src/old.ts"], "status letters (--raw) and line counts (--numstat) in one process; the paths are always after --, and literal: [id] is a folder, not a glob");
  assert.ok(!a.includes("--name-status"), "--name-status would replace --numstat: git keeps one of them");
  const inj = historyArgs(ALL, { pageSize: 1, now: NOW, paths: ["--output=/tmp/x"] });
  assert.deepStrictEqual(inj.slice(-2), ["--", ":(literal)--output=/tmp/x"], "a path can never be read as an option");
  assert.deepStrictEqual(historyPathsArgs("src/client.ts", "origin/prod"), ["log", "--follow", "--name-status", "-z", "-M", "--format=%x1e", "--end-of-options", "origin/prod", "--", ":(literal)src/client.ts"]);
  assert.deepStrictEqual(historyPathsArgs("app/[id]/page.tsx").slice(-1), [":(literal)app/[id]/page.tsx"], "a route folder like [id] is not a glob");
  assert.deepStrictEqual(parseHistoryPaths("\x1e\x00\nM\x00new.ts\x00\x1e\x00\nR100\x00old.ts\x00new.ts\x00\x1e\x00\nA\x00old.ts\x00", "new.ts"), ["new.ts", "old.ts"]);
  assert.deepStrictEqual(parseHistoryPaths("", "a.ts"), ["a.ts"], "an untracked file still has its own path");
  console.log("ok - history first learns every name the file had, then asks for all of them");
}

// ── Default range and branch ────────────────────────────────────────────────
{
  assert.strictEqual(DEFAULT_FILTER.date, "24h", "new workspaces start at the last 24 hours");
  assert.deepStrictEqual(selectedBranches(DEFAULT_FILTER), [], "all branches by default");
  console.log("ok - the default filter is the last 24 hours across all branches");
}
{
  for (const ok of ["origin/prod", "prod", "release-1.4", "origin/release/1.4", "feature/acme_7", "v1.2.3", "feature@x", "fix/#12", "fix/ü", "a+b", "a@b/c"]) assert.ok(isValidRef(ok), ok);
  for (const bad of ["", "-x", "--output=/tmp/x", "a..b", "a b", "a~1", "a^", "a:b", "a?", "a*", "a[", "a\\b", "@{u}", "a@{1}", "@", "a.lock", "a/b.lock", "a/", "a.", "/a", "a//b", ".a", "a/.b", "a\tb", "a\u007fb"]) assert.ok(!isValidRef(bad), `rejects ${JSON.stringify(bad)}`);
  console.log("ok - isValidRef accepts branch names and rejects options and revision syntax");
}
{
  const a = logArgs(ALL, { pageSize: 5, now: NOW, ref: "origin/prod" });
  assert.deepStrictEqual(a.slice(-3), ["--end-of-options", "origin/prod", "--"], "the ref comes after --end-of-options and before --, so a same-named folder is never ambiguous");
  const h = historyArgs({ ...ALL, text: "fix" }, { pageSize: 5, now: NOW, paths: ["b.ts", "a.ts"], ref: "origin/prod" });
  assert.deepStrictEqual(h.slice(-9), ["--raw", "--numstat", "-z", "-M", "--end-of-options", "origin/prod", "--", ":(literal)b.ts", ":(literal)a.ts"], "history options stay before the ref; every name the file had is a pathspec");
  assert.ok(logArgs(ALL, { pageSize: 5, now: NOW }).includes("--branches"), "all local and remote branches by default");
  assert.strictEqual(sanitizeFilter({ ...ALL, branch: "--output=/tmp/x" }).branch, "", "an invalid persisted branch is dropped");
  assert.strictEqual(sanitizeFilter({ ...ALL, branch: "origin/prod" }).branch, "origin/prod");
  assert.ok(!sameExceptText(ALL, { ...ALL, branch: "origin/prod" }), "a branch change applies at once, not debounced");
  console.log("ok - a branch becomes one revision argument after --end-of-options");
}

{
  const filter = sanitizeFilter({ ...ALL, branches: ["main", "prod", "main", "--output=/tmp/x", 7, "a..b", "fix/ü"] });
  assert.deepStrictEqual(selectedBranches(filter), ["main", "prod", "fix/ü"]);
  assert.deepStrictEqual(logArgs(filter, { pageSize: 5, now: NOW }).slice(-5), ["--end-of-options", "main", "prod", "fix/ü", "--"]);
  assert.deepStrictEqual(selectedBranches(sanitizeFilter({ ...ALL, branch: "main", branches: [] })), [], "explicitly clearing overrides the legacy branch");
  assert.deepStrictEqual(selectedBranches(sanitizeFilter({ ...ALL, branch: "prod" })), ["prod"], "older saved selections still work");
  assert.ok(sameExceptText({ ...ALL, branches: ["main", "prod"] }, { ...ALL, branches: ["prod", "main"] }), "selection order has no effect");
  assert.ok(!sameExceptText(ALL, filter), "checkbox changes apply immediately");
  assert.strictEqual(selectedBranches(sanitizeFilter({ ...ALL, branches: Array.from({ length: 120 }, (_, i) => `branch-${i}`) })).length, 100);
  console.log("ok - multiple branches are validated, unique, bounded, migrated and passed as separate revisions");
}

{
  const topo = sanitizeFilter({ ...ALL, branches: ["main", "prod"], sort: "topo" });
  assert.strictEqual(topo.sort, "topo");
  assert.ok(logArgs(topo, { pageSize: 10, now: NOW }).includes("--topo-order"));
  assert.ok(!logArgs(ALL, { pageSize: 10, now: NOW }).includes("--topo-order"));
  assert.ok(!sameExceptText(ALL, { ...ALL, sort: "topo" }), "sort applies immediately");
  assert.ok(!sanitizeFilter({ ...ALL, sort: "invalid" }).sort);
  console.log("ok - sorting is validated, persisted and pushed down into Git");
}

// ── Path filter: one pathspec after "--", so git does the filtering ─────────────
{
  assert.strictEqual(normalizePath(" src/checkout/ "), "src/checkout", "trimmed, no trailing slash");
  assert.strictEqual(normalizePath("./src\\checkout"), "src/checkout", "a leading ./ and Windows separators are fine");
  for (const bad of ["/etc", "C:\\x", "../x", "a/../../b", ":(top)x", ":!secret", "a\nb", ""]) {
    assert.strictEqual(normalizePath(bad), undefined, `rejected: ${JSON.stringify(bad)}`);
  }
  assert.strictEqual(pathspecOf("src/checkout"), ":(literal)src/checkout", "a folder or file: literal, and a folder matches everything inside");
  assert.strictEqual(pathspecOf("**/*.sql"), ":(glob)**/*.sql", "globs use git's glob magic, where ** crosses folders");
  assert.strictEqual(pathspecOf("*.ts"), ":(glob)**/*.ts", "a glob without a folder matches at any depth, like .gitignore and plain git log -- '*.ts'");
  assert.strictEqual(pathspecOf("docs/[ab].md"), ":(glob)docs/[ab].md");
  console.log("ok - a path filter is validated and becomes one literal or glob pathspec");
}
{
  const a = args({ ...ALL, path: "src/checkout" });
  assert.deepStrictEqual(a.slice(a.indexOf("--")), ["--", ":(literal)src/checkout"], "after --, so it can never be read as an option or a revision");
  assert.deepStrictEqual(args({ ...ALL, path: ":(top)evil" }).slice(-1), ["--"], "an unsafe path adds nothing");
  const h = historyArgs({ ...ALL, path: "src" }, { pageSize: 200, now: 0, paths: ["upload.go"] });
  assert.deepStrictEqual(h.slice(h.indexOf("--")), ["--", ":(literal)upload.go"], "File History ignores the path filter: it has its own file");
  assert.strictEqual(sanitizeFilter({ ...ALL, path: " src/ " }).path, "src");
  assert.ok(!("path" in sanitizeFilter({ ...ALL, path: "../x" })), "a bad saved path is dropped");
  assert.ok(sameExceptText({ ...ALL, path: "sr" }, { ...ALL, path: "src" }), "typing a path is debounced like search");
  console.log("ok - the path filter is pushed down after --, and File History keeps its own paths");
}

// ── Match case and regular expressions, as in the JetBrains Log's search ──
{
  const regex = args({ ...ALL, text: "fix(api|web)", regex: true });
  assert.ok(regex.includes("--extended-regexp") && regex.includes("--regexp-ignore-case") && !regex.includes("--fixed-strings"));
  const exact = args({ ...ALL, text: "ACME", matchCase: true });
  assert.ok(exact.includes("--fixed-strings") && !exact.includes("--regexp-ignore-case"), "match case drops --regexp-ignore-case");
  const author = args({ ...ALL, text: "^feat", regex: true, author: "d.n+a (x)" });
  assert.ok(author.includes(String.raw`--author=d\.n\+a \(x\)`), "authors stay literal in regex mode");
  assert.strictEqual(escapeRegex(String.raw`a.b[c]^$|\ `.trim()), String.raw`a\.b\[c\]\^\$\|\\`);
  assert.strictEqual(regexProblem("fix(api|web)"), undefined);
  assert.ok(regexProblem("fix(api"), "an unbalanced group is refused before git sees it");
  assert.deepStrictEqual([sanitizeFilter({ ...ALL, regex: true, matchCase: true }).regex, sanitizeFilter({ ...ALL, regex: "yes" }).regex], [true, undefined]);
  assert.ok(!sameExceptText({ ...ALL, regex: true }, ALL), "toggling regex reloads at once, not debounced");
  assert.ok(sameExceptText({ ...ALL, matchCase: false }, ALL), "absent and false are the same");
  console.log("ok - match case and regex modes become git's own flags; authors stay literal");
}

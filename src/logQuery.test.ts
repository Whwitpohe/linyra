import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DEFAULT_FILTER, type FilterState } from "./filterModel";
import { gitEnv, makeRepo } from "./fixtures";
import { GitError, runGit } from "./git";
import { fetchPage, type QueryState, type RunGit } from "./logQuery";
import { compareCommits } from "./mergeStream";
import { isAbortError } from "./pool";
import { commitKey, type Commit, type Repo } from "./types";

const ALL: FilterState = { ...DEFAULT_FILTER, date: "all" };
const repo = (name: string): Repo => ({ id: `/ws/${name}`, root: `/ws/${name}`, name });
const WEB = repo("acme-web"), API = repo("acme-api"), LIBS = repo("acme-libs");
let serial = 0;
const mk = (r: Repo, time: number, subject = `${r.name}@${time}`): Commit => ({
  repoId: r.id, sha: (++serial).toString(16).padStart(40, "0"), time, author: "rin", email: "rin@example.com", subject, parents: [],
});
const stdout = (cs: Commit[]) => cs.map((c) => [c.sha, c.time, c.author, c.email, c.subject, c.parents.join(" ")].join("\0") + "\x1e\n").join("");
const arg = (args: string[], prefix: string) => args.find((a) => a.startsWith(prefix))?.slice(prefix.length);

/**
 * Stands in for git: emits commits in the given array order — git's walk order,
 * which is NOT date order when a clock is skewed — honouring --skip/--max-count.
 */
function fakeRun(data: Record<string, Commit[]>, calls: string[][] = [], failing = new Set<string>()): RunGit {
  return async (cwd, args) => {
    calls.push([cwd, ...args]);
    if (failing.has(cwd)) throw new GitError("shallow clone: history is incomplete", 128);
    const max = Number(arg(args, "--max-count="));
    const skip = Number(arg(args, "--skip=") ?? 0);
    return stdout((data[cwd] ?? []).slice(skip, skip + max));
  };
}
const newestFirst = (cs: Commit[]) => [...cs].sort(compareCommits);
async function pageAll(repos: Repo[], data: Record<string, Commit[]>, pageSize: number, calls: string[][] = []) {
  const run = fakeRun(data, calls);
  const pages: Commit[][] = [];
  let prev: QueryState | null = null;
  for (let guard = 0; guard < 200; guard++) {
    const page = await fetchPage(req({ repos, pageSize, now: 1_790_164_800 + guard * 1000, prev, run, filter: { ...DEFAULT_FILTER, date: "30d" } }));
    pages.push(page.rows);
    prev = page.state;
    if (page.done) return pages;
  }
  throw new Error("paging did not terminate");
}

const req = (over: Partial<Parameters<typeof fetchPage>[0]>) => ({
  repos: [WEB, API, LIBS], filter: ALL, pageSize: 200, concurrency: 16, now: 1_790_164_800, prev: null,
  run: fakeRun({}), signal: new AbortController().signal, ...over,
});

(async () => {
  {
    // A repository that fails on a later page keeps the rows already fetched for it.
    const data = { [WEB.root]: [mk(WEB, 40), mk(WEB, 30), mk(WEB, 10)], [API.root]: [mk(API, 35), mk(API, 5), mk(API, 1)] };
    const p1 = await fetchPage(req({ repos: [WEB, API], pageSize: 2, run: fakeRun(data) }));
    assert.ok(!p1.rows.some((c) => c.subject === "acme-api@5"), "held back: older than what acme-web has fetched");
    const p2 = await fetchPage(req({ repos: [WEB, API], pageSize: 2, prev: p1.state, run: fakeRun(data, [], new Set([API.root])) }));
    assert.deepStrictEqual(p2.failures.map((f) => f.name), ["acme-api"]);
    let rows = p2.rows.map((c) => c.subject);
    let prev = p2.state;
    for (let i = 0; i < 5 && !rows.includes("acme-api@5"); i++) {
      const p = await fetchPage(req({ repos: [WEB, API], pageSize: 2, prev, run: fakeRun(data, [], new Set([API.root])) }));
      rows = rows.concat(p.rows.map((c) => c.subject));
      prev = p.state;
      if (p.done) break;
    }
    assert.ok(rows.includes("acme-api@5"), `acme-api@5 was already fetched: it is still shown (${rows.join(", ")})`);
    console.log("ok - a repository failing on a later page keeps the commits already fetched for it");
  }
  {
    const data = { [WEB.root]: [mk(WEB, 30), mk(WEB, 10)], [API.root]: [mk(API, 20)], [LIBS.root]: [mk(LIBS, 40)] };
    const page = await fetchPage(req({ run: fakeRun(data) }));
    assert.deepStrictEqual(page.rows.map((c) => c.subject), ["acme-libs@40", "acme-web@30", "acme-api@20", "acme-web@10"]);
    assert.deepStrictEqual(page.failures, []);
    assert.strictEqual(page.done, true);
    console.log("ok - fans out to every repo and merges newest first");
  }
  {
    const data = { [WEB.root]: [mk(WEB, 30)], [API.root]: [mk(API, 20)] };
    const page = await fetchPage(req({ run: fakeRun(data, [], new Set([LIBS.root])) }));
    assert.deepStrictEqual(page.rows.map((c) => c.repoId), [WEB.id, API.id]);
    assert.deepStrictEqual(page.failures, [{ repoId: LIBS.id, name: "acme-libs", reason: "shallow clone: history is incomplete" }]);
    assert.ok(page.state.progress.get(LIBS.id)?.exhausted !== false, "a failed repo is not retried by Load More");
    console.log("ok - one failing repository is reported and excluded, not fatal");
  }
  {
    const calls: string[][] = [];
    await fetchPage(req({ filter: { ...ALL, repoIds: [API.id] }, run: fakeRun({}, calls) }));
    assert.deepStrictEqual(calls.map((c) => c[0]), [API.root]);
    console.log("ok - the repo subset is pushed down: unselected repos are never spawned");
  }
  {
    const data = { [WEB.root]: [mk(WEB, 60), mk(WEB, 40), mk(WEB, 20)], [API.root]: [mk(API, 50), mk(API, 30), mk(API, 10)] };
    const calls: string[][] = [];
    const pages = await pageAll([WEB, API], data, 2, calls);
    const all = pages.flat();
    assert.ok(pages.length >= 2);
    assert.strictEqual(new Set(all.map(commitKey)).size, 6, "every commit exactly once");
    assert.deepStrictEqual(all.map((c) => c.time), [60, 50, 40, 30, 20, 10]);
    assert.strictEqual(new Set(calls.map((c) => arg(c, "--since="))).size, 1, "--since stays fixed across pages even as time passes");
    assert.ok(calls.every((c) => !c.some((a) => a.startsWith("--until="))), "paging never uses --until");
    console.log("ok - Load More pages through every repo with a stable --since");
  }
  {
    // git emits a child before its parents; a child with a backwards clock
    // comes out "too old" in the middle of newer history (review finding).
    const walk = Array.from({ length: 10 }, (_, i) => mk(WEB, 10_000 - i * 100));
    walk[6] = { ...walk[6], time: 10_000 - 1_000_000 };
    const pages = await pageAll([WEB], { [WEB.root]: walk }, 3);
    const all = pages.flat();
    assert.strictEqual(all.length, 10, "no commit after the skewed one goes missing");
    assert.strictEqual(new Set(all.map(commitKey)).size, 10);
    console.log("ok - a backwards-dated commit cannot hide the rest of its repo");
  }
  {
    const rebased = Array.from({ length: 450 }, () => mk(WEB, 5000));
    const busy = Array.from({ length: 300 }, (_, i) => mk(API, 6200 - i * 3));
    const old = Array.from({ length: 5 }, (_, i) => mk(LIBS, 104 - i));
    const data = { [WEB.root]: rebased, [API.root]: busy, [LIBS.root]: old };
    const pages = await pageAll([WEB, API, LIBS], data, 200);
    const flat = pages.flat();
    assert.ok(pages.length >= 3, `expected several pages, got ${pages.length}`);
    assert.strictEqual(new Set(flat.map(commitKey)).size, flat.length, "no duplicates");
    assert.deepStrictEqual(flat.map(commitKey), newestFirst([...rebased, ...busy, ...old]).map(commitKey), "no gaps; global order holds without skew");
    console.log("ok - a >pageSize same-second rebase pages through with no duplicates or gaps");
  }
  {
    const calls: string[][] = [];
    const data = { [WEB.root]: [mk(WEB, 3)], [API.root]: [mk(API, 2)], [LIBS.root]: [mk(LIBS, 1)] };
    const me = new Map([[WEB.id, "dana@example.com"], [LIBS.id, "rin@example.com"]]);
    await fetchPage(req({ filter: { ...ALL, mine: true }, run: fakeRun(data, calls), me }));
    assert.deepStrictEqual(calls.map((c) => [c[0], arg(c, "--author=")]), [[WEB.root, "dana@example.com"], [LIBS.root, "rin@example.com"]]);
    console.log("ok - Me asks each repository for its own user.email and skips repos without one");
  }
  {
    const calls: string[][] = [];
    const data = { [WEB.root]: [mk(WEB, 3)], [API.root]: [mk(API, 2)], [LIBS.root]: [mk(LIBS, 1)] };
    const me = new Map([[WEB.id, "dana@example.com"]]);
    await fetchPage(req({ filter: { ...ALL, mine: true, authors: ["noor"] }, run: fakeRun(data, calls), me }));
    assert.deepStrictEqual(calls.map((c) => c[0]).sort(), [API.root, LIBS.root, WEB.root].sort(), "with other authors picked, a repo without user.email is still searched for them");
    assert.deepStrictEqual(calls.find((c) => c[0] === API.root)!.filter((a) => a.startsWith("--author=")), ["--author=noor"]);
    console.log("ok - Me plus other authors: every repo is searched for the others, and for Me where it has an email");
  }
  {
    const calls: string[][] = [];
    const out = "\x1e" + [mk(API, 9).sha, "9", "rin", "rin@example.com", "feat: add retry", ""].join("\0") + "\0\nM\0upload.go\0";
    const names = "\x1e\x00\nM\x00upload.go\x00\x1e\x00\nR100\x00up.go\x00upload.go\x00";
    const run: RunGit = async (cwd, args) => { calls.push([cwd, ...args]); return args.includes("--follow") ? names : out; };
    const page = await fetchPage(req({ run, history: { repoId: API.id, path: "upload.go" } }));
    assert.deepStrictEqual(calls.map((c) => c[0]), [API.root, API.root], "history asks only the file's repository");
    assert.ok(calls[0].includes("--follow"), "first: every name the file has had");
    assert.ok(!calls[1].includes("--follow") && calls[1].slice(-3).join() === "--,:(literal)upload.go,:(literal)up.go", "then: all those names, without --follow");
    assert.deepStrictEqual(page.rows.map((c) => c.file), [{ path: "upload.go", status: "M" }]);
    assert.strictEqual(page.done, true);
    console.log("ok - file history queries one repository with --follow and keeps each commit's path");
  }
  {
    const calls: string[][] = [];
    const data = { [WEB.root]: [mk(WEB, 30), mk(WEB, 20), mk(WEB, 10)], [API.root]: [mk(API, 25)], [LIBS.root]: [mk(LIBS, 15)] };
    const inner = fakeRun(data, calls);
    // acme-web and acme-libs have origin/prod; acme-api does not.
    const run: RunGit = async (cwd, args, signal) => {
      if (args[0] === "for-each-ref") {
        calls.push([cwd, ...args]);
        return cwd === API.root ? "refs/heads/main\n" : "refs/remotes/origin/prod\n";
      }
      return inner(cwd, args, signal);
    };
    const filter = { ...ALL, branch: "origin/prod" };
    let page = await fetchPage(req({ filter, pageSize: 2, run }));
    assert.strictEqual(calls.filter((c) => c[1] === "for-each-ref").length, 3, "one ref listing per repository");
    const logs = calls.filter((c) => c[1] === "log");
    assert.deepStrictEqual(logs.find((c) => c[0] === WEB.root)!.slice(-3), ["--end-of-options", "refs/remotes/origin/prod", "--"]);
    assert.ok(!logs.find((c) => c[0] === API.root), "a repo without the branch is skipped");
    assert.deepStrictEqual(page.branchUse, { branches: ["origin/prod"], found: 2, missing: 1 });
    assert.ok(page.rows.every((r) => r.ref === "origin/prod"));
    const before = calls.length;
    page = await fetchPage(req({ filter, pageSize: 2, run, prev: page.state }));
    assert.ok(calls.slice(before).every((c) => c[1] !== "for-each-ref"), "Load More reuses the resolution");
    assert.ok(calls.slice(before).find((c) => c[0] === WEB.root)!.includes("refs/remotes/origin/prod"));
    console.log("ok - each repo walks the branches it has, skips missing ones and reuses the resolution for paging");
  }
  {
    // A slow rev-parse in one repository must not hold back the others' git log.
    const order: string[] = [];
    const inner = fakeRun({ [WEB.root]: [mk(WEB, 30)], [API.root]: [mk(API, 25)] });
    const run: RunGit = async (cwd, args, signal) => {
      if (args[0] === "for-each-ref") {
        if (cwd === WEB.root) await new Promise((r) => setTimeout(r, 50));
        order.push(`rev-parse ${cwd}`);
        return "refs/remotes/origin/prod\n";
      }
      order.push(`log ${cwd}`);
      return inner(cwd, args, signal);
    };
    await fetchPage(req({ repos: [WEB, API], filter: { ...ALL, branch: "origin/prod" }, pageSize: 2, run }));
    assert.ok(order.indexOf(`log ${API.root}`) < order.indexOf(`rev-parse ${WEB.root}`), `each repo's log follows its own rev-parse (${order.join(" → ")})`);
    console.log("ok - branch mode: each repository goes from rev-parse to log on its own");
  }
  {
    const ctl = new AbortController();
    ctl.abort();
    const calls: string[][] = [];
    await assert.rejects(fetchPage(req({ run: fakeRun({}, calls), signal: ctl.signal })), (e: unknown) => isAbortError(e));
    assert.strictEqual(calls.length, 0);
    console.log("ok - an aborted query rejects with AbortError and spawns nothing");
  }
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "polylog-query-test-"));
    Object.assign(process.env, gitEnv(home));
    const repos = ["acme-web", "acme-api", "acme-libs"].map((name) => ({ id: path.join(home, name), root: path.join(home, name), name }));
    makeRepo(repos[0].root, [{ time: 100, author: "rin", message: "feat: scaffold web" }, { time: 400, author: "dana", message: "fix: guard nil response" }], home);
    makeRepo(repos[1].root, [{ time: 200, author: "dana", message: "feat: scaffold api" }, { time: 500, author: "rin", message: "feat: add retry to uploader" }], home);
    makeRepo(repos[2].root, [{ time: 300, author: "dana", message: "chore: bump deps" }], home);
    const page = await fetchPage({ repos, filter: ALL, pageSize: 200, concurrency: 16, now: 1000, prev: null, run: runGit, signal: new AbortController().signal });
    assert.deepStrictEqual(page.rows.map((c) => c.subject), [
      "feat: add retry to uploader", "fix: guard nil response", "chore: bump deps", "feat: scaffold api", "feat: scaffold web",
    ]);
    console.log("ok - end to end against three real repositories");

    const skewed = { id: path.join(home, "acme-skew"), root: path.join(home, "acme-skew"), name: "acme-skew" };
    makeRepo(skewed.root, Array.from({ length: 10 }, (_, i) => ({
      time: i === 6 ? 50 : 1000 + i * 100, author: "rin" as const, message: `c${i}`,
    })), home);
    const all: Commit[] = [];
    let prev: QueryState | null = null;
    for (let guard = 0; guard < 50; guard++) {
      const page = await fetchPage({ repos: [skewed], filter: ALL, pageSize: 3, concurrency: 4, now: 5000, prev, run: runGit, signal: new AbortController().signal });
      all.push(...page.rows);
      prev = page.state;
      if (page.done) break;
    }
    assert.deepStrictEqual(all.map((c) => c.subject).sort(), Array.from({ length: 10 }, (_, i) => `c${i}`).sort());
    console.log("ok - real git: one backwards-dated commit does not truncate paging");
    const topological: Commit[] = [];
    let topoPrev: QueryState | null = null;
    for (let guard = 0; guard < 50; guard++) {
      const page = await fetchPage({ repos: [skewed], filter: { ...ALL, sort: "topo" }, pageSize: 2, concurrency: 4, now: 5000,
        prev: topoPrev, run: runGit, signal: new AbortController().signal });
      topological.push(...page.rows);
      topoPrev = page.state;
      if (page.done) break;
    }
    assert.strictEqual(topological.length, 10);
    const indexes = new Map(topological.map((c, i) => [c.sha, i]));
    topological.forEach((c, i) => c.parents.forEach((parent) => assert.ok(i < indexes.get(parent)!, "every child precedes its parent, across page boundaries and reversed dates")));
    console.log("ok - real git: topological sorting survives reversed dates and pagination");
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

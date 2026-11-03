import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DEFAULT_FILTER, type FilterState } from "./filterModel";
import { execFileSync } from "child_process";
import { commitAt, gitEnv, makeRepo } from "./fixtures";
import { GitError, runGit } from "./git";
import { batchSize, depthOf, fetchPage, MAX_BATCH, type QueryState, type RunGit } from "./logQuery";
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
    assert.deepStrictEqual([0, 200, 400, 1500, 50_000].map((fetched) => batchSize(fetched, 200)), [200, 200, 400, 1500, MAX_BATCH]);
    assert.strictEqual(batchSize(0, 5000), 5000, "a page larger than the cap is still one page");
    const walk = Array.from({ length: 30 }, (_, i) => mk(WEB, 10_000 - i));
    const calls: string[][] = [];
    const all = (await pageAll([WEB], { [WEB.root]: walk }, 2, calls)).flat();
    assert.deepStrictEqual(all.map(commitKey), walk.map(commitKey), "a growing batch still lists every commit once, in order");
    // Each later read also asks again for the last record read (one before its --skip): it must still be there.
    assert.deepStrictEqual(calls.map((c) => Number(arg(c, "--max-count="))), [2, 3, 5, 9, 17], "each read asks for as many as were read before");
    assert.deepStrictEqual(calls.map((c) => Number(arg(c, "--skip=") ?? 0)), [0, 1, 3, 7, 15]);
    console.log("ok - deep paging grows each repository's batch, so --skip walks history a logarithmic number of times");
  }
  {
    // History moved between pages: a commit made in a terminal or VS Code's Source Control, or a reset.
    const walk = Array.from({ length: 10 }, (_, i) => mk(WEB, 10_000 - i * 10, `c${9 - i}`));
    const data: Record<string, Commit[]> = { [WEB.root]: [...walk] };
    const calls: string[][] = [];
    const run = fakeRun(data, calls);
    const subjects = (p: { rows: Commit[] }) => p.rows.map((c) => c.subject);
    const p1 = await fetchPage(req({ repos: [WEB], pageSize: 4, run }));
    assert.deepStrictEqual(subjects(p1), ["c9", "c8", "c7", "c6"]);
    const still = await fetchPage(req({ repos: [WEB], pageSize: 4, run, prev: p1.state }));
    assert.ok(!still.restarted && subjects(still).join() === "c5,c4,c3,c2", `unmoved: the next page (${subjects(still).join()})`);

    data[WEB.root] = [mk(WEB, 20_000, "new"), ...walk];
    const grown = await fetchPage(req({ repos: [WEB], pageSize: 4, run, prev: p1.state }));
    assert.strictEqual(grown.restarted, true, "a commit above: the list is read again, not appended to");
    assert.deepStrictEqual(subjects(grown), ["new", "c9", "c8", "c7", "c6", "c5", "c4", "c3"], "from the top and a page deeper; c6 once");
    assert.deepStrictEqual([arg(calls.at(-1)!, "--max-count="), arg(calls.at(-1)!, "--skip=")], ["8", undefined], "in one read, from the top");
    const after = await fetchPage(req({ repos: [WEB], pageSize: 4, run, prev: grown.state }));
    assert.ok(!after.restarted && subjects(after).join() === "c2,c1,c0" && after.done, `and paging goes on from there (${subjects(after).join()})`);

    data[WEB.root] = walk.slice(2);
    const reset = await fetchPage(req({ repos: [WEB], pageSize: 4, run, prev: p1.state }));
    assert.strictEqual(reset.restarted, true, "c9 and c8 reset away: read again");
    assert.deepStrictEqual(subjects(reset), ["c7", "c6", "c5", "c4", "c3", "c2", "c1", "c0"], "c5 and c4 are not passed over");
    console.log("ok - Load More reads the list again when history moved under it: no row twice, none passed over");
  }
  {
    // A first page as deep as an earlier list (Fetch All's reload): the same rows, in one read each.
    const walk = Array.from({ length: 30 }, (_, i) => mk(WEB, 10_000 - i));
    const data = { [WEB.root]: walk, [API.root]: [mk(API, 9_990), mk(API, 5)] };
    let prev: QueryState | null = null;
    let listed: Commit[] = [];
    for (let i = 0; i < 3; i++) {
      const page = await fetchPage(req({ repos: [WEB, API], pageSize: 4, run: fakeRun(data), prev }));
      listed = listed.concat(page.rows);
      prev = page.state;
    }
    const calls: string[][] = [];
    const again = await fetchPage(req({ repos: [WEB, API], pageSize: 4, run: fakeRun(data, calls), depth: depthOf(prev) }));
    assert.deepStrictEqual(again.rows.map(commitKey), listed.map(commitKey), "the rows listed before, no fewer");
    assert.deepStrictEqual(calls.map((c) => [c[0], arg(c, "--max-count=")]), [[WEB.root, String(prev!.progress.get(WEB.id)!.fetched)], [API.root, "4"]]);
    assert.strictEqual(again.state.progress.get(API.id)!.exhausted, true, "a repository read to its end still knows it");
    assert.strictEqual(depthOf(null), undefined);
    console.log("ok - a list read again as deep as before lists the same rows, one git log per repository");
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
    assert.deepStrictEqual(calls.map((c) => [c[0], arg(c, "--author=")]), [[WEB.root, "<dana@example.com>"], [LIBS.root, "<rin@example.com>"]]);
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
    const inputs: (string | undefined)[] = [];
    const [edit, rename] = [mk(API, 9).sha, mk(API, 8).sha];
    const out = "\x1e" + [edit, "9", "rin", "rin@example.com", "feat: add retry", ""].join("\0") + "\0\nM\0upload.go\0";
    const names = `\x1e${edit}\x00\nM\x00upload.go\x00\x1e${rename}\x00\nR100\x00up.go\x00upload.go\x00`;
    const run: RunGit = async (cwd, args, _signal, opts) => {
      calls.push([cwd, ...args]);
      inputs.push(opts?.input);
      return args.includes("--follow") ? names : args[0] === "rev-parse" ? `${edit}\n` : out;
    };
    const page = await fetchPage(req({ run, history: { repoId: API.id, path: "upload.go" } }));
    assert.ok(calls.every((c) => c[0] === API.root), "history asks only the file's repository");
    assert.ok(calls[0].includes("--follow"), "first: each commit of the file, and every name it has had");
    const log = calls.at(-1)!;
    assert.ok(!log.includes("--follow") && log.slice(-3).join() === "--,:(literal)upload.go,:(literal)up.go", "then: all those names, without --follow");
    assert.strictEqual(inputs.at(-1), `${edit}\n${rename}\n`, "and exactly those commits");
    assert.deepStrictEqual(page.rows.map((c) => c.file), [{ path: "upload.go", status: "M" }]);
    assert.strictEqual(page.done, true);
    const none: string[][] = [];
    const empty = await fetchPage(req({ run: async (cwd, args) => { none.push(args); return ""; }, history: { repoId: API.id, path: "new.go" } }));
    assert.deepStrictEqual([none.length, empty.rows, empty.done], [1, [], true], "a file without commits: no git log, which given none would list HEAD");
    console.log("ok - file history queries one repository with --follow and keeps each commit's path");

    // All branches: one walk, and one per tip only when that walk went through a rename.
    const steps = async (walked: string, tips: string) => {
      const seen: string[] = [];
      await fetchPage(req({ history: { repoId: API.id, path: "upload.go" }, run: async (_cwd, args) => {
        seen.push(args[0] === "log" && args.includes("--follow") ? `follow ${args.includes("--branches") ? "all" : args.at(-3)}` : args[0] === "log" ? "log" : args[0]);
        return args.includes("--follow") ? walked : args[0] === "rev-parse" ? tips : out;
      } }));
      return seen;
    };
    const plain = `\x1e${edit}\x00\nM\x00upload.go\x00`;
    const [tipA, tipB] = ["a".repeat(40), "b".repeat(40)];
    assert.deepStrictEqual(await steps(plain, ""), ["follow all", "log"], "never renamed: one walk is exact");
    assert.deepStrictEqual(await steps(names, `${tipA}\n${tipA}\n`), ["follow all", "rev-parse", "log"], "renamed, but every branch at one commit");
    assert.deepStrictEqual(await steps(names, `${tipA}\n${tipB}\n${tipA}\n`), ["follow all", "rev-parse", `follow ${tipA}`, `follow ${tipB}`, "log"], "renamed: each distinct tip on its own");
    console.log("ok - file history walks each tip on its own only when a rename could mislead one walk over all branches");
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
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "linyra-query-test-"));
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
    // A subject holding git's record separator (RS) is one commit, and paging stays aligned.
    const odd = { id: path.join(home, "acme-odd"), root: path.join(home, "acme-odd"), name: "acme-odd" };
    makeRepo(odd.root, ["c1", "c2", "c3", "four\x1epart", "c5", "c6"].map((message, i) => ({ time: 1000 + i * 100, author: "rin" as const, message })), home);
    const oddRows: string[] = [];
    let oddPrev: QueryState | null = null;
    for (let guard = 0; guard < 20; guard++) {
      const page = await fetchPage({ repos: [odd], filter: ALL, pageSize: 2, concurrency: 4, now: 5000, prev: oddPrev, run: runGit, signal: new AbortController().signal });
      oddRows.push(...page.rows.map((c) => c.subject));
      oddPrev = page.state;
      if (page.done) break;
    }
    assert.deepStrictEqual(oddRows, ["c6", "c5", "four\x1epart", "c3", "c2", "c1"]);
    console.log("ok - real git: an RS in a subject neither drops its commit nor shifts the next page");

    // File History: index.ts became main.ts, then a new, unrelated index.ts was added.
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}\n`).join("");
    const reuse = { id: path.join(home, "acme-reuse"), root: path.join(home, "acme-reuse"), name: "acme-reuse" };
    makeRepo(reuse.root, [
      { time: 100, author: "dana", message: "c1 add index", files: { "index.ts": lines(5) } },
      { time: 200, author: "rin", message: "c2 edit index", files: { "index.ts": lines(6) } },
      { time: 300, author: "dana", message: "c3 rename index to main", files: { "index.ts": null, "main.ts": lines(6) } },
      { time: 400, author: "dana", message: "c4 new index", files: { "index.ts": "brand new\nunrelated\n" } },
      { time: 500, author: "dana", message: "c5 edit new index", files: { "index.ts": "brand new\nunrelated\nmore\n" } },
      { time: 600, author: "rin", message: "c6 edit main", files: { "main.ts": lines(7) } },
      { time: 700, author: "dana", message: "c7 edit both", files: { "index.ts": "brand new\nunrelated\nmore\nagain\n", "main.ts": lines(8) } },
    ], home);
    const history = async (repo: Repo, file: string, filter: FilterState = ALL, pageSize = 2) => {
      const rows: string[] = [];
      let prev: QueryState | null = null;
      for (let guard = 0; guard < 20; guard++) {
        const page = await fetchPage({ repos: [repo], filter, pageSize, concurrency: 4, now: 5000, prev, run: runGit, signal: new AbortController().signal, history: { repoId: repo.id, path: file } });
        rows.push(...page.rows.map((c) => `${c.subject.split(" ")[0]} ${c.file?.status} ${c.file?.oldPath ? `${c.file.oldPath}→` : ""}${c.file?.path}`));
        prev = page.state;
        if (page.done) break;
      }
      return rows;
    };
    assert.deepStrictEqual(await history(reuse, "main.ts"), ["c7 M main.ts", "c6 M main.ts", "c3 R index.ts→main.ts", "c2 M index.ts", "c1 A index.ts"],
      "git log --follow's commits, each with this file's change: not the new index.ts's");
    assert.deepStrictEqual(await history(reuse, "main.ts", { ...ALL, author: "rin" }), ["c6 M main.ts", "c2 M index.ts"], "a filter that drops the rename keeps the older name's commits");
    assert.deepStrictEqual(await history(reuse, "main.ts", { ...ALL, sort: "topo" }, 50), ["c7 M main.ts", "c6 M main.ts", "c3 R index.ts→main.ts", "c2 M index.ts", "c1 A index.ts"]);
    const follow = (file: string) => execFileSync("git", ["log", "--follow", "--format=%s", "--", file], { cwd: reuse.root, env: gitEnv(home) }).toString().trim().split("\n").map((s) => s.split(" ")[0]);
    for (const file of ["main.ts", "index.ts"]) assert.deepStrictEqual((await history(reuse, file)).map((r) => r.split(" ")[0]), follow(file), `${file}: git log --follow's own list`);
    console.log("ok - real git: File History lists exactly git log --follow's commits, though a later file reused an old name");

    // All branches: main renamed old.ts to a.ts; side, newer, renamed its own other.ts into a.ts.
    // One --follow walk over both switches to other.ts at side's rename, on main too.
    const cross = { id: path.join(home, "acme-cross"), root: path.join(home, "acme-cross"), name: "acme-cross" };
    makeRepo(cross.root, [
      { time: 50, author: "dana", message: "m0 add old", files: { "old.ts": lines(5) } },
      { time: 100, author: "dana", message: "m1 rename old to a", files: { "old.ts": null, "a.ts": lines(5) } },
    ], home);
    const g = (args: string[]) => execFileSync("git", args, { cwd: cross.root, env: gitEnv(home), stdio: "pipe" });
    g(["checkout", "-q", "-b", "side"]);
    commitAt(cross.root, home, { time: 150, author: "rin", message: "s1 drop a", files: { "a.ts": null } });
    commitAt(cross.root, home, { time: 160, author: "rin", message: "s2 add other", files: { "other.ts": "other\n".repeat(5) } });
    commitAt(cross.root, home, { time: 170, author: "rin", message: "s3 edit other", files: { "other.ts": "other\n".repeat(6) } });
    g(["checkout", "-q", "main"]);
    commitAt(cross.root, home, { time: 200, author: "dana", message: "m2 edit a", files: { "a.ts": lines(6) } });
    commitAt(cross.root, home, { time: 300, author: "dana", message: "m3 edit a", files: { "a.ts": lines(7) } });
    g(["checkout", "-q", "side"]);
    commitAt(cross.root, home, { time: 400, author: "rin", message: "s4 rename other to a", files: { "other.ts": null, "a.ts": "other\n".repeat(6) } });
    g(["checkout", "-q", "main"]);
    assert.deepStrictEqual(await history(cross, "a.ts"), ["s4 R other.ts→a.ts", "m3 M a.ts", "m2 M a.ts", "s3 M other.ts", "s2 A other.ts", "m1 R old.ts→a.ts", "m0 A old.ts"],
      "each branch's own --follow: main's history before its rename is not lost, and side's dropped a.ts is not in it");
    assert.deepStrictEqual(await history(cross, "a.ts", { ...ALL, branches: ["main"] }), ["m3 M a.ts", "m2 M a.ts", "m1 R old.ts→a.ts", "m0 A old.ts"], "a selected branch: its own walk, as before");
    console.log("ok - real git: File History over all branches follows each branch's renames on its own");
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

    // A commit, then a reset, between Load Mores: git's walk moved under --skip each time.
    const moving = { id: path.join(home, "acme-moving"), root: path.join(home, "acme-moving"), name: "acme-moving" };
    makeRepo(moving.root, Array.from({ length: 10 }, (_, i) => ({ time: 1000 + i * 100, author: "rin" as const, message: `c${i}` })), home);
    const read = (prev: QueryState | null) => fetchPage({ repos: [moving], filter: ALL, pageSize: 4, concurrency: 4, now: 5000, prev, run: runGit, signal: new AbortController().signal });
    let shown = await read(null);
    const list = shown.rows.map((c) => c.subject);
    commitAt(moving.root, home, { time: 2000, author: "dana", message: "from a terminal" });
    shown = await read(shown.state);
    assert.ok(shown.restarted, "a new commit on top: the list is read again");
    assert.deepStrictEqual(shown.rows.map((c) => c.subject), ["from a terminal", "c9", "c8", "c7", "c6", "c5", "c4", "c3"]);
    assert.ok(list.every((s) => shown.rows.some((c) => c.subject === s)), "every row listed before is still listed");
    execFileSync("git", ["reset", "-q", "--hard", "HEAD~3"], { cwd: moving.root, env: gitEnv(home), stdio: "pipe" });
    shown = await read(shown.state);
    assert.ok(shown.restarted, "a reset: read again");
    assert.deepStrictEqual(shown.rows.map((c) => c.subject), ["c7", "c6", "c5", "c4", "c3", "c2", "c1", "c0"], "nothing reset away, nothing passed over");
    shown = await read(shown.state);
    assert.ok(!shown.restarted && shown.rows.length === 0 && shown.done, "then it pages on to the end");
    console.log("ok - real git: Load More after a commit or a reset lists every commit once");
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

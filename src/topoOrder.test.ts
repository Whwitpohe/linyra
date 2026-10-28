import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DEFAULT_FILTER, type FilterState } from "./filterModel";
import { gitEnv, makeRepo } from "./fixtures";
import { runGit } from "./git";
import { LOG_FORMAT, parseLog } from "./gitLog";
import { fetchPage, type QueryState } from "./logQuery";
import { commitKey, type Commit, type Repo } from "./types";

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "linyra-topo-order-"));
  const previousEnv = { ...process.env };
  try {
    fs.writeFileSync(path.join(home, ".gitconfig"), "[user]\n name = dana\n email = dana@example.com\n");
    Object.assign(process.env, gitEnv(home));
    const repos: Repo[] = ["acme-web", "acme-api"].map((name) => ({ name, root: path.join(home, name), id: path.join(home, name) }));
    const [web, api] = repos;
    makeRepo(web.root, [{ time: 1_800_000_000, author: "dana", message: "root" }], home);
    makeRepo(api.root, [{ time: 1_800_000_900, author: "dana", message: "other repo" }], home);
    const git = (args: string[], cwd = web.root, time = 1_800_000_000) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GIT_AUTHOR_NAME: "dana", GIT_AUTHOR_EMAIL: "dana@example.com", GIT_COMMITTER_NAME: "dana", GIT_COMMITTER_EMAIL: "dana@example.com", GIT_AUTHOR_DATE: `${time} +0000`, GIT_COMMITTER_DATE: `${time} +0000` } }).trim();
    const root = git(["rev-parse", "HEAD"]), tree = git(["rev-parse", "HEAD^{tree}"]);
    const node = (subject: string, offset: number, parents: string[]) => git(["commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-m", subject], web.root, 1_800_000_000 + offset);
    const main = node("mainline", 800, [root]), b1 = node("incoming one", 100, [root]), b2 = node("incoming two", 200, [b1]);
    const merge = node("merge incoming", 1000, [main, b2]);
    git(["update-ref", "refs/heads/main", merge]); git(["update-ref", "refs/heads/release-1.4", b2]);
    const raw = parseLog(git(["log", "--topo-order", LOG_FORMAT, "--branches", "--remotes", "HEAD"]), web.id);
    assert.deepStrictEqual(raw.map((c) => c.subject), ["merge incoming", "incoming two", "incoming one", "mainline", "root"]);
    const filter: FilterState = { ...DEFAULT_FILTER, date: "all", sort: "topo" };
    const collect = async (pageSize: number, over: Partial<FilterState> = {}): Promise<Commit[]> => {
      const rows: Commit[] = []; let prev: QueryState | null = null;
      for (let i = 0; i < 100; i++) {
        const page = await fetchPage({ repos, filter: { ...filter, ...over }, pageSize, now: 1_800_002_000, concurrency: 2, prev, run: runGit, signal: new AbortController().signal });
        assert.deepStrictEqual(page.failures, []); rows.push(...page.rows); prev = page.state;
        if (page.done) return rows;
      }
      throw new Error("topological paging did not terminate");
    };
    const expected = ["merge incoming", "incoming two", "incoming one", "other repo", "mainline", "root"];
    for (const pageSize of [1, 2, 3, 200]) {
      const rows = await collect(pageSize);
      assert.deepStrictEqual(rows.map((c) => c.subject), expected, `same merge-side grouping with pageSize=${pageSize}`);
      assert.strictEqual(new Set(rows.map(commitKey)).size, rows.length);
      const indexes = new Map(rows.map((c, i) => [commitKey(c), i]));
      rows.forEach((c, i) => c.parents.forEach((sha) => { const parent = indexes.get(commitKey({ repoId: c.repoId, sha })); if (parent !== undefined) assert.ok(i < parent); }));
    }
    const dated = await collect(2, { sort: undefined });
    assert.deepStrictEqual(dated.map((c) => c.subject), ["merge incoming", "other repo", "mainline", "incoming two", "incoming one", "root"]);
    console.log("ok - real Git: merge-side commits stay below their merge in multi-repo pages of 1/2/3/200, without duplicates or parent inversion");
    console.log("ok - real Git: date mode still interleaves strictly by timestamp");
    const c1 = node("nested incoming one", 300, [root]), c2 = node("nested incoming two", 400, [c1]);
    const nested = node("nested merge", 600, [b2, c2]), outer = node("outer merge", 1200, [main, nested]);
    git(["update-ref", "refs/heads/main", outer]);
    const nestedExpected = ["outer merge", "nested merge", "nested incoming two", "nested incoming one", "incoming two", "incoming one", "other repo", "mainline", "root"];
    for (const pageSize of [1, 2, 200]) assert.deepStrictEqual((await collect(pageSize)).map((c) => c.subject), nestedExpected);
    console.log("ok - real Git: nested incoming merge blocks remain intact across one-commit pages");
    const octopus = node("octopus merge", 1400, [main, b2, c2]);
    git(["update-ref", "refs/heads/main", octopus]);
    const octopusExpected = ["octopus merge", "nested incoming two", "nested incoming one", "incoming two", "incoming one", "other repo", "mainline", "root"];
    assert.deepStrictEqual((await collect(1)).map((c) => c.subject), octopusExpected);
    assert.deepStrictEqual((await collect(200)).map((c) => c.subject), octopusExpected);
    const filtered = await collect(1, { text: "incoming" });
    assert.deepStrictEqual(filtered.map((c) => c.subject).sort(), ["incoming one", "incoming two", "nested incoming one", "nested incoming two"].sort());
    assert.deepStrictEqual(await collect(1, { author: "nobody@example.com" }), []);
    assert.deepStrictEqual((await collect(1, { branches: ["release-1.4"] })).map((c) => c.subject), ["incoming two", "incoming one", "root"]);
    console.log("ok - real Git: octopus merges, author/message filters and selected refs terminate without missing or duplicate commits");
    const first = await fetchPage({ repos, filter, pageSize: 1, now: 1_800_002_000, concurrency: 2, prev: null, run: runGit, signal: new AbortController().signal });
    const frontier = [...first.state.topology!.part!.incoming!];
    const ctl = new AbortController(); ctl.abort();
    await assert.rejects(fetchPage({ repos, filter, pageSize: 1, now: 1_800_002_000, concurrency: 2, prev: first.state, run: runGit, signal: ctl.signal }));
    assert.deepStrictEqual([...first.state.topology!.part!.incoming!], frontier);
    console.log("ok - real Git: an aborted Load More leaves the previous merge continuation untouched");
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
    Object.assign(process.env, previousEnv);
    if (!path.resolve(home).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("unsafe test cleanup path");
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });

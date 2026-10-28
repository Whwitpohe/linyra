import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DEFAULT_FILTER, hashQuery } from "./filterModel";
import { makeRepo, gitEnv } from "./fixtures";
import { runGit } from "./git";
import { fetchPage, type PageRequest, type RunGit } from "./logQuery";
import { isAbortError } from "./pool";
import type { Repo } from "./types";

{
  assert.strictEqual(hashQuery(" A1B2C3D "), "a1b2c3d");
  assert.strictEqual(hashQuery("sha:ABCD"), "abcd");
  assert.strictEqual(hashQuery("a".repeat(64)), "a".repeat(64));
  for (const text of ["face", "cafe", "fix: api", "--output=x", "sha:a..b", "abc123", "a".repeat(65), "sha:abc"]) assert.strictEqual(hashQuery(text), undefined, text);
  console.log("ok - hash detection accepts full/short SHA-1 and SHA-256, with sha: for 4-char prefixes");
}

const repo = (id: string): Repo => ({ id, name: id, root: id });
const baseRequest = (repos: Repo[], text: string, run: RunGit): PageRequest => ({ repos, filter: { ...DEFAULT_FILTER, text },
  pageSize: 1, concurrency: 2, now: 1_800_000_000, prev: null, run, signal: new AbortController().signal });
const record = (sha: string, time: number) => [sha, time, "dana", "dana@example.com", "hash result", ""].join("\0") + "\x1e";

async function main(): Promise<void> {
  {
    const a = "abcdef0" + "1".repeat(33), b = "abcdef0" + "2".repeat(33), blob = "abcdef0" + "3".repeat(33);
    const calls: string[][] = [];
    const run: RunGit = async (root, args, _signal, opts) => {
      calls.push(args);
      if (root === "broken") throw new Error("repository unavailable");
      if (args[0] === "rev-parse") return [a, b, blob].join("\n");
      if (args[0] === "cat-file") {
        assert.strictEqual(opts?.input, `${a}\n${b}\n${blob}\n`);
        return `${a} commit\n${b} commit\n${blob} blob\n`;
      }
      assert.ok(args.includes("--no-walk=unsorted"));
      assert.ok(args.includes(a) && args.includes(b) && !args.includes(blob));
      return record(a, 10) + record(b, 20);
    };
    const result = await fetchPage(baseRequest([repo("good"), repo("broken")], "abcdef0", run));
    assert.deepStrictEqual(result.rows.map((c) => c.sha), [b, a], "ambiguous prefixes show all matching commits in date order");
    assert.strictEqual(result.failures.length, 1);
    assert.ok(result.done, "exact lookup does not offer a history page");
    assert.ok(calls.every((args) => !args.some((arg) => arg.startsWith("--grep="))), "a hash is resolved by Git, not matched against messages");
    const ctl = new AbortController();
    ctl.abort();
    await assert.rejects(fetchPage({ ...baseRequest([repo("good")], a, run), signal: ctl.signal }), (e: unknown) => isAbortError(e));
    console.log("ok - ambiguity, non-commit objects, partial repository failures and cancellation are handled");
  }

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "linyra-hash-"));
  const env = gitEnv(home);
  const git = (root: string, args: string[]) => execFileSync("git", args, { cwd: root, env, stdio: "pipe" }).toString().trim();
  const web = path.join(home, "acme-web"), libs = path.join(home, "acme-libs"), api = path.join(home, "acme-api");
  const run: RunGit = (root, args, signal, opts) => runGit(root, args, signal, { ...opts, env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig") } });
  try {
    makeRepo(web, [{ time: 1000, author: "dana", message: "base", files: { "src/app.ts": "base\n" } },
      { time: 2000, author: "rin", message: "next", files: { "src/app.ts": "next\n" } }], home);
    makeRepo(api, [{ time: 3000, author: "dana", message: "different repository" }], home);
    git(home, ["clone", "-q", web, libs]);
    const old = git(web, ["rev-parse", "HEAD~1"]);
    const repos = [repo(web), repo(libs), repo(api)];
    const lookup = (text: string) => fetchPage({ ...baseRequest(repos, text, run), filter: { ...DEFAULT_FILTER,
      text, author: "nobody", mine: true, branches: ["does-not-exist"], path: "missing/path", date: "24h" } });
    for (const text of [old, old.slice(0, 7).toUpperCase(), `sha:${old.slice(0, 4)}`]) {
      const result = await lookup(text);
      assert.deepStrictEqual(new Set(result.rows.map((c) => c.repoId)), new Set([web, libs]));
      assert.ok(result.rows.every((c) => c.sha === old));
      assert.strictEqual(result.failures.length, 0);
    }
    const selected = await fetchPage({ ...baseRequest(repos, old, run), filter: { ...DEFAULT_FILTER, text: old, repoIds: [web] } });
    assert.deepStrictEqual(selected.rows.map((c) => c.repoId), [web]);
    const blob = git(web, ["rev-parse", "HEAD:src/app.ts"]);
    assert.deepStrictEqual((await lookup(blob)).rows, [], "a blob id is not a commit");
    git(web, ["-c", "user.name=dana", "-c", "user.email=dana@example.com", "tag", "-a", "test-tag", "-m", "a tag object"]);
    const tag = git(web, ["rev-parse", "refs/tags/test-tag"]);
    assert.deepStrictEqual((await lookup(tag)).rows, [], "an annotated tag's own id is not a commit id");
    const detached = git(web, ["-c", "user.name=dana", "-c", "user.email=dana@example.com", "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "unreferenced commit"]);
    const direct = await lookup(detached);
    assert.deepStrictEqual(direct.rows.map((c) => c.sha), [detached], "direct lookup does not need a branch pointing at the commit");
    assert.strictEqual(direct.rows[0].subject, "unreferenced commit");
    console.log("ok - real Git finds old/shared/unreferenced commits across repos, respects repo selection and ignores other filters");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });

import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { gitEnv } from "../fixtures";
import { gitDirFacts, unbornHead } from "./gitDir";

// Real git in a throwaway folder: what Health and the empty-repository check read from the git dir.
(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "linyra-gitdir-"));
  const env = { ...gitEnv(home), GIT_AUTHOR_NAME: "dana", GIT_AUTHOR_EMAIL: "dana@example.com", GIT_COMMITTER_NAME: "dana", GIT_COMMITTER_EMAIL: "dana@example.com" };
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, stdio: "pipe" }).toString().trim();
  try {
    const repo = path.join(home, "acme-web");
    fs.mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    assert.strictEqual(await unbornHead(repo), true, "a new repository: HEAD names a branch with no commit");
    assert.deepStrictEqual(await gitDirFacts(repo), { commitGraph: false, tracked: 0, shared: false }, "no index yet: nothing tracked");

    fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
    fs.mkdirSync(path.join(repo, "src"));
    fs.writeFileSync(path.join(repo, "src", "b.ts"), "b\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "first");
    assert.strictEqual(await unbornHead(repo), false, "a loose branch ref");
    assert.strictEqual((await gitDirFacts(repo)).tracked, 2, "the index header's count: one per tracked file");
    git(repo, "pack-refs", "--all");
    assert.strictEqual(await unbornHead(repo), false, "a packed branch ref");
    git(repo, "checkout", "-q", "--detach");
    assert.strictEqual(await unbornHead(repo), false, "detached: HEAD is a commit");
    git(repo, "checkout", "-q", "main");

    git(repo, "commit-graph", "write", "--reachable");
    assert.strictEqual((await gitDirFacts(repo)).commitGraph, true);

    const linked = path.join(home, "acme-web-hotfix");
    git(repo, "worktree", "add", "-q", "-b", "hotfix", linked);
    assert.deepStrictEqual(await gitDirFacts(linked), { commitGraph: true, tracked: 2, shared: true }, "a linked worktree: its own index, the main repository's objects");
    assert.strictEqual(await unbornHead(linked), false, "its branch lives in the common git dir");

    const orphan = path.join(home, "acme-api");
    fs.mkdirSync(orphan);
    git(orphan, "init", "-q", "-b", "main");
    git(orphan, "checkout", "-q", "--orphan", "fresh");
    assert.strictEqual(await unbornHead(orphan), true);
    assert.strictEqual(await unbornHead(path.join(home, "not-a-repo")), undefined, "no git dir: cannot say");
    console.log("ok - the git dir says whether HEAD has a commit, what the index tracks, and whether a worktree shares its git dir");
  } finally {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
})().catch((e) => { console.error(e); process.exit(1); });

import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { gitEnv, makeRepo } from "./fixtures";
import { stashLogStamp } from "./stashLog";

void (async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "linyra-stash-log-"));
  try {
    const root = path.join(home, "acme-api");
    makeRepo(root, [{ time: 1000, author: "dana", message: "feat: base", files: { "a.txt": "one\n" } }], home);
    const env = { ...gitEnv(home), GIT_AUTHOR_NAME: "dana", GIT_AUTHOR_EMAIL: "dana@example.com", GIT_COMMITTER_NAME: "dana", GIT_COMMITTER_EMAIL: "dana@example.com" };
    const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    const linked = path.join(home, "acme-api-side");
    git(root, ["worktree", "add", "-q", "-b", "acme-side", linked]);
    assert.strictEqual(await stashLogStamp(root), "", "no stashes yet");
    fs.writeFileSync(path.join(root, "a.txt"), "two\n");
    git(root, ["stash", "push", "-q", "-m", "first"]);
    const one = await stashLogStamp(root);
    assert.notStrictEqual(one, "", "a stash pushed");
    assert.strictEqual(await stashLogStamp(root), one, "nothing changed: the same stamp");
    assert.strictEqual(await stashLogStamp(linked), one, "a linked worktree shares the stashes");
    fs.writeFileSync(path.join(linked, "a.txt"), "three\n");
    git(linked, ["stash", "push", "-q", "-m", "second, from the worktree"]);
    const two = await stashLogStamp(root);
    assert.notStrictEqual(two, one, "a stash pushed in another worktree");
    git(root, ["stash", "drop", "-q", "stash@{1}"]);
    const three = await stashLogStamp(root);
    assert.ok(three !== two && three !== "", "a stash dropped");
    git(root, ["stash", "drop", "-q"]);
    assert.strictEqual(await stashLogStamp(root), "", "the last one dropped");
    assert.strictEqual(await stashLogStamp(path.join(home, "nowhere")), "", "not a repository");
    console.log("ok - real git: refs/stash's reflog stamp changes with every push and drop, in any worktree");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });

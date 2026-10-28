import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { commitCommands, newRefProblem, parseRefNames, rewordMessage, stoppedReason } from "./commitActionModel";
import { gitEnv, makeRepo } from "./fixtures";

const SHA = "a".repeat(40);
const ID = { GIT_AUTHOR_NAME: "dana", GIT_AUTHOR_EMAIL: "dana@example.com", GIT_COMMITTER_NAME: "dana", GIT_COMMITTER_EMAIL: "dana@example.com" };

{
  assert.deepStrictEqual(commitCommands.cherryPick(SHA, false), ["cherry-pick", SHA]);
  assert.deepStrictEqual(commitCommands.cherryPick(SHA, true), ["cherry-pick", "-m", "1", SHA]);
  assert.deepStrictEqual(commitCommands.revert(SHA, false), ["revert", "--no-edit", SHA]);
  assert.deepStrictEqual(commitCommands.revert(SHA, true), ["revert", "--no-edit", "-m", "1", SHA]);
  assert.deepStrictEqual(commitCommands.reset(SHA, "hard"), ["reset", "--hard", SHA, "--"]);
  assert.deepStrictEqual(commitCommands.checkout(SHA), ["checkout", "--detach", SHA, "--"]);
  assert.deepStrictEqual(commitCommands.newBranch(SHA, "acme/fix"), ["checkout", "-b", "acme/fix", SHA, "--"]);
  assert.deepStrictEqual(commitCommands.newTag(SHA, "v1.4.0"), ["tag", "v1.4.0", SHA]);
  assert.deepStrictEqual(commitCommands.undo(SHA), ["reset", "--soft", `${SHA}~1`, "--"]);
  assert.deepStrictEqual(commitCommands.reword(), ["commit", "--amend", "--only", "--allow-empty", "--file=-"]);
  assert.strictEqual(rewordMessage("old subject\n\nbody line\n\nCo-Authored-By: Rin\n", " new subject "), "new subject\n\nbody line\n\nCo-Authored-By: Rin\n");
  assert.strictEqual(rewordMessage("only a subject\n", "renamed"), "renamed\n");
  assert.strictEqual(rewordMessage("crlf\r\n\r\nbody\r\n", "lf"), "lf\n\nbody\n");
  assert.throws(() => commitCommands.cherryPick("--abort", false), "a non-hash never reaches git");
  assert.throws(() => commitCommands.newTag(SHA, "-d"), "an option-like name never reaches git");
  assert.throws(() => commitCommands.newBranch(SHA, "a..b"));
  console.log("ok - commit actions build explicit argv and refuse anything that could read as an option");
}

{
  assert.strictEqual(newRefProblem("release-1.4", ["main"], "branch"), undefined);
  assert.strictEqual(newRefProblem(" main ", ["main"], "branch"), "A local branch with this name already exists.");
  assert.strictEqual(newRefProblem("v1.4", ["v1.4"], "tag"), "A tag with this name already exists.");
  assert.strictEqual(newRefProblem("bad name", [], "tag"), "Enter a valid tag name.");
  assert.strictEqual(newRefProblem("", [], "branch"), "Enter a valid branch name.");
  assert.deepStrictEqual(parseRefNames("v1\r\nv2\n\n"), ["v1", "v2"]);
  console.log("ok - new branch and tag names are checked against git's rules and the existing names");
}

{
  assert.match(stoppedReason("cherryPick", "error: could not apply 1234abc... feat\nhint: after resolving the conflicts")!, /cherry-pick stopped on conflicts/);
  assert.match(stoppedReason("revert", "CONFLICT (content): Merge conflict in a.txt\nerror: could not revert 1234abc")!, /revert stopped on conflicts/);
  assert.strictEqual(stoppedReason("cherryPick", "The previous cherry-pick is now empty, possibly due to conflict resolution."), "its changes are already on the checked-out branch");
  assert.strictEqual(stoppedReason("reset", "CONFLICT"), undefined, "only cherry-pick and revert stop halfway");
  assert.strictEqual(stoppedReason("revert", "fatal: bad revision"), undefined);
  console.log("ok - a cherry-pick or revert that stops on conflicts says how to finish it");
}

{
  // Real git accepts every argv, and the outcomes are what the menu promises.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "linyra-commit-actions-"));
  try {
    const root = path.join(home, "acme-api");
    makeRepo(root, [
      { time: 1000, author: "dana", message: "feat: base", files: { "a.txt": "one\n" } },
      { time: 2000, author: "rin", message: "feat: second", files: { "b.txt": "two\n" } },
      { time: 3000, author: "dana", message: "feat: third", files: { "a.txt": "three\n" } },
    ], home);
    const git = (args: string[]) => execFileSync("git", args, { cwd: root, env: { ...gitEnv(home), ...ID, LC_ALL: "C" }, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    const [third, second, base] = git(["rev-list", "HEAD"]).split("\n");
    git(commitCommands.newTag(second, "v0.2"));
    assert.strictEqual(git(["rev-parse", "v0.2^{commit}"]), second);
    git(commitCommands.newBranch(base, "acme-side"));
    assert.strictEqual(git(["branch", "--show-current"]), "acme-side");
    git(commitCommands.cherryPick(second, false));
    assert.strictEqual(git(["log", "-1", "--format=%s"]), "feat: second");
    git(commitCommands.revert(git(["rev-parse", "HEAD"]), false));
    assert.ok(!fs.existsSync(path.join(root, "b.txt")), "the revert undid the cherry-picked file");
    git(commitCommands.reset(base, "hard"));
    assert.strictEqual(git(["rev-parse", "HEAD"]), base);
    git(commitCommands.checkout(third));
    assert.strictEqual(git(["branch", "--show-current"]), "", "checkout revision detaches HEAD");
    git(["checkout", "-q", "main", "--"]);
    execFileSync("git", commitCommands.reword(), { cwd: root, input: rewordMessage(git(["log", "-1", "--format=%B"]), "feat: third, reworded"), env: { ...gitEnv(home), ...ID }, stdio: ["pipe", "pipe", "pipe"] });
    assert.strictEqual(git(["log", "-1", "--format=%s"]), "feat: third, reworded");
    assert.strictEqual(git(["rev-parse", "HEAD~1"]), second, "the amended commit keeps its parent");
    const reworded = git(["rev-parse", "HEAD"]);
    git(commitCommands.undo(reworded));
    assert.strictEqual(git(["rev-parse", "HEAD"]), second);
    assert.strictEqual(git(["diff", "--cached", "--name-only"]), "a.txt", "an undone commit's changes stay staged");
    assert.strictEqual(git(commitCommands.pushedTo(second)), "", "nothing is on a remote here");
    console.log("ok - real git: tag, branch, cherry-pick, revert, reset, checkout revision, reword and undo do what their menu items say");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

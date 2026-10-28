import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { gitCandidates } from "./gitBinary";
import { GitError, GitRunner } from "./git";

{
  assert.deepStrictEqual(gitCandidates(undefined, undefined), ["git"], "nothing configured: git from PATH");
  assert.deepStrictEqual(gitCandidates(null, "/usr/bin/git"), ["/usr/bin/git", "git"], "the path VS Code's Git extension found comes next");
  assert.deepStrictEqual(gitCandidates("/opt/git/bin/git", "/usr/bin/git"), ["/opt/git/bin/git", "/usr/bin/git", "git"], "the user's git.path wins");
  assert.deepStrictEqual(gitCandidates(["/a/git", "", "/b/git", "/a/git"], undefined), ["/a/git", "/b/git", "git"], "an array is tried in order, without blanks or repeats");
  assert.deepStrictEqual(gitCandidates(42, "git"), ["git"], "a malformed setting is ignored");
  console.log("ok - git candidates: git.path, then VS Code's git, then PATH");
}

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "linyra-gitbin-"));
  const missing = path.join(home, "no-such-git");
  {
    const runner = new GitRunner(() => [missing, "git"]);
    assert.match(await runner.run(home, ["--version"]), /^git version /, "a git.path that cannot run falls back to the next candidate");
    assert.strictEqual(runner.binary(), "git", "and remembers the one that ran");
    console.log("ok - a binary that cannot run falls back to the next candidate");
  }
  {
    const runner = new GitRunner(() => [missing]);
    await assert.rejects(runner.run(home, ["--version"]), (e: unknown) => e instanceof GitError && e.message.includes(missing), "when nothing runs, the error names what was tried");
    console.log("ok - when no candidate runs, the error names every path tried");
  }
  {
    let list = ["git"];
    const runner = new GitRunner(() => list);
    await runner.run(home, ["--version"]);
    list = [missing];
    await runner.run(home, ["--version"]).then(() => undefined, () => undefined);
    assert.strictEqual(runner.binary(), "git", "without a reset, the working binary is kept");
    runner.reset();
    await assert.rejects(runner.run(home, ["--version"]), GitError, "after reset (git.path changed), the new candidates are used");
    console.log("ok - reset picks up a changed git.path");
  }
  {
    // A repository folder that no longer exists is not a missing git.
    const runner = new GitRunner(() => ["git"]);
    await runner.run(home, ["--version"]);
    await assert.rejects(runner.run(path.join(home, "deleted-repo"), ["log"]), (e: unknown) => e instanceof GitError && /folder/i.test(e.message) && !/git\.path/.test(e.message), "the error names the missing folder, not git.path");
    assert.strictEqual(runner.binary(), "git", "and the working binary is kept");
    console.log("ok - a missing repository folder is reported as such, not as a missing git");
  }
  {
    // A repo-level git error is not a missing binary: it must not fall through to other candidates.
    const runner = new GitRunner(() => ["git"]);
    await assert.rejects(runner.run(home, ["log"]), (e: unknown) => e instanceof GitError && !e.message.includes("not found"));
    console.log("ok - a git error inside a repository is reported as is");
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

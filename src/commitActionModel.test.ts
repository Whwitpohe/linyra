import * as assert from "assert";
import { execFile, execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ALREADY_APPLIED, applyEach, commitCommands, newRefProblem, parseRefNames, rewordMessage, stoppedReason } from "./commitActionModel";
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
  // A subject's words are not git's: these stopped on conflicts.
  assert.match(stoppedReason("cherryPick", "error: could not apply ea5ad1e... Allow empty commit in parser\nhint: After resolving the conflicts, mark them with")!, /cherry-pick stopped on conflicts/);
  assert.match(stoppedReason("revert", "error: could not revert ea5ad1e... Fix \"nothing to commit\" message\nhint: After resolving the conflicts, mark them with")!, /revert stopped on conflicts/);
  assert.strictEqual(stoppedReason("revert", "On branch main\nno changes added to commit (use \"git add\" and/or \"git commit -a\")"), ALREADY_APPLIED);
  assert.strictEqual(stoppedReason("cherryPick", "error: Your local changes to the following files would be overwritten by merge:\n\tempty commit.txt\nfatal: cherry-pick failed"), undefined, "a file's name is not git's line either");
  console.log("ok - a cherry-pick or revert that stops on conflicts says how to finish it");
}

void (async () => {
  // Real git's own words: a conflict whose subject talks of empty commits is a conflict; an empty pick or revert is not.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "linyra-commit-empty-"));
  try {
    const root = path.join(home, "acme-web");
    makeRepo(root, [{ time: 1000, author: "dana", message: "feat: base", files: { "a.txt": "one\n" } }], home);
    const env = { ...gitEnv(home), ...ID, LC_ALL: "C" };
    const git = (args: string[]) => execFileSync("git", args, { cwd: root, env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    const failure = (args: string[]): string => {
      try { git(args); } catch (e) { const x = e as { stderr: string; stdout: string }; return `${x.stderr}\n${x.stdout}`; }
      throw new Error(`git ${args.join(" ")} succeeded`);
    };
    git(["checkout", "-q", "-b", "acme-side"]);
    fs.writeFileSync(path.join(root, "a.txt"), "two\n");
    git(["commit", "-q", "-am", "Allow empty commit in parser"]);
    const conflicting = git(["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(root, "b.txt"), "b\n");
    git(["add", "b.txt"]); git(["commit", "-q", "-m", "feat: b"]);
    const b = git(["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(root, "c.txt"), "c\n");
    git(["add", "c.txt"]); git(["commit", "-q", "-m", "feat: c"]);
    const c = git(["rev-parse", "HEAD"]);
    git(["checkout", "-q", "main"]);
    fs.writeFileSync(path.join(root, "a.txt"), "three\n");
    git(["commit", "-q", "-am", "feat: main's own a"]);
    assert.match(stoppedReason("cherryPick", failure(commitCommands.cherryPick(conflicting, false)))!, /stopped on conflicts/);
    git(["cherry-pick", "--abort"]);
    git(commitCommands.cherryPick(b, false));
    assert.strictEqual(stoppedReason("cherryPick", failure(commitCommands.cherryPick(b, false))), ALREADY_APPLIED);
    git(["cherry-pick", "--skip"]);
    git(commitCommands.revert(b, false));
    assert.strictEqual(stoppedReason("revert", failure(commitCommands.revert(b, false))), ALREADY_APPLIED, "a revert's empty note is git commit's status");
    git(commitCommands.cherryPick(b, false));
    console.log("ok - real git: a conflict is told from an empty cherry-pick or revert by git's own lines, not the subject");

    // [b (already on main), c]: b is skipped and c is still picked.
    const run = (args: string[]) => new Promise<string>((resolve, reject) => execFile("git", args, { cwd: root, env }, (e, stdout, stderr) => (e ? reject(Object.assign(e, { stdout, stderr })) : resolve(stdout))));
    const textOf = (e: unknown) => { const x = e as { stderr: string; stdout: string }; return `${x.stderr}\n${x.stdout}`; };
    const r = await applyEach("cherryPick", [b, c], (sha) => run(commitCommands.cherryPick(sha, false)), () => run(["cherry-pick", "--skip"]), textOf);
    assert.deepStrictEqual({ applied: r.applied, empty: r.empty, error: r.error }, { applied: 1, empty: 1, error: undefined });
    assert.strictEqual(git(["log", "-1", "--format=%s"]), "feat: c", "the commit after the empty one is picked");
    assert.ok(!fs.existsSync(path.join(root, ".git", "CHERRY_PICK_HEAD")), "nothing left in progress");
    const stop = await applyEach("cherryPick", [conflicting, c], (sha) => run(commitCommands.cherryPick(sha, false)), () => run(["cherry-pick", "--skip"]), textOf);
    assert.strictEqual(stop.applied, 0);
    assert.match(stop.reason ?? "", /stopped on conflicts/, "a conflict stops the rest, and is not skipped");
    assert.ok(fs.existsSync(path.join(root, ".git", "CHERRY_PICK_HEAD")), "the conflicted pick is left for the user");
    console.log("ok - real git: several picks skip one already on the branch and go on; a conflict stops them");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });

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

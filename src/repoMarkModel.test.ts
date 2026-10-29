import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { gitEnv, makeRepo } from "./fixtures";
import { readHead } from "./repoHead";
import { operationCommand, abortArgs, abortPrompt, continueArgs, drift, headText, markTitle, operationOf, parseHead, rebasedBranch, spokenLabel, workSuffix, type RepoMark } from "./repoMarkModel";

{
  assert.deepStrictEqual(parseHead("ref: refs/heads/develop\n"), { branch: "develop" });
  assert.deepStrictEqual(parseHead("ref: refs/heads/feature/login"), { branch: "feature/login" }, "a branch with a slash");
  assert.deepStrictEqual(parseHead(`${"a1".repeat(20)}\n`), { branch: null, detached: "a1a1a1a" }, "a commit id: detached");
  assert.strictEqual(parseHead("garbage"), undefined);
  assert.strictEqual(rebasedBranch("refs/heads/develop\n"), "develop");
  assert.strictEqual(rebasedBranch("detached HEAD\n"), null, "rebasing a detached HEAD");
  assert.strictEqual(rebasedBranch(undefined), undefined);
  const has = (...names: string[]) => (n: string) => names.includes(n);
  assert.strictEqual(operationOf(has("MERGE_HEAD")), "merge");
  assert.strictEqual(operationOf(has("rebase-merge")), "rebase");
  assert.strictEqual(operationOf(has("rebase-apply", "MERGE_HEAD")), "rebase", "a rebase replaying a merge is a rebase");
  assert.strictEqual(operationOf(has("CHERRY_PICK_HEAD")), "cherry-pick");
  assert.strictEqual(operationOf(has("REVERT_HEAD")), "revert");
  assert.strictEqual(operationOf(has("ORIG_HEAD", "FETCH_HEAD")), undefined);
  console.log("ok - HEAD, a rebase's branch and the operation are read from git's own files");
}

{
  assert.strictEqual(workSuffix(undefined), "", "not known: no mark");
  assert.strictEqual(workSuffix({ changes: false, staged: false, conflicts: 0 }), "");
  assert.strictEqual(workSuffix({ changes: true, staged: false, conflicts: 0 }), "*");
  assert.strictEqual(workSuffix({ changes: true, staged: true, conflicts: 2 }), "*+!", "as VS Code's status bar: * changes, + staged, ! conflicts");
  assert.strictEqual(headText({ branch: null, detached: "1a2b3c4" }), "detached 1a2b3c4", "never a bare id that reads like a branch");
  console.log("ok - uncommitted work is marked as VS Code's status bar marks a branch");
}

{
  const on = (branch: string | null): RepoMark => ({ branch, ...(branch === null ? { detached: "1a2b3c4" } : {}) });
  const marks = { web: on("develop"), api: on("develop"), libs: on("feature/login"), ops: on(null) };
  const d = drift(marks, ["web", "api", "libs", "ops"]);
  assert.strictEqual(d.common, "develop");
  assert.deepStrictEqual([...d.others], ["libs", "ops"], "another branch, and a detached HEAD, stand out");
  assert.deepStrictEqual([...drift(marks, ["web", "libs"]).others], [], "one each: no branch is the rest's");
  assert.strictEqual(drift(marks, ["web"]).common, null, "a single repository differs from nothing");
  assert.deepStrictEqual([...drift({ ...marks, x: on("feature/login") }, ["web", "api", "libs", "x"]).others], [], "a tie marks nothing");
  assert.deepStrictEqual([...drift(marks, ["web", "api", "libs", "gone"]).others], ["libs"], "a repository not read yet is not marked");
  console.log("ok - the branch most ticked repositories are on, and those on another");
}

{
  const m: RepoMark = { branch: "feature/login", operation: "merge", work: { changes: true, staged: true, conflicts: 2 } };
  assert.deepStrictEqual(markTitle(m, "develop"), [
    "On branch feature/login",
    "Most of the ticked repositories are on develop.",
    "Uncommitted: modified (*), staged (+)",
    "Merge stopped: 2 files have conflicts (!). Right-click to resolve, continue or abort.",
  ]);
  assert.strictEqual(spokenLabel(["acme-libs", ...markTitle(m, "develop"), "2 commits not pushed"]),
    "acme-libs, On branch feature/login, Most of the ticked repositories are on develop. Uncommitted: modified, staged, Merge stopped: 2 files have conflicts. Right-click to resolve, continue or abort. 2 commits not pushed",
    "spoken: no glyphs, a comma only where no sentence ends");
  assert.strictEqual(spokenLabel(["acme-web", "", "位于分支 develop", "勾选的仓库大多在 main 上。", "已修改 (*)"]), "acme-web, 位于分支 develop, 勾选的仓库大多在 main 上。 已修改");
  assert.deepStrictEqual(markTitle({ branch: null, detached: "1a2b3c4", operation: "rebase", work: { changes: false, staged: false, conflicts: 0 } }, null), [
    "HEAD detached at 1a2b3c4", "Rebase stopped. Right-click to continue or abort.",
  ]);
  assert.deepStrictEqual(continueArgs("cherry-pick"), ["cherry-pick", "--continue"]);
  assert.deepStrictEqual(abortArgs("rebase"), ["rebase", "--abort"]);
  assert.strictEqual(abortPrompt("merge", ["acme-web"]).message, "Abort the merge in acme-web?");
  assert.strictEqual(abortPrompt("rebase", ["acme-web", "acme-api"]).message, "Abort the rebase in 2 repositories?");
  assert.strictEqual(abortPrompt("revert", ["acme-web"]).button, "Abort Revert");
  console.log("ok - the tooltip, git's --continue and --abort, and Abort's confirmation");
}

void (async () => {
  // Real git: a merge, a rebase, a cherry-pick and a revert that stop on a conflict, a detached
  // HEAD and a linked worktree, each read from the git dir's files.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "linyra-marks-"));
  const ID = { GIT_AUTHOR_NAME: "dana", GIT_AUTHOR_EMAIL: "dana@example.com", GIT_COMMITTER_NAME: "dana", GIT_COMMITTER_EMAIL: "dana@example.com" };
  const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env: { ...gitEnv(home), ...ID, LC_ALL: "C", GIT_EDITOR: ":" }, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  const stops = (cwd: string, args: string[]) => {
    try { git(cwd, args); } catch { return; }
    throw new Error(`expected ${args.join(" ")} to stop on a conflict`);
  };
  try {
    const repo = path.join(home, "acme-web");
    makeRepo(repo, [{ time: 1000, author: "dana", message: "feat: base", files: { "a.txt": "one\n" } }], home);
    const main = git(repo, ["branch", "--show-current"]);
    git(repo, ["checkout", "-q", "-b", "feature/login"]);
    fs.writeFileSync(path.join(repo, "a.txt"), "feature\n");
    git(repo, ["commit", "-qam", "feat: feature side"]);
    git(repo, ["checkout", "-q", main]);
    fs.writeFileSync(path.join(repo, "a.txt"), "main\n");
    git(repo, ["commit", "-qam", "feat: main side"]);
    assert.deepStrictEqual(await readHead(repo), { branch: main });

    stops(repo, ["merge", "feature/login"]);
    assert.deepStrictEqual(await readHead(repo), { branch: main, operation: "merge" });
    git(repo, ["merge", "--abort"]);

    git(repo, ["checkout", "-q", "feature/login"]);
    stops(repo, ["rebase", main]);
    assert.deepStrictEqual(await readHead(repo), { branch: "feature/login", detached: (await readHead(repo))?.detached, operation: "rebase" }, "a rebase names the branch it rebases");
    git(repo, ["rebase", "--abort"]);
    assert.deepStrictEqual(await readHead(repo), { branch: "feature/login" });

    stops(repo, ["cherry-pick", main]);
    assert.strictEqual((await readHead(repo))?.operation, "cherry-pick");
    git(repo, ["cherry-pick", "--abort"]);

    git(repo, ["checkout", "-q", main]);
    fs.writeFileSync(path.join(repo, "a.txt"), "main again\n");
    git(repo, ["commit", "-qam", "feat: main again"]);
    stops(repo, ["revert", "--no-edit", "HEAD~1"]);
    assert.strictEqual((await readHead(repo))?.operation, "revert");
    git(repo, ["revert", "--abort"]);

    git(repo, ["checkout", "-q", "--detach", "HEAD"]);
    const detached = await readHead(repo);
    assert.strictEqual(detached?.branch, null);
    assert.strictEqual(detached?.detached, git(repo, ["rev-parse", "--short=7", "HEAD"]));
    git(repo, ["checkout", "-q", main]);

    // git am stopped on a patch that does not apply: its own session, not a rebase.
    const patchText = git(repo, ["format-patch", "--stdout", "-1", "feature/login"]);
    git(repo, ["checkout", "-q", main]);
    try { execFileSync("git", ["am", "--quiet"], { cwd: repo, input: patchText, env: { ...gitEnv(home), ...ID, LC_ALL: "C" }, stdio: ["pipe", "pipe", "pipe"] }); } catch { /* stops: expected */ }
    assert.strictEqual((await readHead(repo))?.operation, "am", "rebase-apply/applying: git am");
    git(repo, ["am", "--abort"]);
    assert.strictEqual((await readHead(repo))?.operation, undefined);

    const linked = path.join(home, "acme-web-hotfix");
    git(repo, ["worktree", "add", "-q", "-b", "hotfix", linked]);
    assert.deepStrictEqual(await readHead(linked), { branch: "hotfix" }, "a linked worktree: .git is a file");
    assert.strictEqual(await readHead(home), undefined, "not a repository");
    console.log("ok - real git: merge, rebase, cherry-pick and revert stopped; detached; a linked worktree");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });

{
  assert.deepStrictEqual([operationCommand("merge", "continue"), operationCommand("cherry-pick", "abort"), operationCommand("am", "continue"), operationCommand("rebase", "resolve")],
    ["linyra.continueMerge", "linyra.abortCherryPick", "linyra.continueAm", "linyra.resolveConflicts"]);
  console.log("ok - a stopped operation's commands, by name");
}

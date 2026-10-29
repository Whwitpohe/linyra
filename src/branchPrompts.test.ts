import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { reasonOf } from "./actionErrors";
import { branchDone, branchFailed, deleteAnywayPrompt, deletePrompt, distanceArgs, integratePrompt, parseDistance, stashFailed, unmergedArgs } from "./branchPrompts";
import { commitFailed, resetDistanceArgs, resetPrompt } from "./commitActionModel";
import { gitEnv, makeRepo } from "./fixtures";

{
  // What happens, not a rule.
  assert.deepStrictEqual(deletePrompt({ name: "feature/x", kind: "local", upstream: "origin/feature/x" }, "acme-web"),
    { message: "Delete branch feature/x in acme-web?", detail: "The local branch is deleted. Its remote branch origin/feature/x stays.", button: "Delete" });
  assert.match(deletePrompt({ name: "feature/x", kind: "local" }, "acme-web").detail, /stay on the other branches and tags/);
  assert.strictEqual(deletePrompt({ name: "origin/feature/x", kind: "remote", remote: "origin", remoteBranch: "feature/x" }, "acme-web").message, "Delete feature/x on the remote origin?");
  // Not merged (after a squash merge): into what, and how many commits are on nothing else, on the button.
  const anyway = deleteAnywayPrompt("feature/x", "main", "acme-web", 4);
  assert.strictEqual(anyway.message, "feature/x is not merged into main in acme-web.");
  assert.strictEqual(anyway.button, "Delete Anyway (4 commits not merged anywhere)");
  assert.match(anyway.detail, /4 commits on it are on no other branch[\s\S]*squash merge/);
  assert.strictEqual(deleteAnywayPrompt("feature/x", "main", "acme-web", 0).button, "Delete Anyway");
  assert.deepStrictEqual(unmergedArgs("feature/x"), ["rev-list", "--count", "refs/heads/feature/x", "--not", "--exclude=feature/x", "--branches", "--remotes", "--tags", "--"]);
  console.log("ok - Delete Branch says what goes and what stays; an unmerged branch says how much is on nothing else");
}

{
  // Merge / Rebase: the button says the action (never "Continue"), the detail what moves.
  assert.deepStrictEqual(parseDistance("2\t4\n"), { ours: 2, theirs: 4 });
  assert.deepStrictEqual(distanceArgs("refs/heads/feature/x"), ["rev-list", "--left-right", "--count", "HEAD...refs/heads/feature/x", "--"]);
  assert.deepStrictEqual(integratePrompt("merge", "main", "feature/x", "acme-web", { ours: 2, theirs: 4 }), {
    message: "Merge feature/x into main in acme-web?", detail: "main gets 4 commits from feature/x; if files conflict the merge stops for you to resolve.", button: "Merge" });
  const rebase = integratePrompt("rebase", "main", "feature/x", "acme-web", { ours: 2, theirs: 4 });
  assert.ok(!("nothing" in rebase));
  assert.strictEqual(rebase.button, "Rebase");
  assert.strictEqual(rebase.detail, "Your 2 commits on main are replayed on top of feature/x (4 commits); if files conflict the rebase stops for you to resolve.");
  assert.match((integratePrompt("rebase", "main", "feature/x", "acme-web", { ours: 0, theirs: 1 }) as { detail: string }).detail, /no commits of its own: it moves up to feature\/x \(1 commit\)/);
  assert.deepStrictEqual(integratePrompt("merge", "main", "feature/x", "acme-web", { ours: 3, theirs: 0 }), { nothing: "main already has every commit of feature/x in acme-web: nothing to merge." });
  assert.strictEqual((integratePrompt("merge", "main", "x", "acme-web", undefined) as { detail: string }).detail, "main gets the commits from x; if files conflict the merge stops for you to resolve.");
  console.log("ok - Merge and Rebase name what moves, and their buttons say Merge and Rebase");
}

{
  // The action, the repository, why, and what to do next.
  assert.strictEqual(branchFailed("push", "feature/x", "acme-web", reasonOf(" ! [rejected] feature/x -> feature/x (fetch first)\nerror: failed to push some refs")),
    "Could not push feature/x in acme-web: the remote has commits you do not have: run Update Project, then push again.");
  assert.strictEqual(branchFailed("checkout", "release-1.4", "acme-api", reasonOf("error: Your local changes to the following files would be overwritten by checkout")),
    "Could not check out release-1.4 in acme-api: local changes to the same files: commit or stash them first.");
  assert.strictEqual(branchFailed("upstream", "main", "acme-api", reasonOf("fatal: something new.")), "Could not finish that for main in acme-api: something new.");
  assert.strictEqual(stashFailed("pop", "stash@{0}", "acme-web", "the stash is kept"), "Could not pop stash@{0} in acme-web: the stash is kept.");
  assert.strictEqual(commitFailed("cherryPick", "1a2b3c4", "acme-web", "files conflict"), "Could not cherry-pick 1a2b3c4 in acme-web: files conflict.");
  assert.strictEqual(branchDone("push", { name: "feature/x", to: "origin/feature/x", repo: "acme-web" }), "Linyra: pushed feature/x to origin/feature/x in acme-web.");
  assert.strictEqual(branchDone("rebase", { name: "main", current: "feature/x", repo: "acme-web" }), "Linyra: rebased feature/x onto main in acme-web.");
  assert.strictEqual(branchDone("view", { name: "main", repo: "acme-web" }), undefined, "reading says nothing");
  console.log("ok - a branch, commit or stash action's error names the action and the repository, and what to do");
}

{
  const sha = "a".repeat(40);
  assert.deepStrictEqual(resetDistanceArgs(sha, "origin/main"), ["rev-list", "--left-right", "--count", `HEAD...${sha}`, "--not", "refs/remotes/origin/main", "--"], "pushed: on the upstream");
  assert.deepStrictEqual(resetDistanceArgs(sha, ""), ["rev-list", "--left-right", "--count", `HEAD...${sha}`, "--not", "--remotes", "--"], "no upstream: on any remote");
  assert.deepStrictEqual(resetDistanceArgs(sha), ["rev-list", "--left-right", "--count", `HEAD...${sha}`, "--"]);
  const hard = resetPrompt({ branch: "main", target: "1a2b3c4", repo: "acme-web", mode: "hard", leaving: 4, pushed: 2, upstream: "origin/main", arriving: 0 });
  assert.strictEqual(hard.message, "Reset main to 1a2b3c4 in acme-web?");
  assert.match(hard.detail, /^4 commits leave main \(2 already pushed to origin\/main\)\.\nUncommitted changes are deleted\. This cannot be undone\.\n/);
  assert.match(hard.detail, /next push needs a force push/);
  assert.strictEqual(hard.button, "Reset and Delete Changes");
  const soft = resetPrompt({ branch: "main", target: "1a2b3c4", repo: "acme-web", mode: "soft", leaving: 1, pushed: 0, arriving: 0 });
  assert.strictEqual(soft.detail, "1 commit leaves main.\nTheir changes stay in your files, staged.");
  assert.strictEqual(soft.button, "Reset");
  // A commit off the branch: what arrives too.
  assert.match(resetPrompt({ branch: "main", target: "9f8e7d6", repo: "acme-web", mode: "mixed", leaving: 2, pushed: 0, arriving: 3 }).detail, /2 commits leave main\.\nmain gets 3 commits from 9f8e7d6\.\nTheir changes stay in your files, unstaged\./);
  console.log("ok - Reset says how many commits leave the branch and how many of them are pushed");
}

{
  // Real git: a squash-merged branch's commits are on nothing else; one merged normally has none.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "linyra-branch-prompts-"));
  const ID = { GIT_AUTHOR_NAME: "dana", GIT_AUTHOR_EMAIL: "dana@example.com", GIT_COMMITTER_NAME: "dana", GIT_COMMITTER_EMAIL: "dana@example.com" };
  const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env: { ...gitEnv(home), ...ID, LC_ALL: "C" }, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  try {
    const repo = path.join(home, "acme-web");
    makeRepo(repo, [{ time: 1000, author: "dana", message: "feat: base", files: { "a.txt": "1\n" } }], home);
    git(repo, ["branch", "-M", "main"]);
    git(repo, ["switch", "-q", "-c", "feature/x"]);
    for (const n of [2, 3]) { fs.writeFileSync(path.join(repo, `f${n}.txt`), `${n}\n`); git(repo, ["add", "."]); git(repo, ["commit", "-q", "-m", `feat: ${n}`]); }
    git(repo, ["switch", "-q", "main"]);
    git(repo, ["merge", "-q", "--squash", "feature/x"]);
    git(repo, ["commit", "-q", "-m", "feat: x, squashed"]);
    assert.strictEqual(git(repo, unmergedArgs("feature/x")), "2", "squashed: its two commits are on nothing else");
    assert.throws(() => git(repo, ["branch", "-d", "feature/x"]), /not fully merged/);
    assert.deepStrictEqual(parseDistance(git(repo, distanceArgs("feature/x"))), { ours: 1, theirs: 2 });
    git(repo, ["tag", "keep", "feature/x"]);
    assert.strictEqual(git(repo, unmergedArgs("feature/x")), "0", "a tag keeps them");
    console.log("ok - real git: an unmerged branch's commits on nothing else are counted, a tag or branch keeps them");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

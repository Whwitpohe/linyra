import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { acrossActions, acrossRow, acrossState, acrossSummary, acrossText, nextSteps, parseSheetRef, sheetRefArgs, targetCard, upstreamCard, type AcrossRow, type BranchSheetData } from "./branchSheetModel";
import { gitEnv, makeRepo } from "./fixtures";

const base: BranchSheetData = { repoId: "/w/acme-web", repoName: "acme-web", ref: "refs/heads/develop", name: "develop", kind: "local", current: true, tip: { sha: "a".repeat(40), subject: "s", author: "dana", time: 1 }, ai: false };
const labels = (c: ReturnType<typeof upstreamCard>) => c?.buttons.map((b) => `${b.label}${b.primary ? "*" : ""}`);

{
  const up = (u: Partial<NonNullable<BranchSheetData["upstream"]>>, current = true) => upstreamCard({ ...base, current, upstream: { name: "origin/develop", ahead: 0, behind: 0, gone: false, ...u } });
  assert.deepStrictEqual([up({})?.chip?.text, up({})?.status, labels(up({}))], ["Up to date", "As of the last fetch.", ["Fetch"]]);
  assert.deepStrictEqual([up({ ahead: 3 })?.chip, up({ ahead: 3 })?.status, labels(up({ ahead: 3 }))], [undefined, "3 commits to push.", ["Push*", "Fetch"]], "the count is said once, in the status");
  assert.deepStrictEqual(labels(up({ behind: 1 })), ["Pull*", "Fetch"]);
  assert.deepStrictEqual([labels(up({ behind: 1 }, false)), up({ behind: 1 }, false)?.hint], [["Fetch"], "Check it out to pull."], "only a checked-out branch pulls");
  const diverged = up({ ahead: 2, behind: 1 });
  assert.deepStrictEqual([diverged?.chip, diverged?.status, labels(diverged)], [{ text: "Diverged", tone: "bad" }, "2 commits to push · 1 to pull.", ["Pull*", "Force Push…", "Fetch"]]);
  assert.deepStrictEqual(labels(up({ ahead: 2, behind: 1 }, false)), ["Force Push…", "Fetch"]);
  assert.deepStrictEqual([up({ gone: true })?.chip?.text, labels(up({ gone: true }))], ["Gone", ["Publish"]], "gone: Publish is not pressed on, it is usually merged");
  assert.deepStrictEqual(labels(up({ gone: true }, false)), ["Delete Branch…", "Publish"], "gone and not checked out: clean it up");
  assert.deepStrictEqual([up({ name: null })?.status, up({ name: null })?.subject, labels(up({ name: null }))], ["Not published.", undefined, ["Publish*", "Set Upstream…"]]);
  assert.strictEqual(upstreamCard({ ...base, kind: "remote" }), undefined, "a remote branch has no upstream card");
  // The upstream's name links to its own sheet; the pencil changes it. Not published: Set Upstream… beside Publish.
  const linked = upstreamCard({ ...base, upstream: { name: "origin/develop", ref: "refs/remotes/origin/develop", ahead: 0, behind: 0, gone: false } });
  assert.deepStrictEqual([linked?.subjectRef, linked?.edit], ["refs/remotes/origin/develop", { action: "setUpstream", label: "Change Upstream…" }]);
  assert.deepStrictEqual([up({ name: null })?.edit, labels(up({ name: null }))], [undefined, ["Publish*", "Set Upstream…"]]);
  console.log("ok - the upstream card: each state's chip, status and buttons, Pull only where it is checked out");
}

{
  const t = (x: Partial<NonNullable<BranchSheetData["target"]>>, current = true) => targetCard({ ...base, current, target: { name: "origin/main", ahead: 4, behind: 0, ...x } });
  assert.deepStrictEqual([t({})?.chip, t({})?.status, labels(t({}))], [undefined, "4 commits not on origin/main.", ["Review"]]);
  assert.strictEqual(t({ ahead: 1, behind: 3 })?.status, "1 commit not on origin/main · 3 behind.");
  assert.deepStrictEqual([t({ behind: 3, conflicts: 2 })?.chip, t({ behind: 3, conflicts: 2 })?.hint], [{ text: "2 files conflict", tone: "bad" }, "Merging it in stops on them to resolve."]);
  assert.strictEqual(t({ behind: 3, conflicts: 1 })?.chip?.text, "1 file conflicts");
  assert.deepStrictEqual(t({ behind: 3, conflicts: 0 })?.chip, { text: "No conflicts", tone: "good" });
  assert.deepStrictEqual(t({ behind: 3, conflicts: null })?.chip?.text, "Conflicts unknown");
  assert.strictEqual(t({ behind: 3 })?.chip, undefined, "not checked: no chip");
  assert.deepStrictEqual(labels(t({ behind: 3 })), ["Merge*", "Rebase", "Review"]);
  assert.deepStrictEqual(labels(t({ behind: 3 }, false)), ["Review"], "Merge and Rebase need it checked out");
  assert.deepStrictEqual([t({ ahead: 0 }, false)?.chip?.text, t({ ahead: 0 }, false)?.hint, labels(t({ ahead: 0 }, false))], ["Merged", "Safe to delete.", ["Delete Branch…"]]);
  assert.deepStrictEqual(labels(t({ ahead: 0 })), [], "the checked-out branch is not offered for deletion");
  assert.strictEqual(t({})?.subjectRef, "refs/remotes/origin/main", "the target's name links to its sheet");
  console.log("ok - the merge target card: new commits, behind with the merge check, merged and safe to delete");
}

{
  const texts = (d: BranchSheetData) => nextSteps(d).map((s) => s.text);
  const always = ["Show only its history in the Log", "Compare it with another branch"];
  assert.deepStrictEqual(texts(base), [...always, "Create a branch from it"], "checked out and up to date: never nothing next");
  assert.deepStrictEqual(texts({ ...base, ai: true }), [...always, "Create a branch from it"], "nothing to push: nothing to explain");
  assert.deepStrictEqual(texts({ ...base, ai: true, upstream: { name: "origin/develop", ahead: 2, behind: 0, gone: false } }), ["Explain the unpushed commits", ...always, "Create a branch from it"]);
  assert.deepStrictEqual(texts({ ...base, current: false, ai: true }), ["Switch to it", "Explain what it changes", ...always]);
  assert.deepStrictEqual(texts({ ...base, current: false, ai: true, target: { name: "origin/main", ahead: 0, behind: 2 } }), always, "merged: switching to it or explaining it changes nothing");
  assert.deepStrictEqual(texts({ ...base, current: false, worktree: "D:\\work\\acme-web-hotfix\\" }), ["Checked out in worktree acme-web-hotfix", ...always]);
  assert.deepStrictEqual(texts({ ...base, kind: "remote", name: "origin/x", current: false, ai: true }), ["Check it out as a local branch", "Fetch it from its remote", "Review it against the checked-out branch", always[0]]);
  assert.deepStrictEqual(texts({ ...base, kind: "tag", name: "v1.4.0", current: false }), ["Check it out (detached HEAD)", "Create a branch from it", "Push it to a remote", always[0]]);
  // Each step has its icon and runs one command.
  assert.deepStrictEqual(nextSteps(base).map((s) => [s.icon, s.action, s.label]), [["history", "history", "Show History"], ["git-compare", "compareWith", "Compare…"], ["git-branch", "createBranch", "Create Branch…"]]);
  console.log("ok - the next steps: switch, the worktree that has it, review and explain; a tag's own");
}

{
  // Real git: the one for-each-ref line of a local branch (diverged, then gone), a remote branch and an annotated tag.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "linyra-sheet-"));
  const ID = { GIT_AUTHOR_NAME: "dana", GIT_AUTHOR_EMAIL: "dana@example.com", GIT_COMMITTER_NAME: "dana", GIT_COMMITTER_EMAIL: "dana@example.com" };
  const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env: { ...gitEnv(home), ...ID, LC_ALL: "C" }, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  try {
    const seed = path.join(home, "seed");
    makeRepo(seed, [{ time: 1000, author: "dana", message: "feat: base", files: { "a.txt": "1\n" } }], home);
    git(seed, ["branch", "-M", "main"]);
    const origin = path.join(home, "origin.git");
    git(home, ["clone", "-q", "--bare", seed, origin]);
    const web = path.join(home, "acme-web");
    git(home, ["clone", "-q", origin, web]);
    git(web, ["switch", "-q", "-c", "develop"]);
    git(web, ["push", "-q", "-u", "origin", "develop"]);
    fs.writeFileSync(path.join(web, "b.txt"), "2\n");
    git(web, ["add", "b.txt"]); git(web, ["commit", "-q", "-m", "feat: mine"]);
    git(web, ["update-ref", "refs/remotes/origin/develop", git(web, ["commit-tree", "-p", "HEAD~1", "-m", "feat: theirs", "HEAD~1^{tree}"])]);
    const read = (ref: string) => parseSheetRef(git(web, sheetRefArgs(ref)), ref);
    const dev = read("refs/heads/develop");
    assert.deepStrictEqual(dev && { kind: dev.kind, name: dev.name, current: dev.current, upstream: dev.upstream, ahead: dev.ahead, behind: dev.behind, gone: dev.gone, subject: dev.subject, author: dev.author },
      { kind: "local", name: "develop", current: true, upstream: "origin/develop", ahead: 1, behind: 1, gone: false, subject: "feat: mine", author: "dana" });
    assert.strictEqual(dev?.upstreamRef, "refs/remotes/origin/develop", "the upstream's full name, for its link");
    assert.strictEqual(dev?.sha, git(web, ["rev-parse", "HEAD"]));
    assert.ok(dev?.worktree && path.resolve(dev.worktree).toLowerCase() === path.resolve(web).toLowerCase(), "checked out here: its worktree is this folder");
    assert.strictEqual(read("refs/heads/main")?.current, false);
    git(web, ["update-ref", "-d", "refs/remotes/origin/develop"]);
    assert.strictEqual(read("refs/heads/develop")?.gone, true, "the upstream's branch is gone");
    git(web, ["branch", "-q", "--unset-upstream", "develop"]);
    assert.strictEqual(read("refs/heads/develop")?.upstream, null, "not published");
    assert.deepStrictEqual(read("refs/remotes/origin/main") && { kind: read("refs/remotes/origin/main")!.kind, name: read("refs/remotes/origin/main")!.name }, { kind: "remote", name: "origin/main" });
    git(web, ["tag", "-a", "-m", "Release 1.4", "v1.4.0", "HEAD~1"]);
    const tag = read("refs/tags/v1.4.0");
    assert.deepStrictEqual(tag && { kind: tag.kind, sha: tag.sha, subject: tag.subject }, { kind: "tag", sha: git(web, ["rev-parse", "HEAD~1"]), subject: "feat: base" }, "an annotated tag: its commit, not the tag object");
    assert.strictEqual(read("refs/heads/nope"), undefined);
    console.log("ok - real git: one for-each-ref line for a branch (diverged, gone, unpublished), a remote branch and a tag");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

{
  const r = (name: string, x: Partial<AcrossRow>) => ({ repoId: `/w/${name}`, repoName: name, has: true, upstream: "origin/develop", ahead: 0, behind: 0, ...x });
  const rows = [r("acme-web", { current: true, ahead: 2 }), r("acme-api", { behind: 3 }), r("acme-libs", { ahead: 1, behind: 1 }), r("acme-docs", {}), { repoId: "/w/acme-svc", repoName: "acme-svc", has: false }];
  assert.deepStrictEqual(rows.map((x) => acrossText("local", x)), ["↑2", "↓3", "↑1 ↓1 diverged", "up to date", "not on a remote"]);
  assert.strictEqual(acrossSummary("local", "develop", rows), "develop is in 4 of 5 repositories: 1 checked out · 1 with commits to push · 1 with commits to pull · 1 diverged.");
  assert.strictEqual(acrossSummary("local", "develop", [r("acme-web", {}), r("acme-api", {})]), "develop is in 2 of 2 repositories, all up to date.");
  assert.strictEqual(acrossSummary("tag", "v1.4.0", rows), "v1.4.0 is in 4 of 5 repositories.");
  assert.strictEqual(acrossSummary("local", "spike", [{ repoId: "/w/a", repoName: "a", has: false }]), "spike is in no other ticked repository.");
  assert.deepStrictEqual([acrossState("local", r("x", { gone: true })), acrossState("remote", r("x", { ahead: 3 }))], ["gone", "present"]);
  assert.deepStrictEqual(acrossActions("local", rows).map((a) => a.action), ["acrossCheckout", "pushAll", "updateProject"]);
  assert.deepStrictEqual(acrossActions("local", [r("acme-web", { current: true })]), [], "checked out everywhere, nothing to push or pull: nothing to do");
  assert.deepStrictEqual(acrossActions("tag", rows), []);
  assert.deepStrictEqual(acrossRow({ id: "/w/a", name: "a" }, undefined), { repoId: "/w/a", repoName: "a", has: false });
  // A read that failed is not "Not in": the row and the summary say it could not be read.
  const failed = acrossRow({ id: "/w/b", name: "b" }, undefined, true);
  assert.deepStrictEqual(failed, { repoId: "/w/b", repoName: "b", has: false, unreadable: true });
  assert.strictEqual(acrossSummary("local", "develop", [r("acme-web", {}), failed]), "develop is in 1 of 2 repositories, all up to date. 1 repository could not be read.");
  assert.strictEqual(acrossSummary("tag", "v1.4.0", [failed, { ...failed, repoId: "/w/c" }]), "v1.4.0 is in no other ticked repository. 2 repositories could not be read.");
  console.log("ok - Across repositories: each repository's state, the one-line summary, and what it offers");
}

import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { branchArgs, parseBranches, type Branches } from "./branchModel";
import { gitEnv, makeRepo } from "./fixtures";
import { branchMatches, checkoutStep, forcePushPrompt, isProtected, multiCommands, parseOutgoing, pushPlan, sharedBranches, tagRemote, updateReason } from "./multiRepoModel";

const sha = "a".repeat(40);
const line = (...fields: string[]) => fields.join("\0");
const listing = (lines: string[], remotes: string[]): Branches => parseBranches(lines.join("\n"), remotes);

{
  const web = listing([line("refs/heads/main", sha, "*", "origin/main", "", "", ""), line("refs/heads/release-1.4", sha, " ", "", "", "", ""),
    line("refs/remotes/origin/main", sha, " ", "", "", "", ""), line("refs/remotes/origin/HEAD", sha, " ", "", "", "refs/remotes/origin/main", "")], ["origin"]);
  const api = listing([line("refs/heads/main", sha, "*", "", "", "", ""), line("refs/remotes/origin/release-1.4", sha, " ", "", "", "", "")], ["origin"]);
  const libs = listing([line("refs/heads/main", sha, " ", "", "", "", ""), line("refs/heads/release-1.4", sha, "*", "", "", "", ""),
    line("refs/remotes/origin/release-1.4", sha, " ", "", "", "", ""), line("refs/remotes/team/release-1.4", sha, " ", "", "", "", "")], ["origin", "team"]);
  assert.deepStrictEqual(sharedBranches([web, api, libs]), [{ name: "main", repos: 3 }, { name: "release-1.4", repos: 3 }]);
  assert.deepStrictEqual([web, api, libs].map((d) => checkoutStep(d, "release-1.4")), ["local", "track", "current"]);
  assert.strictEqual(checkoutStep(api, "acme-missing"), "missing");
  const twoRemotes = listing([line("refs/remotes/origin/x", sha, " ", "", "", "", ""), line("refs/remotes/team/x", sha, " ", "", "", "", "")], ["origin", "team"]);
  assert.strictEqual(checkoutStep(twoRemotes, "x"), "missing", "ambiguous across remotes: git would not guess, neither do we");
  assert.deepStrictEqual(pushPlan(web), { branch: "main", remote: "origin", destination: "main", setUpstream: false });
  assert.deepStrictEqual(pushPlan(api), { branch: "main", remote: "origin", destination: "main", setUpstream: true });
  assert.strictEqual(pushPlan(listing([line("refs/heads/main", sha, "*", "", "", "", "")], [])), undefined, "no remote: nothing to push to");
  assert.throws(() => multiCommands.checkout("--orphan"));
  assert.deepStrictEqual(parseOutgoing("abc1234\0feat: one\r\ndef5678\0fix: two\n"), [{ sha: "abc1234", subject: "feat: one" }, { sha: "def5678", subject: "fix: two" }]);
  assert.strictEqual(updateReason("CONFLICT (content): Merge conflict in a.txt"), "conflicts: resolve them in Source Control, or abort");
  assert.strictEqual(updateReason("error: cannot rebase: You have unstaged changes."), "local changes: the rebase needs a clean working tree");
  console.log("ok - shared branch names, checkout steps and push targets are planned per repository");
}

{
  const data = listing([line("refs/heads/develop", sha, "*", "origin/develop", "[ahead 1, behind 2]", "", ""), line("refs/remotes/origin/develop", "b".repeat(40), " ", "", "", "", "")], ["origin"]);
  assert.deepStrictEqual(pushPlan(data), { branch: "develop", remote: "origin", destination: "develop", setUpstream: false, lease: "b".repeat(40), behind: 2 }, "diverged: leased on the remote branch's commit");
  const ahead = listing([line("refs/heads/develop", sha, "*", "origin/develop", "[ahead 1]", "", ""), line("refs/remotes/origin/develop", "b".repeat(40), " ", "", "", "", "")], ["origin"]);
  assert.strictEqual(pushPlan(ahead)?.lease, undefined, "only ahead: a plain push");
  assert.deepStrictEqual(multiCommands.push("origin", "develop", "develop", false, "b".repeat(40)),
    ["push", "--quiet", `--force-with-lease=refs/heads/develop:${"b".repeat(40)}`, "--", "origin", "refs/heads/develop:refs/heads/develop"]);
  assert.throws(() => multiCommands.push("origin", "develop", "develop", false, "HEAD"), /not a commit id/);
  assert.ok(branchMatches("release/*", "release/1.4"));
  assert.ok(!branchMatches("release/*", "release/1.4/hotfix"), "* stays within a segment");
  assert.ok(branchMatches("release/**", "release/1.4/hotfix"));
  assert.ok(branchMatches("v?.x", "v1.x"));
  assert.ok(!branchMatches("main", "main2"));
  assert.ok(isProtected("main", []) && isProtected("master", []) && !isProtected("develop", []));
  assert.ok(isProtected("release/1.4", ["release/*"]));
  const mine = { sha: "1a2b3c4", author: "dana", email: "dana@example.com", subject: "feat: before the amend" };
  const theirs = { sha: "5d6e7f8", author: "rin", email: "rin@example.com", subject: "fix: rin's work" };
  const one = forcePushPrompt([{ repo: "acme-web", branch: "develop", target: "origin/develop", behind: 1, dropped: [mine], me: "DANA@example.com" }]);
  assert.strictEqual(one.message, "Force push develop to origin/develop in acme-web?");
  assert.strictEqual(one.button, "Force Push", "only my own commits: the plain button");
  assert.match(one.detail, /acme-web: develop drops 1 commit from origin\/develop:\n  1a2b3c4  dana  feat: before the amend/);
  assert.match(one.detail, /They are all yours/);
  const two = forcePushPrompt([{ repo: "acme-web", branch: "develop", target: "origin/develop", behind: 2, dropped: [theirs, mine], me: "dana@example.com" }]);
  assert.strictEqual(two.button, "Force Push Anyway", "someone else's commit: the button says so");
  assert.match(two.detail, /1 of them are by someone else\. Pull \(merge or rebase\) keeps them/);
  assert.match(two.detail, /5d6e7f8  rin  fix: rin's work/);
  assert.match(forcePushPrompt([one, two].map((_, i) => ({ repo: `acme-${i}`, branch: "a", target: "origin/a", behind: 7, dropped: Array(7).fill(mine), me: "dana@example.com" }))).detail, /and 2 more/);
  console.log("ok - a diverged branch plans a force push with a lease; protected branches by name and glob");
  assert.deepStrictEqual(multiCommands.tag("v1.4.0", ""), ["tag", "--", "v1.4.0", "HEAD"], "no message: lightweight");
  assert.deepStrictEqual(multiCommands.tag("v1.4.0", " Release 1.4 \n"), ["tag", "-a", "-m", "Release 1.4", "--", "v1.4.0", "HEAD"]);
  assert.throws(() => multiCommands.tag("bad..name", ""), /not a valid name/);
  assert.deepStrictEqual(multiCommands.pushTag("origin", "v1.4.0"), ["push", "--quiet", "--", "origin", "refs/tags/v1.4.0"]);
  const tracked = listing([line("refs/heads/develop", sha, "*", "upstream/develop", "", "", "")], ["origin", "upstream"]);
  assert.strictEqual(tagRemote(tracked), "upstream", "the branch's upstream remote");
  assert.strictEqual(tagRemote(listing([line("refs/heads/develop", sha, "*", "", "", "", "")], ["fork", "origin"])), "origin");
  assert.strictEqual(tagRemote(listing([line("refs/heads/develop", sha, "*", "", "", "", "")], ["fork"])), "fork", "the only remote");
  assert.strictEqual(tagRemote(listing([line("refs/heads/develop", sha, "*", "", "", "", "")], ["a", "b"])), undefined);
  console.log("ok - Tag Across Repositories: annotated or lightweight, and where each repository's tag is pushed");
}

{
  // Real git: two clones of one remote; checkout, create, merge, push and update across both.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "linyra-multi-"));
  const ID = { GIT_AUTHOR_NAME: "dana", GIT_AUTHOR_EMAIL: "dana@example.com", GIT_COMMITTER_NAME: "dana", GIT_COMMITTER_EMAIL: "dana@example.com" };
  const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env: { ...gitEnv(home), ...ID, LC_ALL: "C" }, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  const fails = (cwd: string, args: string[]) => {
    try { git(cwd, args); return ""; } catch (e) { return String((e as { stderr?: unknown }).stderr ?? e); }
  };
  const read = (cwd: string) => parseBranches(git(cwd, branchArgs()), git(cwd, ["remote"]).split(/\r?\n/).filter(Boolean));
  try {
    const seed = path.join(home, "seed");
    makeRepo(seed, [{ time: 1000, author: "dana", message: "feat: base", files: { "a.txt": "one\n" } }], home);
    git(seed, ["branch", "release-1.4"]);
    const origin = path.join(home, "origin.git");
    git(home, ["clone", "-q", "--bare", seed, origin]);
    const [web, api] = ["acme-web", "acme-api"].map((name) => { const dir = path.join(home, name); git(home, ["clone", "-q", origin, dir]); return dir; });

    for (const repo of [web, api]) {
      assert.strictEqual(checkoutStep(read(repo), "release-1.4"), "track");
      git(repo, multiCommands.track("release-1.4", "origin"));
      assert.strictEqual(read(repo).current, "release-1.4");
      assert.strictEqual(read(repo).branches.find((b) => b.current)?.upstream, "origin/release-1.4");
    }
    git(web, multiCommands.checkout("main"));
    git(web, multiCommands.create("acme-feature"));
    assert.strictEqual(read(web).current, "acme-feature");

    fs.writeFileSync(path.join(web, "b.txt"), "two\n");
    git(web, ["add", "b.txt"]); git(web, ["commit", "-q", "-m", "feat: second"]);
    const plan = pushPlan(read(web))!;
    assert.deepStrictEqual(plan, { branch: "acme-feature", remote: "origin", destination: "acme-feature", setUpstream: true });
    assert.deepStrictEqual(parseOutgoing(git(web, multiCommands.outgoing(false))).map((c) => c.subject), ["feat: second"]);
    git(web, multiCommands.push(plan.remote, plan.branch, plan.destination, plan.setUpstream));
    assert.strictEqual(read(web).branches.find((b) => b.current)?.upstream, "origin/acme-feature");
    assert.deepStrictEqual(parseOutgoing(git(web, multiCommands.outgoing(true))), [], "nothing left to push");

    // acme-api on release-1.4 merges acme-feature after a fetch, then updates both ways.
    git(api, ["fetch", "-q"]);
    git(api, multiCommands.merge("origin/acme-feature"));
    assert.ok(fs.existsSync(path.join(api, "b.txt")));
    git(api, ["push", "-q", "origin", "HEAD:release-1.4"]);
    git(web, multiCommands.checkout("release-1.4"));
    fs.writeFileSync(path.join(web, "local.txt"), "mine\n");
    git(web, ["add", "local.txt"]); git(web, ["commit", "-q", "-m", "feat: local"]);
    git(web, ["fetch", "-q"]);
    git(web, multiCommands.update("rebase"));
    assert.strictEqual(git(web, ["log", "-1", "--format=%s"]), "feat: local", "rebased onto the incoming commits");
    assert.ok(fs.existsSync(path.join(web, "b.txt")));
    fs.writeFileSync(path.join(web, "a.txt"), "dirty\n");
    assert.match(updateReason(fails(web, multiCommands.update("rebase"))), /clean working tree/);
    console.log("ok - real git: track, create, push with upstream, merge and update work across two clones");

    // An amended pushed commit: diverged, so Push… plans a force push leased on the fetched commit.
    git(web, ["checkout", "-q", "acme-feature"]);
    git(web, ["commit", "-q", "--amend", "-m", "feat: second, reworded"]);
    const forced = pushPlan(read(web))!;
    assert.strictEqual(forced.lease, git(web, ["rev-parse", "origin/acme-feature"]), "the lease is the remote branch as last fetched");
    // Someone else pushed meanwhile: the lease refuses, and nothing of theirs is lost.
    git(api, ["fetch", "-q"]);
    git(api, ["switch", "-q", "-c", "theirs", "origin/acme-feature"]);
    fs.writeFileSync(path.join(api, "theirs.txt"), "theirs\n");
    git(api, ["add", "theirs.txt"]); git(api, ["commit", "-q", "-m", "feat: theirs"]);
    git(api, ["push", "-q", "origin", "HEAD:acme-feature"]);
    assert.match(fails(web, multiCommands.push(forced.remote, forced.branch, forced.destination, false, forced.lease)), /stale info|rejected/);
    assert.strictEqual(git(seed, ["--git-dir", origin, "log", "-1", "--format=%s", "acme-feature"]), "feat: theirs");
    // After a fetch the lease is the new commit, and the force push replaces it.
    git(web, ["fetch", "-q"]);
    const again = pushPlan(read(web))!;
    git(web, multiCommands.push(again.remote, again.branch, again.destination, false, again.lease));
    assert.strictEqual(git(seed, ["--git-dir", origin, "log", "-1", "--format=%s", "acme-feature"]), "feat: second, reworded");
    assert.strictEqual(pushPlan(read(web))!.lease, undefined, "in step again: a plain push");
    console.log("ok - real git: a diverged branch is force pushed with a lease that refuses commits pushed since");

    git(web, multiCommands.tag("v1.4.0", "Release 1.4"));
    git(web, multiCommands.pushTag(tagRemote(read(web))!, "v1.4.0"));
    assert.strictEqual(git(seed, ["--git-dir", origin, "cat-file", "-t", "v1.4.0"]), "tag", "annotated, and on the remote");
    assert.strictEqual(git(seed, ["--git-dir", origin, "rev-parse", "v1.4.0^{commit}"]), git(web, ["rev-parse", "HEAD"]));
    console.log("ok - real git: a tag on the checked-out commit, pushed to the branch's remote");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

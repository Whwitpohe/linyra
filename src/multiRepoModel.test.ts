import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { branchArgs, parseBranches, type Branches } from "./branchModel";
import { gitEnv, makeRepo } from "./fixtures";
import { branchMatches, checkoutStep, forcePushPrompt, forwardReason, headDistance, isProtected, multiCommands, multiReport, otherBranches, parseBranchTracks, parseOutgoing, pushPlan, sharedBranches, stoppedOnConflicts, tagRemote, updateMethodOrder, updateMethodSetting, updateReason } from "./multiRepoModel";

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
  const none = { done: [], unchanged: [], stopped: [], skipped: [] };
  // Nothing was behind: said as such, never "done in 0 of 5".
  assert.deepStrictEqual(multiReport("Update Project", "update", { ...none, unchanged: ["a", "b", "c", "d", "e"] }), { level: "info", text: "Update Project: all 5 repositories already up to date." });
  assert.strictEqual(multiReport("Update Project", "update", { ...none, unchanged: ["acme-web"] }).text, "Update Project: acme-web is already up to date.");
  // Updated, up to date, stopped half-way and left alone: each group named, stopped makes it a warning.
  const mixed = multiReport("Update Project (merge)", "update", {
    done: ["acme-web"], unchanged: ["acme-api"], stopped: [{ name: "acme-libs", reason: "conflicts" }],
    skipped: [{ name: "acme-docs", reason: "no upstream branch" }, { name: "acme-ops", reason: "no upstream branch" }],
  });
  assert.strictEqual(mixed.level, "warning");
  assert.strictEqual(mixed.text, "Update Project (merge) — Updated: acme-web. Already up to date: acme-api. Stopped on conflicts, resolve or abort: acme-libs. Left as they were: acme-docs, acme-ops (no upstream branch).");
  assert.ok(!/Left as they were[^.]*acme-libs/.test(mixed.text), "a repository mid-merge is not \"left as it was\"");
  // Left alone because there was nothing to do there (no upstream): information, not a warning.
  assert.strictEqual(multiReport("Update Project", "update", { ...none, done: ["acme-web"], skipped: [{ name: "acme-api", reason: "no upstream branch" }] }).level, "info");
  assert.strictEqual(multiReport("Merge x", "merge", { ...none, skipped: [{ name: "acme-api", reason: "local changes", failed: true }] }).level, "warning");
  // Push: how many commits went where.
  assert.deepStrictEqual(multiReport("Push", "push", { ...none, done: ["a", "b", "c"] }, 7), { level: "info", text: "Pushed 7 commits to 3 repositories." });
  assert.strictEqual(multiReport("Push", "push", { ...none, done: ["acme-web"] }, 1).text, "Pushed 1 commit to acme-web.");
  assert.strictEqual(multiReport("Tag v1", "tag", { ...none, done: ["a", "b", "c", "d", "e", "f"] }).text, "Tag v1 — Tagged: a, b, c, d and 2 more.");
  assert.strictEqual(multiReport("Push", "push", none).text, "Push: nothing to do.");
  assert.ok(stoppedOnConflicts("CONFLICT (content): Merge conflict in a.txt") && !stoppedOnConflicts("error: Your local changes would be overwritten"));
  console.log("ok - one report across repositories: updated, already up to date, stopped on conflicts, left as they were");
}

{
  assert.strictEqual(updateMethodSetting(undefined), "ask");
  assert.strictEqual(updateMethodSetting("ffOnly"), "ffOnly");
  assert.strictEqual(updateMethodSetting("squash"), "ask", "an unknown value asks");
  assert.deepStrictEqual(updateMethodOrder(undefined), ["merge", "rebase", "ffOnly"]);
  assert.deepStrictEqual(updateMethodOrder("rebase"), ["rebase", "merge", "ffOnly"], "the last method first");
  assert.deepStrictEqual(multiCommands.update("ffOnly"), ["-c", "merge.autoStash=false", "-c", "submodule.recurse=false", "merge", "--ff-only", "--quiet", "@{upstream}"]);
  assert.strictEqual(updateReason("fatal: Not possible to fast-forward, aborting."), "it has diverged from its upstream: merge or rebase it");
  console.log("ok - Update Project's method: the setting, the last one first, and fast-forward only");
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

{
  // Update Project's read: every local branch, its upstream and how far, and the checked-out one.
  const row = (ref: string, upstream: string, track: string, head = " ") => [ref, upstream, track, head].join("\0");
  const out = [
    row("refs/heads/develop", "refs/remotes/origin/develop", "behind 2", "*"),
    row("refs/heads/master", "refs/remotes/origin/master", "behind 3"),
    row("refs/heads/release-1.4", "refs/remotes/origin/release-1.4", ""),
    row("refs/heads/feature/x", "refs/remotes/origin/feature/x", "ahead 1, behind 4"),
    row("refs/heads/spike", "refs/remotes/origin/spike", "gone"),
    row("refs/heads/local-only", "", ""),
    row("refs/heads/ahead", "refs/remotes/origin/ahead", "ahead 2"),
  ].join("\r\n") + "\n";
  const tracks = parseBranchTracks(out);
  assert.deepStrictEqual(tracks.map((t) => [t.name, t.ahead, t.behind, t.gone, t.head]), [
    ["develop", 0, 2, false, true], ["master", 0, 3, false, false], ["release-1.4", 0, 0, false, false], ["feature/x", 1, 4, false, false],
    ["spike", 0, 0, true, false], ["local-only", 0, 0, false, false], ["ahead", 2, 0, false, false],
  ]);
  assert.deepStrictEqual(headDistance(tracks), { ahead: 0, behind: 2 }, "the checked-out branch, as rev-list counted it");
  assert.strictEqual(headDistance(tracks.map((t) => ({ ...t, head: false }))), null, "HEAD detached");
  assert.strictEqual(headDistance([{ ...tracks[0], upstream: "" }]), null, "no upstream");
  assert.strictEqual(headDistance([{ ...tracks[0], gone: true }]), null, "its upstream gone");
  const o = otherBranches(tracks);
  assert.deepStrictEqual(o.forward.map((t) => t.name), ["master"], "behind only, not checked out: fast-forwarded");
  assert.deepStrictEqual(o.diverged.map((t) => t.name), ["feature/x"], "diverged: left, and named");
  assert.deepStrictEqual(multiCommands.fastForward(o.forward[0]), ["fetch", "--quiet", ".", "refs/remotes/origin/master:refs/heads/master"]);
  assert.throws(() => multiCommands.fastForward({ ...o.forward[0], upstream: "refs/remotes/origin/x:refs/heads/y" }), "a refspec is never smuggled in");
  assert.throws(() => multiCommands.fastForward({ ...o.forward[0], ref: "+refs/heads/master" }));
  assert.strictEqual(forwardReason("fatal: refusing to fetch into branch 'refs/heads/release-1.4' checked out at '/work/acme-web-wt'"), "checked out in another worktree");
  console.log("ok - Update Project reads every branch once; behind-only ones besides the checked-out one are fast-forwarded, diverged ones named");
}

{
  const none = { done: [], unchanged: [], stopped: [], skipped: [] };
  const only = multiReport("Update Project (merge)", "update", { ...none, unchanged: ["acme-web", "acme-api"], forwarded: [{ name: "acme-web", branches: ["master"] }, { name: "acme-api", branches: ["master", "release-1.4"] }] });
  assert.deepStrictEqual(only, { level: "info", text: "Update Project (merge) — Already up to date: acme-web, acme-api. Fast-forwarded too: master in acme-web, acme-api; release-1.4 in acme-api." },
    "checked-out branches up to date, others moved: said, not 'all already up to date'");
  const left = multiReport("Update Project (merge)", "update", { ...none, done: ["acme-web"], notForwarded: [
    { name: "acme-web", branch: "feature/x", reason: "it has diverged from its upstream" },
    { name: "acme-api", branch: "release-1.4", reason: "checked out in another worktree", failed: true },
  ] });
  assert.strictEqual(left.text, "Update Project (merge) — Updated: acme-web. Other branches left as they were: feature/x in acme-web (it has diverged from its upstream); release-1.4 in acme-api (checked out in another worktree).");
  assert.strictEqual(left.level, "warning", "git refused one: a warning");
  assert.strictEqual(multiReport("Update Project (merge)", "update", { ...none, done: ["acme-web"], notForwarded: [{ name: "acme-web", branch: "feature/x", reason: "it has diverged from its upstream" }] }).level, "info", "a diverged branch left alone is no failure");
  console.log("ok - Update Project's report names the other branches moved and those left, by branch and repository");
}

{
  // Real git: a clone on develop; master behind, release-1.4 behind but checked out in a worktree, feature diverged.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "linyra-forward-"));
  const ID = { GIT_AUTHOR_NAME: "dana", GIT_AUTHOR_EMAIL: "dana@example.com", GIT_COMMITTER_NAME: "dana", GIT_COMMITTER_EMAIL: "dana@example.com" };
  const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env: { ...gitEnv(home), ...ID, LC_ALL: "C" }, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  const fails = (cwd: string, args: string[]) => {
    try { git(cwd, args); return ""; } catch (e) { return String((e as { stderr?: unknown }).stderr ?? e); }
  };
  const commit = (cwd: string, file: string, message: string) => { fs.writeFileSync(path.join(cwd, file), `${message}\n`); git(cwd, ["add", file]); git(cwd, ["commit", "-q", "-m", message]); };
  try {
    const seed = path.join(home, "seed");
    makeRepo(seed, [{ time: 1000, author: "dana", message: "feat: base", files: { "a.txt": "one\n" } }], home);
    git(seed, ["branch", "-M", "master"]);
    for (const b of ["develop", "release-1.4", "feature"]) git(seed, ["branch", b]);
    const origin = path.join(home, "origin.git");
    git(home, ["clone", "-q", "--bare", seed, origin]);
    const web = path.join(home, "acme-web"), other = path.join(home, "acme-web-other"), wt = path.join(home, "acme-web-release");
    git(home, ["clone", "-q", origin, web]);
    for (const b of ["develop", "release-1.4", "feature"]) git(web, ["branch", "-q", "--track", b, `origin/${b}`]);
    git(web, ["switch", "-q", "feature"]); commit(web, "mine.txt", "feat: mine");
    git(web, ["switch", "-q", "develop"]);
    git(web, ["worktree", "add", "-q", wt, "release-1.4"]);
    // Someone else pushes to master, release-1.4 and feature.
    git(home, ["clone", "-q", origin, other]);
    for (const b of ["master", "release-1.4", "feature"]) { git(other, ["switch", "-q", b]); commit(other, `${b.replace(/\W/g, "-")}.txt`, `feat: theirs on ${b}`); git(other, ["push", "-q", "origin", b]); }
    git(web, ["fetch", "-q"]);

    const tracks = parseBranchTracks(git(web, multiCommands.branches()));
    assert.deepStrictEqual(headDistance(tracks), { ahead: 0, behind: 0 }, "develop, checked out, is up to date");
    const o = otherBranches(tracks);
    assert.deepStrictEqual(o.forward.map((t) => t.name).sort(), ["master", "release-1.4"]);
    assert.deepStrictEqual(o.diverged.map((t) => t.name), ["feature"]);
    const master = o.forward.find((t) => t.name === "master")!, release = o.forward.find((t) => t.name === "release-1.4")!;
    git(web, multiCommands.fastForward(master));
    assert.strictEqual(git(web, ["rev-parse", "master"]), git(web, ["rev-parse", "origin/master"]), "master moved to origin/master");
    assert.strictEqual(forwardReason(fails(web, multiCommands.fastForward(release))), "checked out in another worktree", "git refuses a branch checked out elsewhere");
    assert.notStrictEqual(git(web, ["rev-parse", "release-1.4"]), git(web, ["rev-parse", "origin/release-1.4"]));
    const feature = parseBranchTracks(git(web, multiCommands.branches())).find((t) => t.name === "feature")!;
    // Even if asked, git refuses to move a diverged branch (quietly: --quiet keeps its "[rejected]" line back).
    let refused = false;
    try { git(web, multiCommands.fastForward(feature)); } catch { refused = true; }
    assert.ok(refused, "even if asked, git refuses to move a diverged branch");
    assert.strictEqual(git(web, ["log", "-1", "--format=%s", "feature"]), "feat: mine");
    assert.strictEqual(git(web, ["branch", "--show-current"]), "develop");
    assert.strictEqual(git(web, ["status", "--porcelain"]), "", "the working tree is untouched");
    console.log("ok - real git: a branch only behind is fast-forwarded without a checkout; one checked out elsewhere or diverged is refused");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

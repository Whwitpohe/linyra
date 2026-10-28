import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { branchArgs, parseBranches, type Branches } from "./branchModel";
import { gitEnv, makeRepo } from "./fixtures";
import { checkoutStep, multiCommands, parseOutgoing, pushPlan, sharedBranches, updateReason } from "./multiRepoModel";

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
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

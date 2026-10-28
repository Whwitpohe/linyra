import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { branchArgs, branchCommands, branchGroupKey, branchKey, branchRevision, DEFAULT_BRANCH_SIDEBAR, newBranchProblem, parseBranches, sidebarState, type Branch } from "./branchModel";
import { gitEnv, makeRepo } from "./fixtures";
import { branchRows } from "./webview/branchPaneModel";

const sha = "a".repeat(40);
const line = (...fields: string[]) => fields.join("\0");
const data = parseBranches([
  line("refs/heads/develop", sha, "*", "origin/develop", "[ahead 2, behind 3]", ""),
  line("refs/heads/master", sha, " ", "", "", ""),
  line("refs/remotes/origin/develop", sha, " ", "", "", ""),
  line("refs/remotes/origin/HEAD", sha, " ", "", "", "refs/remotes/origin/master"),
  line("refs/remotes/team/upstream/release-1.4", sha, " ", "", "", ""),
].join("\n"), ["origin", "team/upstream"]);
assert.strictEqual(data.current, "develop");
assert.strictEqual(data.branches.length, 4);
assert.deepStrictEqual(data.branches[0], { ref: "refs/heads/develop", sha, name: "develop", kind: "local", current: true, upstream: "origin/develop", ahead: 2, behind: 3 });
assert.strictEqual(data.branches[3].remote, "team/upstream");
assert.strictEqual(data.branches[3].remoteBranch, "release-1.4");
assert.strictEqual(branchRevision(data.branches[2], data), "origin/develop");
assert.strictEqual(branchRevision(data.branches[2], { ...data, branches: [...data.branches, { ...data.branches[0], name: "origin/develop" }] }), "refs/remotes/origin/develop");
assert.ok(newBranchProblem("-bad", data.branches));
assert.ok(newBranchProblem("develop", data.branches));
assert.strictEqual(newBranchProblem("fix/你好", data.branches), undefined);
assert.strictEqual(newBranchProblem("develop", data.branches, "develop"), undefined);
assert.deepStrictEqual(sidebarState({ mode: "bad", expanded: ["local", "local", 3], favorites: null }), { mode: "repos", expanded: ["local"], favorites: [] });
console.log("ok - branch metadata distinguishes local/remote, current, upstream counts and symbolic refs");

{
  const repo = { id: "acme-api", name: "acme-api", root: "/ws/acme-api" };
  const state = { mode: "branches" as const, expanded: ["local", "remote", branchGroupKey("local", repo.id), branchGroupKey("remote", repo.id), `${branchGroupKey("remote", repo.id)}\0origin`], favorites: [branchKey(repo.id, "refs/heads/master")] };
  const rows = branchRows([repo], new Map([[repo.id, { data }]]), state, "");
  assert.deepStrictEqual(rows.filter((r) => r.kind === "branch").map((r) => r.branch!.name), ["develop", "master", "origin/develop"]);
  assert.ok(rows.find((r) => r.branch?.name === "master")?.favorite);
  assert.strictEqual(rows.find((r) => r.branch?.name === "origin/develop")?.depth, 3);
  const filtered = branchRows([repo], new Map([[repo.id, { data }]]), DEFAULT_BRANCH_SIDEBAR, "release-1.4");
  assert.deepStrictEqual(filtered.filter((r) => r.branch).map((r) => r.branch!.name), ["team/upstream/release-1.4"]);
  assert.strictEqual(branchRows([repo], new Map(), state, "").filter((r) => r.kind === "message").length, 2);
  console.log("ok - branch tree preserves repository/ref identities, favorites and searchable nested remotes");
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), "linyra-branches-"));
try {
  fs.writeFileSync(path.join(home, ".gitconfig"), "[user]\n name = dana\n email = dana@example.com\n");
  const root = path.join(home, "acme-api"), bare = path.join(home, "acme-remote.git");
  makeRepo(root, [{ author: "dana", time: 1_800_000_000, message: "feat: initial", files: { "readme.txt": "base\n" } }], home);
  const env = gitEnv(home), git = (args: string[], cwd = root) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  const read = () => parseBranches(git(branchArgs()), git(["remote"]).split("\n").filter(Boolean));
  const find = (name: string): Branch => read().branches.find((b) => b.name === name)!;
  git(["init", "--bare", "-q", bare]); git(["remote", "add", "origin", bare]); git(["push", "-u", "origin", "main"]);
  git(branchCommands.create(find("main"), "topic"));
  assert.strictEqual(read().current, "topic");
  git(branchCommands.rename(find("topic"), "topic-renamed"));
  assert.strictEqual(read().current, "topic-renamed");
  git(branchCommands.checkout(find("main")));
  git(branchCommands.merge(find("topic-renamed")));
  git(branchCommands.rebase(find("topic-renamed")));
  git(branchCommands.delete(find("topic-renamed")));
  assert.ok(!find("topic-renamed"));
  git(branchCommands.track(find("origin/main"), "tracked"));
  assert.strictEqual(find("tracked").upstream, "origin/main");
  const worktree = path.join(home, "acme-worktree");
  git(branchCommands.worktree(find("main"), "worktree-topic", worktree));
  assert.strictEqual(git(["branch", "--show-current"], worktree), "worktree-topic");
  git(["push", "--set-upstream", "--", "origin", "refs/heads/worktree-topic:refs/heads/worktree-topic"]);
  assert.ok(git(["show-ref", "refs/heads/worktree-topic"], bare));
  git(["push", "--delete", "--", "origin", "worktree-topic"]);
  assert.ok(!git(["for-each-ref", "--format=%(refname)", "refs/heads/worktree-topic"], bare));
  console.log("ok - actual Git accepts checkout/create/rename/merge/rebase/delete/track/worktree argv; push targets the chosen branch");
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

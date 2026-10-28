import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { branchArgs, branchCommands, branchGroupKey, branchKey, branchRevision, DEFAULT_BRANCH_SIDEBAR, newBranchProblem, parseBranches, sidebarState, type Branch } from "./branchModel";
import { gitEnv, makeRepo } from "./fixtures";
import { repoTreeKey, treeRows } from "./webview/repoTreeModel";

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
  const state = { mode: "repos" as const, expanded: [repoTreeKey(repo.id), branchGroupKey("local", repo.id), branchGroupKey("remote", repo.id), `${branchGroupKey("remote", repo.id)}\0origin`], favorites: [branchKey(repo.id, "refs/heads/master")] };
  const branchesOf = (rows: ReturnType<typeof treeRows>) => rows.flatMap((r) => (r.kind === "branch" ? [r] : []));
  const rows = treeRows([repo], "", [], null, new Map([[repo.id, { data }]]), state);
  assert.deepStrictEqual(branchesOf(rows).map((r) => r.branch.name), ["develop", "master", "origin/develop"]);
  assert.ok(branchesOf(rows).find((r) => r.branch.name === "master")?.favorite);
  assert.strictEqual(branchesOf(rows).find((r) => r.branch.name === "origin/develop")?.depth, 3);
  const filtered = treeRows([repo], "release-1.4", [], null, new Map([[repo.id, { data }]]), DEFAULT_BRANCH_SIDEBAR);
  assert.deepStrictEqual(branchesOf(filtered).map((r) => r.branch.name), ["team/upstream/release-1.4"]);
  assert.strictEqual(treeRows([repo], "", [], null, new Map(), state).filter((r) => r.kind === "message").length, 1);
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

{
  const peeled = "b".repeat(40);
  const tags = parseBranches([
    line("refs/heads/main", sha, "*", "", "", "", ""),
    line("refs/tags/v1.4.0", "c".repeat(40), " ", "", "", "", peeled),
    line("refs/tags/main", sha, " ", "", "", "", ""),
  ].join("\n"), []);
  assert.deepStrictEqual(tags.branches.map((b) => [b.kind, b.name, b.sha]), [["local", "main", sha], ["tag", "v1.4.0", peeled], ["tag", "main", sha]]);
  assert.strictEqual(branchRevision(tags.branches[1], tags), "v1.4.0");
  assert.strictEqual(branchRevision(tags.branches[2], tags), "refs/tags/main", "a tag named like a branch is passed by its full ref");
  assert.deepStrictEqual(branchCommands.checkoutTag(tags.branches[1]), ["checkout", "--detach", "refs/tags/v1.4.0", "--"]);
  assert.deepStrictEqual(branchCommands.deleteTag(tags.branches[1]), ["tag", "-d", "--", "v1.4.0"]);
  const rows = treeRows([{ id: "/w/acme-api", root: "/w/acme-api", name: "acme-api" }], "", [], null, new Map([["/w/acme-api", { data: tags }]]),
    { ...DEFAULT_BRANCH_SIDEBAR, expanded: [repoTreeKey("/w/acme-api"), branchGroupKey("tag", "/w/acme-api")] });
  assert.deepStrictEqual(rows.flatMap((r) => (r.kind === "branch" && r.branch.kind === "tag" ? [r.label] : [])), ["main", "v1.4.0"], "sorted by name");
  assert.ok(branchArgs().includes("refs/tags") && branchArgs()[2].endsWith("%(*objectname)"));
  console.log("ok - tags are listed with their commit (annotated tags peeled) under their own group");
}

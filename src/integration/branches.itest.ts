import * as assert from "assert";
import * as vscode from "vscode";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { branchArgs, branchKey, parseBranches, type Branches, type BranchSidebarState } from "../branchModel";
import type { LogSnapshot } from "../logView";

describe("Branch sidebar", () => {
  let root: string, repoId: string, beforeHead: string, home: string, remote: string;
  const snapshot = () => vscode.commands.executeCommand<LogSnapshot>("linyra._itest.snapshot");
  const sidebar = () => vscode.commands.executeCommand<{ state: BranchSidebarState; repos: Record<string, Branches> }>("linyra._itest.branches");
  const git = (args: string[], cwd = root, input?: string) => execFileSync("git", args, { cwd, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_NAME: "dana", GIT_AUTHOR_EMAIL: "dana@example.com", GIT_COMMITTER_NAME: "dana", GIT_COMMITTER_EMAIL: "dana@example.com" } }).trim();
  const arg = (name: string, kind = "heads") => ({ repoId, ref: `refs/${kind}/${name}` });
  const act = (action: string, name: string, kind?: string) => vscode.commands.executeCommand(`linyra.branch.${action}`, arg(name, kind));
  const answer = (value: string) => vscode.commands.executeCommand("linyra._itest.answer", value);
  const read = () => parseBranches(git(branchArgs()), git(["remote"]).split(/\r?\n/).filter(Boolean));
  const child = (parent: string, file: string, content: string, message: string) => {
    const index = path.join(home, "fixture.index");
    const env = { ...process.env, GIT_INDEX_FILE: index, GIT_AUTHOR_NAME: "dana", GIT_AUTHOR_EMAIL: "dana@example.com", GIT_COMMITTER_NAME: "dana", GIT_COMMITTER_EMAIL: "dana@example.com" };
    const run = (args: string[], input?: string) => execFileSync("git", args, { cwd: root, env, input, encoding: "utf8" }).trim();
    run(["read-tree", parent]); const blob = run(["hash-object", "-w", "--stdin"], content);
    run(["update-index", "--add", "--cacheinfo", `100644,${blob},${file}`]);
    const sha = run(["commit-tree", run(["write-tree"]), "-p", parent, "-m", message]);
    fs.rmSync(index, { force: true }); return sha;
  };

  before(async () => {
    home = fs.mkdtempSync(path.join(process.env.HOME ?? os.tmpdir(), "linyra-branch-ui-"));
    await vscode.commands.executeCommand("linyra.open");
    for (let i = 0; i < 100; i++) { if ((await snapshot())?.repos.length >= 3) break; await new Promise((r) => setTimeout(r, 100)); }
    const repo = (await snapshot()).repos.find((r) => r.name === "acme-api")!;
    assert.ok(repo); root = repo.root; repoId = repo.id; beforeHead = git(["rev-parse", "HEAD"]);
    await vscode.commands.executeCommand("linyra._itest.send", { type: "filter", filter: { text: "", author: "", mine: false, branch: "", repoIds: null, date: "all" } });
    git(["update-ref", "refs/heads/ui-feature", child(beforeHead, "ui-feature.txt", "feature\n", "feat: sidebar feature")]);
    remote = path.join(home, "acme-remote.git"); git(["init", "--bare", "-q", remote]); git(["remote", "add", "branch-test", remote]);
    git(["push", "branch-test", `${beforeHead}:refs/heads/release-1.4`]);
  });
  after(async () => {
    if (!root) return;
    await vscode.commands.executeCommand("linyra._itest.answer", undefined);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    git(["checkout", "main", "--"]);
    const worktree = path.join(home, "worktree");
    if (fs.existsSync(worktree)) git(["worktree", "remove", "--force", worktree]);
    for (const name of ["ui-feature", "ui-new", "ui-renamed", "release-1.4", "ui-worktree", "ui-other", "ui-rebase", "ui-unmerged"]) {
      try { git(["branch", "-D", name]); } catch { /* already deleted */ }
    }
    git(["reset", "--hard", beforeHead]); git(["remote", "remove", "branch-test"]);
    await vscode.commands.executeCommand("linyra._itest.send", { type: "filter", filter: { text: "", author: "", mine: false, branch: "", repoIds: null, date: "all" } });
    // The outer runner removes this fixture after VS Code exits; its worktree
    // watchers keep Windows handles open while the extension host is running.
  });

  it("loads local/remote refs lazily; selecting and favoriting a branch never checks it out", async () => {
    const initial = await sidebar(); assert.ok(!initial.repos[repoId]);
    await vscode.commands.executeCommand("linyra._itest.send", { type: "branchSidebar", action: "load", repoId });
    assert.ok((await sidebar()).repos[repoId].branches.some((b) => b.name === "branch-test/release-1.4"));
    await act("view", "ui-feature");
    for (let i = 0; i < 100 && !(await snapshot()).rows.some((c) => c.subject === "feat: sidebar feature"); i++) await new Promise((r) => setTimeout(r, 100));
    const log = await snapshot(); assert.strictEqual(log.filter.branch, "ui-feature"); assert.deepStrictEqual(log.filter.repoIds, [repoId]);
    assert.ok(log.rows.some((c) => c.subject === "feat: sidebar feature"));
    assert.strictEqual(git(["branch", "--show-current"]), "main");
    await act("favorite", "ui-feature"); assert.ok((await sidebar()).state.favorites.includes(branchKey(repoId, "refs/heads/ui-feature")));
    await act("favorite", "ui-feature"); assert.ok(!(await sidebar()).state.favorites.includes(branchKey(repoId, "refs/heads/ui-feature")));
    await act("copy", "ui-feature"); assert.strictEqual(await vscode.commands.executeCommand<string>("linyra._itest.clipboard"), "ui-feature");
    await vscode.commands.executeCommand("linyra._itest.send", { type: "branchSidebar", action: "state", state: { mode: "branches", expanded: ["local"], favorites: [] } });
    assert.strictEqual((await sidebar()).state.mode, "branches");
  });

  it("branch compare and working-tree compare use the selected repository/ref", async () => {
    await act("compare", "ui-feature");
    const compare = await vscode.commands.executeCommand<{ pair: { left: string; right: string } }>("linyra._itest.compare");
    assert.deepStrictEqual(compare.pair, { left: "ui-feature", right: "main" });
    await answer("ui-feature.txt"); await act("worktreeDiff", "ui-feature");
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    assert.ok(tab instanceof vscode.TabInputTextDiff);
    assert.strictEqual((await vscode.workspace.openTextDocument(tab.original)).getText(), "feature\n");
    assert.strictEqual((await vscode.workspace.openTextDocument(tab.modified)).getText(), "");
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("linyra.open");
  });

  it("creates, checks out and renames a branch, and pushes that branch to the chosen remote", async () => {
    await answer("ui-new"); await act("create", "ui-feature"); assert.strictEqual(read().current, "ui-new");
    await answer("ui-renamed"); await act("rename", "ui-new"); assert.strictEqual(read().current, "ui-renamed");
    await act("checkout", "main"); assert.strictEqual(read().current, "main");
    await answer("branch-test"); await act("push", "ui-renamed");
    assert.strictEqual(git(["rev-parse", "refs/heads/ui-renamed"], remote), git(["rev-parse", "ui-feature"]));
    assert.strictEqual(read().branches.find((b) => b.name === "ui-renamed")?.upstream, "branch-test/ui-renamed");
    assert.strictEqual(read().current, "main", "pushing a selected branch never checks it out");
  });

  it("remote checkout creates a tracked local branch; pull, fetch, worktree and remote delete are scoped", async () => {
    // Its own name, asked nothing; a local branch of that name tracking something else is named, not overwritten.
    git(["branch", "release-1.4", beforeHead]);
    const asked = await vscode.commands.executeCommand<number>("linyra._itest.asked");
    await act("checkout", "branch-test/release-1.4", "remotes");
    assert.strictEqual(read().current, "main");
    assert.strictEqual(await vscode.commands.executeCommand("linyra._itest.branchError"),
      "Could not check out branch-test/release-1.4 in acme-api: release-1.4 already exists here and tracks no remote branch: New Branch from Here… on branch-test/release-1.4 checks it out under another name.");
    git(["branch", "-D", "release-1.4"]);
    await act("checkout", "branch-test/release-1.4", "remotes");
    assert.strictEqual(await vscode.commands.executeCommand<number>("linyra._itest.asked"), asked, "no question");
    assert.strictEqual(read().current, "release-1.4");
    assert.strictEqual(read().branches.find((b) => b.name === "release-1.4")?.upstream, "branch-test/release-1.4");
    const incoming = child(beforeHead, "incoming.txt", "incoming\n", "feat: remote update");
    git(["push", "branch-test", `${incoming}:refs/heads/release-1.4`]);
    await act("fetch", "branch-test/release-1.4", "remotes"); await act("pull", "release-1.4");
    assert.strictEqual(git(["rev-parse", "HEAD"]), incoming);
    await vscode.commands.executeCommand("linyra._itest.branchWorktreePath", path.join(home, "worktree"));
    // Amended after it was pushed: Push Branch… asks, then force pushes with a lease.
    git(["commit", "--amend", "-q", "-m", "feat: remote update, amended"]);
    const amended = git(["rev-parse", "HEAD"]);
    await answer("Cancel"); await act("push", "release-1.4");
    assert.strictEqual(git(["rev-parse", "refs/heads/release-1.4"], remote), incoming, "declined: the remote keeps its commit");
    await answer("Force Push"); await act("push", "release-1.4");
    assert.strictEqual(await vscode.commands.executeCommand("linyra._itest.lastWarning"), "Force push release-1.4 to branch-test/release-1.4 in acme-api?");
    assert.strictEqual(git(["rev-parse", "refs/heads/release-1.4"], remote), amended);
    await answer("ui-worktree"); await act("worktree", "main");
    assert.strictEqual(git(["branch", "--show-current"], path.join(home, "worktree")), "ui-worktree");
    // The Repo List's Worktrees group lists it, read from the git dir's files.
    const listed = (await sidebar()).repos[repoId].worktrees ?? [];
    const linked = listed.find((w) => !w.main);
    assert.strictEqual(linked?.branch, "ui-worktree");
    assert.ok(listed.find((w) => w.main)?.current, "the repository's own folder is the main one");
    // Remove…, with local changes in it: asked, then asked again before --force.
    fs.writeFileSync(path.join(home, "worktree", "wip.txt"), "wip\n");
    await answer("Remove"); await answer("Cancel");
    await vscode.commands.executeCommand("linyra.worktree.remove", { repoId, path: linked!.path });
    assert.ok(fs.existsSync(path.join(home, "worktree")), "declined the second question: kept");
    assert.strictEqual(await vscode.commands.executeCommand("linyra._itest.lastWarning"), "Worktree worktree has changes that are not committed.");
    await answer("Remove"); await answer("Remove Anyway");
    await vscode.commands.executeCommand("linyra.worktree.remove", { repoId, path: linked!.path });
    assert.ok(!fs.existsSync(path.join(home, "worktree")));
    assert.strictEqual(git(["branch", "--list", "ui-worktree"]), "ui-worktree", "its branch stays");
    assert.strictEqual((await sidebar()).repos[repoId].worktrees, undefined, "no linked worktree left: no group");
    await answer("Delete"); await act("delete", "branch-test/ui-renamed", "remotes");
    assert.strictEqual(git(["for-each-ref", "--format=%(refname)", "refs/heads/ui-renamed"], remote), "");
  });

  it("a branch pill's sheet: its upstream and merge target read in at most four git processes; Review opens Compare", async () => {
    // The remote's default branch is main: release-1.4's merge target.
    git(["push", "-q", "branch-test", "main"]);
    git(["symbolic-ref", "refs/remotes/branch-test/HEAD", "refs/remotes/branch-test/main"]);
    const sheetData = () => vscode.commands.executeCommand<{ ref: string; kind: string; current: boolean; tip: { sha: string }; upstream?: { name: string | null; ahead: number; behind: number; gone: boolean }; target?: { name: string; ahead: number; behind: number; conflicts?: number | null } } | undefined>("linyra._itest.branchSheet");
    const spawned = async () => (await snapshot()).spawnLog.length;
    const before = await spawned();
    await vscode.commands.executeCommand("linyra._itest.send", { type: "branchSheet", action: "open", repoId, ref: "refs/heads/release-1.4" });
    const d = await sheetData();
    assert.ok((await spawned()) - before <= 4, "for-each-ref, the merge target's for-each-ref and rev-list, and a merge check at most");
    assert.deepStrictEqual([d?.kind, d?.current, d?.tip.sha], ["local", true, git(["rev-parse", "HEAD"])]);
    assert.deepStrictEqual(d?.upstream, { name: "branch-test/release-1.4", ref: "refs/remotes/branch-test/release-1.4", ahead: 0, behind: 0, gone: false });
    const [ahead, behind] = git(["rev-list", "--left-right", "--count", "HEAD...branch-test/main"]).split(/\s+/).map(Number);
    assert.deepStrictEqual(d?.target && { name: d.target.name, ahead: d.target.ahead, behind: d.target.behind }, { name: "branch-test/main", ahead, behind });
    if (ahead > 0 && behind > 0) assert.ok(d?.target?.conflicts === null || typeof d?.target?.conflicts === "number", "behind with commits of its own: checked");
    await vscode.commands.executeCommand("linyra._itest.send", { type: "branchSheet", action: "review", repoId, ref: "refs/heads/release-1.4" });
    const compared = await vscode.commands.executeCommand<{ pair: { left: string; right: string } | null }>("linyra._itest.compare");
    assert.deepStrictEqual(compared?.pair, { left: "release-1.4", right: "branch-test/main" });
    await vscode.commands.executeCommand("linyra.compareClose");
    await vscode.commands.executeCommand("linyra._itest.send", { type: "branchSheet", action: "close", repoId, ref: "refs/heads/release-1.4" });
    // A branch that is gone from the repository: no data (the sheet says it no longer exists), and no error.
    await vscode.commands.executeCommand("linyra._itest.send", { type: "branchSheet", action: "open", repoId, ref: "refs/heads/ui-no-such" });
    assert.strictEqual(await sheetData(), undefined);
  });

  it("Change Upstream… sets what a local branch tracks, picked from its remote branches; Stop Tracking clears it", async () => {
    git(["fetch", "-q", "branch-test"]);
    git(["update-ref", "refs/heads/track-me", beforeHead]);
    const upstream = () => { try { return git(["rev-parse", "--abbrev-ref", "track-me@{upstream}"]); } catch { return ""; } };
    await answer("branch-test/release-1.4");
    await act("upstream", "track-me");
    assert.strictEqual(upstream(), "branch-test/release-1.4");
    await answer("Stop Tracking");
    await act("upstream", "track-me");
    assert.strictEqual(upstream(), "", "no upstream any more");
    git(["branch", "-q", "-D", "track-me"]);
  });

  it("merge and rebase use the explicitly selected ref and refresh the current branch", async () => {
    await act("checkout", "main");
    // The button says Merge (not Continue, Continue Merge's word); the detail what moves, and that a conflict stops it.
    await answer("Merge"); await act("merge", "ui-feature");
    assert.strictEqual(await vscode.commands.executeCommand("linyra._itest.lastWarning"), "Merge ui-feature into main in acme-api?");
    assert.strictEqual(await vscode.commands.executeCommand("linyra._itest.lastDetail"), "main gets 1 commit from ui-feature; if files conflict the merge stops for you to resolve.");
    assert.strictEqual(git(["rev-parse", "HEAD"]), git(["rev-parse", "ui-feature"]));
    // Nothing to take: said, not asked.
    const asked = await vscode.commands.executeCommand<number>("linyra._itest.asked");
    await act("merge", "ui-feature");
    assert.strictEqual(await vscode.commands.executeCommand<number>("linyra._itest.asked"), asked, "already merged: no question");
    git(["update-ref", "refs/heads/ui-rebase", child(beforeHead, "other.txt", "other\n", "feat: other change")]);
    await act("checkout", "ui-rebase");
    await answer("Rebase"); await act("rebase", "ui-feature");
    assert.match(await vscode.commands.executeCommand<string>("linyra._itest.lastDetail") ?? "", /^Your 1 commit on ui-rebase is replayed on top of ui-feature \(1 commit\)/);
    assert.strictEqual(git(["merge-base", "HEAD", "ui-feature"]), git(["rev-parse", "ui-feature"]));
    assert.ok((await sidebar()).repos[repoId].branches.find((b) => b.name === "ui-rebase")?.current);
    await answer("Merge"); await act("pullMerge", "branch-test/release-1.4", "remotes");
    assert.strictEqual(git(["merge-base", "HEAD", "branch-test/release-1.4"]), git(["rev-parse", "branch-test/release-1.4"]));
    const before = await vscode.commands.executeCommand<number>("linyra._itest.asked");
    await act("pullRebase", "branch-test/release-1.4", "remotes");
    assert.strictEqual(await vscode.commands.executeCommand<number>("linyra._itest.asked"), before, "fetched first: nothing new, so nothing asked");
  });

  it("deletion asks again before forcing; forged repos/refs and invalid branch names cannot mutate refs", async () => {
    await act("checkout", "main");
    await answer("Delete"); await act("delete", "ui-renamed"); assert.ok(!read().branches.some((b) => b.name === "ui-renamed"));
    git(["update-ref", "refs/heads/ui-unmerged", child(beforeHead, "unmerged.txt", "keep\n", "feat: unmerged")]);
    // Not merged: git refuses; asked again, with how many commits are on nothing else.
    await answer("Delete"); await answer("Cancel"); await act("delete", "ui-unmerged"); assert.ok(read().branches.some((b) => b.name === "ui-unmerged"));
    assert.strictEqual(await vscode.commands.executeCommand("linyra._itest.lastWarning"), "ui-unmerged is not merged into main in acme-api.");
    await answer("Delete"); await answer("Delete Anyway (1 commit not merged anywhere)"); await act("delete", "ui-unmerged");
    assert.ok(!read().branches.some((b) => b.name === "ui-unmerged"), "Delete Anyway: git branch -D");
    const before = git(["show-ref"]);
    await answer("-invalid"); await act("create", "main");
    await vscode.commands.executeCommand("linyra.branch.checkout", { repoId: "/not-in-workspace", ref: "refs/heads/main" });
    await vscode.commands.executeCommand("linyra.branch.delete", { repoId, ref: "--all" });
    assert.strictEqual(git(["show-ref"]), before);
    assert.strictEqual(read().current, "main");
  });
});

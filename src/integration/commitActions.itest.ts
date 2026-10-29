// Commit row actions (cherry-pick, revert, reset, checkout revision, new branch, new tag) on the
// acme-api fixture; every ref and HEAD it moves is put back afterwards (runs last, see index.ts).
import * as assert from "assert";
import * as vscode from "vscode";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ALL, send, snapshot, until } from "./helpers";

describe("Commit actions", () => {
  let root: string, repoId: string, start: string;
  const ID = { GIT_AUTHOR_NAME: "dana", GIT_AUTHOR_EMAIL: "dana@example.com", GIT_COMMITTER_NAME: "dana", GIT_COMMITTER_EMAIL: "dana@example.com" };
  const git = (args: string[], env: NodeJS.ProcessEnv = {}, input?: string) =>
    execFileSync("git", args, { cwd: root, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...ID, ...env } }).trim();
  const answer = (value: string | undefined) => vscode.commands.executeCommand("linyra._itest.answer", value);
  const act = (command: string, sha: string) => vscode.commands.executeCommand(`linyra.${command}`, { webviewSection: "commit", repoId, sha, preventDefaultContextMenuItems: true });
  /** A commit on top of `parent` with one file, made without touching the working tree or HEAD. */
  const child = (parent: string, file: string, content: string, message: string, date?: string) => {
    const index = path.join(root, ".git", "linyra-itest.index");
    const env = { GIT_INDEX_FILE: index, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) };
    git(["read-tree", parent], env);
    const blob = git(["hash-object", "-w", "--stdin"], env, content);
    git(["update-index", "--add", "--cacheinfo", `100644,${blob},${file}`], env);
    const sha = git(["commit-tree", git(["write-tree"], env), "-p", parent, "-m", message], env);
    fs.rmSync(index, { force: true });
    return sha;
  };
  const head = () => git(["rev-parse", "HEAD"]);
  const tryGit = (args: string[]) => { try { return git(args); } catch { return ""; } };
  const listed = (sha: string) => until(`commit ${sha.slice(0, 7)} listed`, (s) => s.rows.some((r) => r.repoId === repoId && r.sha === sha));

  before(async () => {
    await vscode.commands.executeCommand("linyra.open");
    await until("the Log webview", (s) => s.readyCount >= 1 && s.repos.length === 3);
    // An earlier suite may have left the Log on its Uncommitted side (Show Uncommitted Changes).
    await send({ type: "logMode", mode: "commits" });
    await send({ type: "filter", filter: ALL });
    const repo = (await snapshot()).repos.find((r) => r.name === "acme-api")!;
    root = repo.root; repoId = repo.id; start = head();
  });

  after(async () => {
    if (!root) return;
    await answer(undefined);
    try { git(["cherry-pick", "--abort"]); } catch { /* none in progress */ }
    try { git(["stash", "clear"]); } catch { /* no stashes */ }
    git(["checkout", "-f", "main", "--"]);
    git(["reset", "--hard", start]);
    for (const ref of ["refs/heads/ci-side", "refs/heads/ci-branch", "refs/tags/ci-tag"]) {
      try { git(["update-ref", "-d", ref]); } catch { /* not created */ }
    }
    await send({ type: "refresh" });
    await until("the fixture log again", (s) => s.rows.length === 6);
  });

  it("offers the actions on commit rows only, and keeps them out of the Command Palette", () => {
    const menus = vscode.extensions.getExtension("whwitpohe.linyra")!.packageJSON.contributes.menus;
    const commands = ["commitCherryPick", "commitRevert", "commitReset", "commitCheckout", "commitNewBranch", "commitNewTag", "commitCompareLocal", "commitCreatePatch", "commitPushUpTo"].map((c) => `linyra.${c}`);
    for (const command of commands) {
      const items = (menus["webview/context"] as { command: string; when: string }[]).filter((m) => m.command === command);
      assert.strictEqual(items.length, 1, command);
      assert.ok(items[0].when.includes(command === "linyra.commitPushUpTo" ? "webviewSection == 'commit'" : "webviewSection =~ /^(commit|historyCommit)$/"), command);
      assert.ok((menus.commandPalette as { command: string; when: string }[]).some((m) => m.command === command && m.when === "false"), command);
    }
  });

  it("cherry-picks a commit from another branch onto the checked-out one, and reverts it", async () => {
    const side = child(start, "side.txt", "side\n", "feat: side change");
    git(["update-ref", "refs/heads/ci-side", side]);
    await send({ type: "refresh" });
    await listed(side);
    await act("commitCherryPick", side);
    assert.strictEqual(git(["log", "-1", "--format=%s"]), "feat: side change");
    assert.strictEqual(git(["branch", "--show-current"]), "main");
    assert.ok(fs.existsSync(path.join(root, "side.txt")));
    const picked = head();
    await listed(picked); // the Log was read again
    await act("commitRevert", picked);
    assert.match(git(["log", "-1", "--format=%s"]), /^Revert "feat: side change"/);
    assert.ok(!fs.existsSync(path.join(root, "side.txt")));
    await listed(head());
  });

  it("an empty cherry-pick is skipped instead of left in progress", async () => {
    const before = head();
    await act("commitCherryPick", start); // its change is already on main
    assert.strictEqual(head(), before);
    assert.ok(!fs.existsSync(path.join(root, ".git", "CHERRY_PICK_HEAD")), "no cherry-pick left in progress");
  });

  it("creates a tag and a checked-out branch at a commit, refusing a taken name", async () => {
    await answer("ci-tag");
    await act("commitNewTag", start);
    assert.strictEqual(git(["rev-parse", "ci-tag^{commit}"]), start);
    await answer("ci-tag");
    await act("commitNewTag", head());
    assert.strictEqual(git(["rev-parse", "ci-tag^{commit}"]), start, "a taken tag name is not moved");
    await answer("ci-branch");
    await act("commitNewBranch", start);
    assert.strictEqual(git(["branch", "--show-current"]), "ci-branch");
    assert.strictEqual(head(), start);
    git(["checkout", "main", "--"]);
  });

  it("checks out a revision only after the question, detaching HEAD", async () => {
    await answer("No");
    await act("commitCheckout", start);
    assert.strictEqual(git(["branch", "--show-current"]), "main", "declined: nothing changes");
    await answer("Check Out");
    await act("commitCheckout", start);
    assert.strictEqual(git(["branch", "--show-current"]), "");
    assert.strictEqual(head(), start);
    git(["checkout", "main", "--"]);
    // A local edit in the revision's way: Smart Checkout stashes it, checks out, puts it back.
    const rev = child(start, "upload.go", "package upload\n\nfunc Retry() {}\n\nfunc Limit() {}\n", "test: a revision that changes upload.go");
    // On a branch, so the Log lists it (a row's action acts on listed commits only).
    git(["update-ref", "refs/heads/ci-side", rev]);
    await send({ type: "refresh" });
    await listed(rev);
    fs.writeFileSync(path.join(root, "upload.go"), "// local edit\npackage upload\n\nfunc Retry() {}\n");
    await answer("Check Out"); await answer("Smart Checkout");
    await act("commitCheckout", rev);
    assert.strictEqual(await vscode.commands.executeCommand("linyra._itest.lastWarning"), "Local changes in acme-api would be overwritten by checking out " + rev.slice(0, 7) + ".");
    assert.strictEqual(head(), rev, "checked out");
    assert.strictEqual(fs.readFileSync(path.join(root, "upload.go"), "utf8").replace(/\r\n/g, "\n"), "// local edit\npackage upload\n\nfunc Retry() {}\n\nfunc Limit() {}\n", "both: the revision's and the local edit");
    assert.strictEqual(git(["stash", "list"]), "", "put back: no stash left");
    git(["checkout", "-f", "main", "--"]);
    git(["update-ref", "-d", "refs/heads/ci-side"]);
  });

  it("resets the current branch in the chosen mode after the question", async () => {
    const tip = head();
    await answer("Mixed"); await answer("No");
    await act("commitReset", start);
    assert.strictEqual(head(), tip, "declined: the branch stays");
    await answer("Mixed"); await answer("Reset");
    await act("commitReset", start);
    // The question names what leaves the branch, and what happens to the files.
    const leaving = Number(git(["rev-list", "--count", `${start}..${tip}`]));
    assert.strictEqual(await vscode.commands.executeCommand("linyra._itest.lastWarning"), `Reset main to ${start.slice(0, 7)} in acme-api?`);
    assert.strictEqual(await vscode.commands.executeCommand("linyra._itest.lastDetail"), `${leaving} commit${leaving === 1 ? " leaves" : "s leave"} main.\nTheir changes stay in your files, unstaged.`);
    assert.strictEqual(head(), start);
    assert.strictEqual(git(["branch", "--show-current"]), "main");
    const s = await until("the Log after the reset", (x) => !x.rows.some((r) => r.sha === tip));
    assert.ok(s.rows.some((r) => r.sha === start));
  });

  it("edits the subject of HEAD, keeping its body, and undoes it with its changes staged", async () => {
    fs.writeFileSync(path.join(root, "undo.txt"), "undo\n");
    git(["add", "undo.txt"]);
    git(["commit", "-q", "-m", "feat: to be reworded", "-m", "Body stays."]);
    const made = head();
    await send({ type: "refresh" });
    await listed(made);
    await act("commitUndo", start); // not HEAD: refused, nothing moves
    assert.strictEqual(head(), made);
    await answer("feat: reworded");
    await act("commitReword", made);
    assert.strictEqual(git(["log", "-1", "--format=%s"]), "feat: reworded");
    assert.strictEqual(git(["log", "-1", "--format=%b"]), "Body stays.");
    assert.strictEqual(git(["rev-parse", "HEAD~1"]), start);
    const reworded = head();
    await listed(reworded);
    await answer("Undo Commit");
    await act("commitUndo", reworded);
    assert.strictEqual(head(), start);
    assert.strictEqual(git(["diff", "--cached", "--name-only"]), "undo.txt", "the undone change is staged");
    git(["reset", "-q", "--hard", start]);
  });

  it("cherry-picks every selected commit, oldest first, when the right-click is inside the selection", async () => {
    // The same second for both, as a fast machine makes them: the Log must still list the child first.
    const now = `${Math.floor(Date.now() / 1000)} +0000`;
    const first = child(start, "one.txt", "1\n", "feat: batch one", now);
    const second = child(first, "two.txt", "2\n", "feat: batch two", now);
    git(["update-ref", "refs/heads/ci-side", second]);
    await send({ type: "refresh" });
    await listed(second);
    await send({ type: "selectMany", items: [{ repoId, sha: second }, { repoId, sha: first }], focus: { repoId, sha: second } });
    await until("both selected", (s) => s.changes.presentation?.details.length === 2);
    const before = head();
    await act("commitCherryPick", second);
    assert.deepStrictEqual(git(["log", "--format=%s", `${before}..HEAD`]).split("\n"), ["feat: batch two", "feat: batch one"], "applied oldest first");
    assert.ok(fs.existsSync(path.join(root, "one.txt")) && fs.existsSync(path.join(root, "two.txt")));
    git(["reset", "-q", "--hard", before]);
    await vscode.commands.executeCommand("linyra.clearSelection");
  });

  it("stashes changes, lists the stash in the tree's data, applies, pops and drops it", async () => {
    const stashes = async () => ((await vscode.commands.executeCommand<{ repos: Record<string, { stashes?: { ref: string; subject: string }[] }> }>("linyra._itest.branches")).repos[repoId]?.stashes ?? []);
    fs.writeFileSync(path.join(root, "stash-me.txt"), "wip\n");
    // One box: the message, and Include new files toggled on (off is the first default).
    await answer("ci stash|toggle");
    await vscode.commands.executeCommand("linyra.stash.create", { webviewSection: "repo", repoId });
    assert.ok(!fs.existsSync(path.join(root, "stash-me.txt")), "the work tree is clean");
    await vscode.commands.executeCommand("linyra._itest.send", { type: "branchSidebar", action: "load", repoId });
    assert.deepStrictEqual((await stashes()).map((s) => s.ref), ["stash@{0}"]);
    assert.match((await stashes())[0].subject, /ci stash/);
    await vscode.commands.executeCommand("linyra.stash.apply", { repoId, ref: "stash@{0}" });
    assert.ok(fs.existsSync(path.join(root, "stash-me.txt")), "apply brings the work back");
    assert.strictEqual((await stashes()).length, 1, "and keeps the stash");
    fs.rmSync(path.join(root, "stash-me.txt"));
    await vscode.commands.executeCommand("linyra.stash.pop", { repoId, ref: "stash@{0}" });
    assert.ok(fs.existsSync(path.join(root, "stash-me.txt")));
    assert.strictEqual((await stashes()).length, 0, "pop removes it");
    // Remembered: on now, so toggled off for tracked changes only.
    await answer("ci again|toggle");
    fs.rmSync(path.join(root, "stash-me.txt"));
    fs.writeFileSync(path.join(root, "upload.go"), "package upload\n// changed\n");
    await vscode.commands.executeCommand("linyra.stash.create", { webviewSection: "repo", repoId });
    assert.strictEqual((await stashes()).length, 1);
    await answer("No");
    await vscode.commands.executeCommand("linyra.stash.drop", { repoId, ref: "stash@{0}" });
    assert.strictEqual((await stashes()).length, 1, "declined: kept");
    await answer("Drop");
    await vscode.commands.executeCommand("linyra.stash.drop", { repoId, ref: "stash@{0}" });
    assert.strictEqual((await stashes()).length, 0);
  });

  it("Create Patch…: one commit, or the selected ones oldest first, as git format-patch writes them", async () => {
    const first = child(start, "patch-one.txt", "1\n", "feat: patch one");
    const second = child(first, "patch-two.txt", "2\n", "feat: patch two");
    git(["update-ref", "refs/heads/ci-side", second]);
    await send({ type: "refresh" });
    await listed(second);
    await answer("Copy to Clipboard");
    await act("commitCreatePatch", first);
    const one = await vscode.commands.executeCommand<string>("linyra._itest.clipboard");
    assert.strictEqual(one.trimEnd(), git(["format-patch", "--stdout", "-1", first]), "one commit's patch");
    await send({ type: "selectMany", items: [{ repoId, sha: second }, { repoId, sha: first }], focus: { repoId, sha: second } });
    await until("both selected", (s) => s.changes.presentation?.details.length === 2);
    await answer("Copy to Clipboard");
    await act("commitCreatePatch", second);
    const both = await vscode.commands.executeCommand<string>("linyra._itest.clipboard");
    assert.ok(both.indexOf("Subject: [PATCH] feat: patch one") < both.indexOf("Subject: [PATCH] feat: patch two") && both.includes("patch two"), "oldest first");
    git(["apply", "--check"], {}, both); // applies to the working tree as it is
    await vscode.commands.executeCommand("linyra.clearSelection");
  });

  it("Apply Patch… from the clipboard: as changes, or a mailbox as its commits; one that does not fit is refused", async () => {
    const first = child(start, "patch-one.txt", "1\n", "feat: patch one");
    const second = child(first, "patch-two.txt", "2\n", "feat: patch two");
    const mbox = git(["format-patch", "--stdout", `${start}..${second}`]) + "\n";
    await vscode.commands.executeCommand("linyra._itest.setClipboard", mbox);
    await answer("From Clipboard"); await answer("Apply as Changes");
    await vscode.commands.executeCommand("linyra.applyPatch", { webviewSection: "repo", repoId });
    assert.strictEqual(await vscode.commands.executeCommand("linyra._itest.patch"), "Linyra: applied the patch to acme-api (2 files).");
    assert.strictEqual(fs.readFileSync(path.join(root, "patch-two.txt"), "utf8"), "2\n");
    assert.strictEqual(head(), start, "changes only: no commit");
    await until("the applied files in the uncommitted work", (s) => s.uncommitted.some((w) => w.repoId === repoId && w.changes.includes("patch-one.txt")));
    git(["clean", "-fdq"]);

    await answer("From Clipboard"); await answer("Apply as Commits");
    await vscode.commands.executeCommand("linyra.applyPatch", { webviewSection: "repo", repoId });
    assert.strictEqual(await vscode.commands.executeCommand("linyra._itest.patch"), "Linyra: applied 2 commits to acme-api.");
    assert.strictEqual(git(["log", "-2", "--format=%s"]), "feat: patch two\nfeat: patch one");

    // The same patch again no longer fits: declining the three-way merge changes nothing.
    await answer("From Clipboard"); await answer("Apply as Changes"); await answer("Cancel");
    await vscode.commands.executeCommand("linyra.applyPatch", { webviewSection: "repo", repoId });
    assert.strictEqual(await vscode.commands.executeCommand("linyra._itest.lastWarning"), "The patch does not apply cleanly to acme-api.");
    assert.strictEqual(git(["status", "--porcelain"]), "");
    await vscode.commands.executeCommand("linyra._itest.setClipboard", "not a patch");
    await answer("From Clipboard");
    await vscode.commands.executeCommand("linyra.applyPatch", { webviewSection: "repo", repoId });
    assert.strictEqual(await vscode.commands.executeCommand("linyra._itest.patch"), "That is not a patch: no diff in it.");
    git(["reset", "-q", "--hard", start]);
  });

  it("Compare with Working Tree…: the files that differ from the commit, the one picked as a diff", async () => {
    fs.writeFileSync(path.join(root, "upload.go"), "package upload\n// compared\n");
    await answer("upload.go");
    await act("commitCompareLocal", start);
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(tab?.input instanceof vscode.TabInputTextDiff, "a diff opened");
    assert.match(tab.label, /^upload\.go \(.{7} ↔ Working Tree\) — acme-api$/);
    assert.strictEqual((tab.input as vscode.TabInputTextDiff).modified.fsPath, path.join(root, "upload.go"));
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    git(["checkout", "--", "upload.go"]);
  });

  it("Push All up to Here…: the branch up to that commit, the commits after it stay local", async () => {
    // Under the suite's isolated HOME, which the runner removes after VS Code exits.
    const remote = fs.mkdtempSync(path.join(process.env.HOME ?? os.tmpdir(), "linyra-push-up-to-"));
    const before = { remote: tryGit(["config", "--get", "branch.main.remote"]), merge: tryGit(["config", "--get", "branch.main.merge"]) };
    git(["init", "-q", "--bare", remote]);
    git(["remote", "add", "ci-up", remote]);
    try {
      git(["push", "-q", "ci-up", `${start}:refs/heads/main`]);
      git(["fetch", "-q", "ci-up"]);
      git(["config", "branch.main.remote", "ci-up"]);
      git(["config", "branch.main.merge", "refs/heads/main"]);
      const at = (file: string) => { fs.writeFileSync(path.join(root, file), `${file}\n`); git(["add", file]); git(["commit", "-q", "-m", `feat: ${file}`]); return head(); };
      const first = at("up-one.txt");
      const second = at("up-two.txt");
      await send({ type: "refresh" });
      await listed(second);
      await act("commitPushUpTo", start); // already there: nothing asked, nothing pushed
      assert.strictEqual(git(["rev-parse", "main"], { GIT_DIR: remote }), start);
      await answer("Push");
      await act("commitPushUpTo", first);
      assert.strictEqual(await vscode.commands.executeCommand("linyra._itest.lastWarning"), `Push 1 commit of main up to ${first.slice(0, 7)} to ci-up/main?`);
      assert.strictEqual(git(["rev-parse", "main"], { GIT_DIR: remote }), first, "up to that commit");
      assert.strictEqual(head(), second, "the commit after it stays local, HEAD unmoved");
    } finally {
      git(["remote", "remove", "ci-up"]);
      for (const [key, value] of [["branch.main.remote", before.remote], ["branch.main.merge", before.merge]] as const) {
        if (value) git(["config", key, value]); else tryGit(["config", "--unset", key]);
      }
      git(["reset", "-q", "--hard", start]);
    }
  });

  it("offers Undo and Edit Message on the checked-out commit only", () => {
    const menus = vscode.extensions.getExtension("whwitpohe.linyra")!.packageJSON.contributes.menus["webview/context"] as { command: string; when: string }[];
    for (const command of ["linyra.commitUndo", "linyra.commitReword"]) {
      assert.ok(menus.some((m) => m.command === command && m.when.endsWith("&& head")), command);
    }
  });
});

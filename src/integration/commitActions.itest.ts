// Commit row actions (cherry-pick, revert, reset, checkout revision, new branch, new tag) on the
// acme-api fixture; every ref and HEAD it moves is put back afterwards (runs last, see index.ts).
import * as assert from "assert";
import * as vscode from "vscode";
import { execFileSync } from "child_process";
import * as fs from "fs";
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
    const commands = ["commitCherryPick", "commitRevert", "commitReset", "commitCheckout", "commitNewBranch", "commitNewTag"].map((c) => `linyra.${c}`);
    for (const command of commands) {
      const items = (menus["webview/context"] as { command: string; when: string }[]).filter((m) => m.command === command);
      assert.strictEqual(items.length, 1, command);
      assert.ok(items[0].when.includes("webviewSection =~ /^(commit|historyCommit)$/"), command);
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
  });

  it("resets the current branch in the chosen mode after the question", async () => {
    const tip = head();
    await answer("Mixed"); await answer("No");
    await act("commitReset", start);
    assert.strictEqual(head(), tip, "declined: the branch stays");
    await answer("Mixed"); await answer("Reset");
    await act("commitReset", start);
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
    await answer("Stash including untracked files"); await answer("ci stash");
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
    await answer("Stash tracked changes"); await answer("ci again");
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

  it("offers Undo and Edit Message on the checked-out commit only", () => {
    const menus = vscode.extensions.getExtension("whwitpohe.linyra")!.packageJSON.contributes.menus["webview/context"] as { command: string; when: string }[];
    for (const command of ["linyra.commitUndo", "linyra.commitReword"]) {
      assert.ok(menus.some((m) => m.command === command && m.when.endsWith("&& head")), command);
    }
  });
});

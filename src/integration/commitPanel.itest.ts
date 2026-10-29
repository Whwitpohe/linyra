// The Commit side bar: checks, Group By, one message for several repositories, a commit of the checked
// files only (git commit --only), Commit Message History, Amend with Author and Sign-off, and the
// three commands that are never one another: Rollback, Remove from VCS and Delete…; Add to VCS and
// Add to .gitignore. Works in acme-web and acme-api and puts both back
// (it runs after the ordered suites, see index.ts).
import * as assert from "assert";
import * as vscode from "vscode";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { CommitWebviewMessage } from "../commitProtocol";
import { ALL, EXTENSION_ID, send, snapshot, until, waitFor } from "./helpers";

interface PanelSnapshot { items: string[]; checked: string; busy: boolean; lastError: string | undefined; visible: boolean; author: string | undefined; signOff: boolean; history: string[] }

describe("Commit side bar", () => {
  const ID = { GIT_AUTHOR_NAME: "dana", GIT_AUTHOR_EMAIL: "dana@example.com", GIT_COMMITTER_NAME: "dana", GIT_COMMITTER_EMAIL: "dana@example.com" };
  const repos: Record<"web" | "api", { id: string; root: string; start: string; tracked: string; ignoreTracked: boolean }> = {} as never;
  const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...ID } }).trim();
  const panel = () => vscode.commands.executeCommand<PanelSnapshot>("linyra._itest.commitPanel");
  const tell = (m: CommitWebviewMessage) => vscode.commands.executeCommand("linyra._itest.commitSend", m);
  const check = (ids: string[], on: boolean) => vscode.commands.executeCommand("linyra._itest.commitCheck", ids, on);
  const refresh = () => vscode.commands.executeCommand("linyra.refreshUncommitted");
  const shows = (what: string, ok: (p: PanelSnapshot) => boolean) => waitFor(what, async () => { const p = await panel(); return ok(p) ? p : undefined; });
  const answer = (value: string | undefined) => vscode.commands.executeCommand("linyra._itest.answer", value);
  const file = (repo: "web" | "api", name: string) => path.join(repos[repo].root, ...name.split("/"));
  const row = (list: "changes" | "unversioned", repo: "web" | "api", name: string) => `${list}:${repos[repo].id}:f:${name}`;

  before(async () => {
    await vscode.commands.executeCommand("linyra.open");
    await until("the Log webview", (s) => s.readyCount >= 1 && s.repos.length === 3);
    await send({ type: "logMode", mode: "commits" });
    await send({ type: "filter", filter: ALL });
    for (const [key, name] of [["web", "acme-web"], ["api", "acme-api"]] as const) {
      const r = (await snapshot()).repos.find((x) => x.name === name)!;
      repos[key] = { id: r.id, root: r.root, start: git(r.root, "rev-parse", "HEAD"), tracked: git(r.root, "ls-files").split("\n")[0], ignoreTracked: git(r.root, "ls-files", ".gitignore") !== "" };
    }
  });

  after(async () => {
    await answer(undefined);
    for (const r of Object.values(repos)) {
      git(r.root, "reset", "-q", "--hard", r.start);
      for (const name of ["ci-staged.ts", "ci-notes.md", "ci-new.md", "ci-dir", ...(r.ignoreTracked ? [] : [".gitignore"])]) fs.rmSync(path.join(r.root, name), { recursive: true, force: true });
    }
    await send({ type: "refresh" });
    await until("the fixture log again", (s) => s.rows.length === 6);
  });

  it("is the Linyra side bar: a native tree of changes, the message box below it, row menus out of the Command Palette", () => {
    const pkg = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON.contributes;
    assert.deepStrictEqual((pkg.views["linyra-side"] as { id: string; type?: string; name: string }[]).map((v) => [v.id, v.type ?? "tree", v.name]),
      [["linyra.commit", "tree", "Commit"], ["linyra.commitMessage", "webview", "Commit Message"]], "the names as VS Code resolves them");
    const menus = pkg.menus["view/item/context"] as { command: string; when: string }[];
    for (const command of ["linyra.commitPanel.diff", "linyra.commitPanel.rollback", "linyra.openWorkingFile", "linyra.fileHistory", "linyra.copyFilePath"]) {
      assert.ok(menus.some((m) => m.command === command && m.when.includes("view == linyra.commit")), `${command} on the Commit tree's rows`);
    }
    const palette = pkg.menus.commandPalette as { command: string; when: string }[];
    for (const command of ["linyra.commitPanel.diff", "linyra.commitPanel.rollback", "linyra.commitPanel.removeFromVcs", "linyra.commitPanel.delete", "linyra.commitPanel.ignore"]) {
      assert.strictEqual(palette.find((m) => m.command === command)?.when, "false", command);
    }
    // Rollback, Remove from VCS and Delete… are never one another: own names, own icons, own rows.
    const commands = pkg.commands as { command: string; title: string; icon?: string }[];
    const look = (id: string) => { const c = commands.find((x) => x.command === `linyra.commitPanel.${id}`)!; return [c.title, c.icon]; };
    assert.deepStrictEqual(["rollback", "removeFromVcs", "delete"].map(look), [["Rollback…", "$(discard)"], ["Remove from VCS", "$(remove)"], ["Delete…", "$(trash)"]]);
    const offers = (command: string, group: string, contextValue: string) => menus.some((m) => {
      if (m.command !== command || !m.when.includes("view == linyra.commit") || !(m as { group?: string }).group?.startsWith(group)) return false;
      const re = /viewItem =~ \/(.+)\/$/.exec(m.when)?.[1], is = /viewItem == (\S+)$/.exec(m.when)?.[1];
      return re !== undefined ? new RegExp(re).test(contextValue) : is === undefined || is === contextValue;
    });
    const rows = ["commitFile.changed", "commitFile.deleted", "commitFile.added", "commitFile.untracked", "commitFolder.added", "commitRepo.behind.added", "commitList", "commitFolder.unversioned", "commitList.unversioned"];
    const menu = (command: string, group: string) => rows.filter((r) => offers(`linyra.commitPanel.${command}`, group, r));
    assert.deepStrictEqual(menu("rollback", "1_"), ["commitFile.changed", "commitFile.deleted", "commitFolder.added", "commitRepo.behind.added", "commitList"], "Rollback: Changes only, not an added file's own row");
    assert.deepStrictEqual(menu("removeFromVcs", "1_"), ["commitFile.added", "commitFolder.added", "commitRepo.behind.added"], "Remove from VCS: where an added file is");
    assert.deepStrictEqual(menu("delete", "1_"), ["commitFile.added", "commitFile.untracked", "commitFolder.unversioned", "commitList.unversioned"], "Delete…: new files only");
    assert.deepStrictEqual(menu("ignore", "1_"), ["commitFile.untracked", "commitFolder.unversioned"]);
    assert.deepStrictEqual(["rollback", "removeFromVcs", "delete"].map((c) => menu(c, "inline")), [["commitFile.changed", "commitFile.deleted", "commitFolder.added", "commitRepo.behind.added", "commitList"], ["commitFile.added"], ["commitFile.untracked"]],
      "one hover button per row, never two that look alike");
    const keys = (pkg.keybindings as { command: string; key: string; when: string }[]).filter((k) => k.when.includes("linyra.commit"));
    assert.deepStrictEqual(keys.map((k) => [k.command.replace("linyra.commitPanel.", ""), k.key]), [["rollback", "ctrl+alt+z"], ["add", "ctrl+alt+a"], ["diff", "ctrl+d"], ["delete", "delete"], ["history", "ctrl+m"]]);
  });

  it("lists Changes and Unversioned Files by repository: tracked files checked, new files not", async () => {
    fs.appendFileSync(file("web", repos.web.tracked), "\nchanged by the Commit view\n");
    fs.writeFileSync(file("web", "ci-staged.ts"), "export const staged = 1;\n");
    git(repos.web.root, "add", "ci-staged.ts");
    fs.writeFileSync(file("web", "ci-notes.md"), "notes\n");
    fs.appendFileSync(file("api", repos.api.tracked), "\nchanged by the Commit view\n");
    await vscode.commands.executeCommand("linyra.commit.focus");
    await refresh();
    const p = await shows("both repositories' work", (x) => x.visible && x.items.includes("[x] Changes | 3 files") && x.items.includes("[ ] Unversioned Files | 1 file"));
    assert.ok(p.items.some((i) => i.trim() === "[x] acme-web | main · 2 files") && p.items.some((i) => i.trim() === "[x] acme-api | main · 1 file"), p.items.join("\n"));
    assert.ok(p.items.some((i) => i.trim() === "[ ] ci-notes.md"), "a new file waits to be checked");
    assert.strictEqual(p.checked, "3 files checked in 2 repositories", "a staged new file is tracked: checked");
  });

  it("Group By: without repository rows each file names its repository; without directories, its folder", async () => {
    await vscode.commands.executeCommand("linyra.commitPanel.groupRepoOff");
    let p = await shows("no repository rows", (x) => !x.items.some((i) => i.trim().startsWith("[x] acme-web")));
    assert.ok(p.items.some((i) => i.trim() === "[x] ci-staged.ts | acme-web"), p.items.join("\n"));
    assert.ok(p.items.some((i) => i.trim() === "[ ] ci-notes.md | acme-web"));
    await vscode.commands.executeCommand("linyra.commitPanel.groupRepoOn");
    await vscode.commands.executeCommand("linyra.commitPanel.groupDirOff");
    p = await shows("repository rows again", (x) => x.items.some((i) => i.trim() === "[x] acme-web | main · 2 files"));
    assert.strictEqual(p.checked, "3 files checked in 2 repositories", "grouping changes no check");
    await vscode.commands.executeCommand("linyra.commitPanel.groupDirOn");
  });

  it("commits only the checked files, one commit per repository, with one message", async () => {
    await check([row("changes", "web", "ci-staged.ts")], false);
    await check([row("unversioned", "web", "ci-notes.md")], true);
    await shows("the new choice", (x) => x.checked === "3 files checked in 2 repositories" && x.items.includes("[-] Changes | 2 of 3 files checked"));
    await tell({ type: "commit", message: "chore: one message\n\nacross repositories", amend: false, push: false, signOff: false });
    for (const r of Object.values(repos)) {
      await waitFor("a new commit", () => (git(r.root, "rev-parse", "HEAD") !== r.start ? true : undefined));
      assert.strictEqual(git(r.root, "log", "-1", "--format=%s%n%b"), "chore: one message\nacross repositories");
      assert.strictEqual(git(r.root, "rev-parse", "HEAD~1"), r.start, "one commit on top");
    }
    assert.deepStrictEqual(git(repos.web.root, "show", "--name-only", "--format=", "HEAD").split("\n").sort(), ["ci-notes.md", repos.web.tracked].sort(), "the checked files, the new one added");
    assert.deepStrictEqual(git(repos.web.root, "diff", "--cached", "--name-only").split("\n"), ["ci-staged.ts"], "an unchecked staged file stays staged, out of the commit");
    assert.deepStrictEqual(git(repos.api.root, "show", "--name-only", "--format=", "HEAD").split("\n"), [repos.api.tracked]);
    const p = await shows("what is left", (x) => !x.busy && x.items.includes("[ ] Changes | 1 file"));
    assert.ok(!p.items.some((i) => i.includes("Unversioned")), p.items.join("\n"));
    await until("the Log shows the commits", (s) => s.rows.filter((c) => c.subject === "chore: one message").length === 2);
    assert.strictEqual(p.history[0], "chore: one message\n\nacross repositories", "kept for Commit Message History");
  });

  it("Amend, with Author… and Sign-off: the checked files join the last commit, under the new message", async () => {
    const before = git(repos.web.root, "rev-parse", "HEAD");
    fs.appendFileSync(file("web", repos.web.tracked), "amended\n");
    await refresh();
    await shows("the change, checked", (x) => x.checked === "1 file checked");
    await answer("chore: one message");
    assert.strictEqual(await vscode.commands.executeCommand("linyra.commitPanel.history"), "chore: one message\n\nacross repositories", "Commit Message History: picked by its subject");
    await answer("rin <rin@example.com>");
    await tell({ type: "author" });
    assert.strictEqual((await panel()).author, "rin <rin@example.com>");
    await tell({ type: "commit", message: "chore: one message, amended", amend: true, push: false, signOff: true });
    await waitFor("the amended commit", () => (git(repos.web.root, "rev-parse", "HEAD") !== before ? true : undefined));
    assert.strictEqual(git(repos.web.root, "rev-parse", "HEAD~1"), repos.web.start, "still one commit on top: amended, not added");
    assert.strictEqual(git(repos.web.root, "log", "-1", "--format=%s"), "chore: one message, amended");
    assert.strictEqual(git(repos.web.root, "log", "-1", "--format=%an <%ae>|%(trailers:key=Signed-off-by,valueonly)"), "rin <rin@example.com>|dana <dana@example.com>", "the author given, signed off by the committer");
    const p = await panel();
    assert.deepStrictEqual([p.author, p.history.slice(0, 2)], [undefined, ["chore: one message, amended", "chore: one message\n\nacross repositories"]],
      "the author was for that commit");
    assert.match(git(repos.web.root, "show", `HEAD:${repos.web.tracked}`), /amended$/);
    assert.deepStrictEqual(git(repos.web.root, "diff", "--cached", "--name-only").split("\n"), ["ci-staged.ts"], "still staged, still out");
  });

  it("Add to VCS: a new file is added now, and moves to Changes, checked", async () => {
    fs.writeFileSync(file("web", "ci-new.md"), "new\n");
    await refresh();
    await shows("the new file, unversioned", (x) => x.items.includes("[ ] Unversioned Files | 1 file"));
    await vscode.commands.executeCommand("linyra.commitPanel.add", { id: row("unversioned", "web", "ci-new.md") });
    assert.deepStrictEqual(git(repos.web.root, "diff", "--cached", "--name-only").split("\n").sort(), ["ci-new.md", "ci-staged.ts"], "git add, nothing more");
    const p = await shows("it moved to Changes", (x) => !x.items.some((i) => i.includes("Unversioned")) && x.items.some((i) => i.trim() === "[x] ci-new.md"));
    assert.ok(p.items.some((i) => i.trim() === "[ ] ci-staged.ts"), "other choices stay");
  });

  it("Remove from VCS: an added file leaves the index, kept as it is, back under Unversioned Files; no prompt", async () => {
    fs.appendFileSync(file("web", "ci-new.md"), "edited since it was added\n");
    await vscode.commands.executeCommand("linyra.commitPanel.removeFromVcs", { id: row("changes", "web", "ci-new.md") });
    assert.deepStrictEqual(git(repos.web.root, "diff", "--cached", "--name-only").split("\n"), ["ci-staged.ts"], "unstaged, nothing else");
    assert.strictEqual(fs.readFileSync(file("web", "ci-new.md"), "utf8"), "new\nedited since it was added\n", "the file stays as it is");
    await shows("it is unversioned again", (x) => x.items.includes("[ ] Unversioned Files | 1 file") && x.items.some((i) => i.trim() === "[ ] ci-new.md"));
  });

  it("Rollback: tracked files back to the last commit, an added file out of version control; unversioned files untouched", async () => {
    fs.appendFileSync(file("web", repos.web.tracked), "rolled back\n");
    await refresh();
    await shows("three files listed", (x) => x.items.some((i) => i.trim() === "[ ] ci-staged.ts") && x.items.some((i) => i.trim() === "[ ] ci-new.md") && x.checked === "1 file checked");
    const selected = [{ id: row("changes", "web", repos.web.tracked) }, { id: row("changes", "web", "ci-staged.ts") }, { id: row("unversioned", "web", "ci-new.md") }];
    await answer("Rollback");
    await vscode.commands.executeCommand("linyra.commitPanel.rollback", selected[0], selected);
    assert.strictEqual(await vscode.commands.executeCommand("linyra._itest.lastWarning"), "Roll back 2 files in acme-web?", "the unversioned file is not Rollback's");
    assert.strictEqual(git(repos.web.root, "status", "--porcelain", "--", repos.web.tracked), "", "back to the last commit");
    assert.strictEqual(git(repos.web.root, "diff", "--cached", "--name-only"), "", "the added file left the index");
    assert.ok(fs.existsSync(file("web", "ci-staged.ts")) && fs.existsSync(file("web", "ci-new.md")), "no file deleted");
    await shows("both unversioned", (x) => x.items.includes("[ ] Unversioned Files | 2 files") && !x.items.some((i) => i.includes("Changes")));
  });

  it("Add to .gitignore: one line per file, at the repository's root; the file leaves the list", async () => {
    await vscode.commands.executeCommand("linyra.commitPanel.ignore", { id: row("unversioned", "web", "ci-new.md") });
    assert.ok(fs.readFileSync(file("web", ".gitignore"), "utf8").split(/\r?\n/).includes("/ci-new.md"));
    assert.strictEqual(git(repos.web.root, "check-ignore", "ci-new.md"), "ci-new.md");
    await shows("ci-new.md ignored", (x) => !x.items.some((i) => i.trim() === "[ ] ci-new.md") && x.items.some((i) => i.trim().startsWith("[ ] .gitignore") || i.trim().startsWith("[x] .gitignore")));
    await vscode.commands.executeCommand("linyra.commitPanel.ignore", { id: row("unversioned", "web", "ci-new.md") });
    assert.strictEqual(fs.readFileSync(file("web", ".gitignore"), "utf8").split(/\r?\n/).filter((l) => l === "/ci-new.md").length, 1, "once");
  });

  it("Delete…: new files, unversioned or added, from the disk after its own prompt; empty folders go too", async () => {
    fs.mkdirSync(file("web", "ci-dir/deep"), { recursive: true });
    fs.writeFileSync(file("web", "ci-dir/deep/added.md"), "added\n");
    git(repos.web.root, "add", "ci-dir/deep/added.md");
    await refresh();
    await shows("the added file", (x) => x.items.some((i) => i.trim() === "[x] added.md"));
    const selected = [{ id: row("changes", "web", "ci-dir/deep/added.md") }, { id: row("unversioned", "web", "ci-staged.ts") }];
    await answer("No");
    await vscode.commands.executeCommand("linyra.commitPanel.delete", selected[0], selected);
    assert.strictEqual(await vscode.commands.executeCommand("linyra._itest.lastWarning"), "Delete 2 files in acme-web?");
    assert.ok(fs.existsSync(file("web", "ci-staged.ts")), "declined: nothing deleted");
    await answer("Delete");
    await vscode.commands.executeCommand("linyra.commitPanel.delete", selected[0], selected);
    assert.ok(!fs.existsSync(file("web", "ci-staged.ts")) && !fs.existsSync(file("web", "ci-dir")), "the files, and the folders they left empty");
    assert.strictEqual(git(repos.web.root, "diff", "--cached", "--name-only"), "", "the added file left the index first");
    // Put acme-web back: the ignored file and .gitignore.
    fs.rmSync(file("web", "ci-new.md"), { force: true });
    if (repos.web.ignoreTracked) git(repos.web.root, "checkout", "--", ".gitignore"); else fs.rmSync(file("web", ".gitignore"), { force: true });
    await refresh();
    assert.strictEqual(git(repos.web.root, "status", "--porcelain"), "", "nothing left in acme-web");
    await shows("nothing left to commit", (x) => x.items.length === 0);
  });
});

// The Commit side bar: checks, one message for several repositories, a commit of the checked files
// only (git commit --only), Amend and Rollback. Works in acme-web and acme-api and puts both back
// (it runs after the ordered suites, see index.ts).
import * as assert from "assert";
import * as vscode from "vscode";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { CommitWebviewMessage } from "../commitProtocol";
import { ALL, EXTENSION_ID, send, snapshot, until, waitFor } from "./helpers";

interface PanelSnapshot { items: string[]; checked: string; busy: boolean; lastError: string | undefined; visible: boolean; selection: string[] }

describe("Commit side bar", () => {
  const ID = { GIT_AUTHOR_NAME: "dana", GIT_AUTHOR_EMAIL: "dana@example.com", GIT_COMMITTER_NAME: "dana", GIT_COMMITTER_EMAIL: "dana@example.com" };
  const repos: Record<"web" | "api", { id: string; root: string; start: string; tracked: string }> = {} as never;
  const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...ID } }).trim();
  const panel = () => vscode.commands.executeCommand<PanelSnapshot>("linyra._itest.commitPanel");
  const tell = (m: CommitWebviewMessage) => vscode.commands.executeCommand("linyra._itest.commitSend", m);
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
      repos[key] = { id: r.id, root: r.root, start: git(r.root, "rev-parse", "HEAD"), tracked: git(r.root, "ls-files").split("\n")[0] };
    }
  });

  after(async () => {
    await answer(undefined);
    for (const r of Object.values(repos)) {
      git(r.root, "reset", "-q", "--hard", r.start);
      for (const name of ["ci-staged.ts", "ci-notes.md"]) fs.rmSync(path.join(r.root, name), { force: true });
    }
    await send({ type: "refresh" });
    await until("the fixture log again", (s) => s.rows.length === 6);
  });

  it("is the Linyra side bar's view, with its row menus kept out of the Command Palette", () => {
    const pkg = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON.contributes;
    assert.deepStrictEqual(pkg.views["linyra-side"], [{ type: "webview", id: "linyra.commit", name: "Commit", icon: "$(git-commit)" }], "the name as VS Code resolves it");
    const menus = pkg.menus["webview/context"] as { command: string; when: string }[];
    for (const command of ["linyra.commitPanel.diff", "linyra.commitPanel.rollback", "linyra.openWorkingFile", "linyra.fileHistory", "linyra.copyFilePath"]) {
      assert.ok(menus.some((m) => m.command === command && m.when.includes("webviewId == 'linyra.commit'")), `${command} on the Commit view's rows`);
    }
    const palette = pkg.menus.commandPalette as { command: string; when: string }[];
    for (const command of ["linyra.commitPanel.diff", "linyra.commitPanel.rollback"]) assert.strictEqual(palette.find((m) => m.command === command)?.when, "false");
  });

  it("lists Changes and Unversioned Files by repository: tracked files checked, new files not", async () => {
    fs.appendFileSync(file("web", repos.web.tracked), "\nchanged by the Commit view\n");
    fs.writeFileSync(file("web", "ci-staged.ts"), "export const staged = 1;\n");
    git(repos.web.root, "add", "ci-staged.ts");
    fs.writeFileSync(file("web", "ci-notes.md"), "notes\n");
    fs.appendFileSync(file("api", repos.api.tracked), "\nchanged by the Commit view\n");
    await vscode.commands.executeCommand("linyra.commit.focus");
    await tell({ type: "refresh" });
    const p = await shows("both repositories' work", (x) => x.visible && x.items.includes("[x] Changes | 3 files") && x.items.includes("[ ] Unversioned Files | 1 file"));
    assert.ok(p.items.some((i) => i.trim() === "[x] acme-web | 2 files") && p.items.some((i) => i.trim() === "[x] acme-api | 1 file"), p.items.join("\n"));
    assert.ok(p.items.some((i) => i.trim() === "[ ] ci-notes.md"), "a new file waits to be checked");
    assert.strictEqual(p.checked, "3 files checked in 2 repositories", "a staged new file is tracked: checked");
  });

  it("commits only the checked files, one commit per repository, with one message", async () => {
    await tell({ type: "check", ids: [row("changes", "web", "ci-staged.ts")], on: false });
    await tell({ type: "check", ids: [row("unversioned", "web", "ci-notes.md")], on: true });
    await shows("the new choice", (x) => x.checked === "3 files checked in 2 repositories" && x.items.includes("[-] Changes | 3 files"));
    await tell({ type: "commit", message: "chore: one message\n\nacross repositories", amend: false, push: false });
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
  });

  it("Amend: the checked files join the last commit, under the new message", async () => {
    const before = git(repos.web.root, "rev-parse", "HEAD");
    fs.appendFileSync(file("web", repos.web.tracked), "amended\n");
    await tell({ type: "refresh" });
    await shows("the change, checked", (x) => x.checked === "1 file checked");
    await tell({ type: "commit", message: "chore: one message, amended", amend: true, push: false });
    await waitFor("the amended commit", () => (git(repos.web.root, "rev-parse", "HEAD") !== before ? true : undefined));
    assert.strictEqual(git(repos.web.root, "rev-parse", "HEAD~1"), repos.web.start, "still one commit on top: amended, not added");
    assert.strictEqual(git(repos.web.root, "log", "-1", "--format=%s"), "chore: one message, amended");
    assert.match(git(repos.web.root, "show", `HEAD:${repos.web.tracked}`), /amended$/);
    assert.deepStrictEqual(git(repos.web.root, "diff", "--cached", "--name-only").split("\n"), ["ci-staged.ts"], "still staged, still out");
  });

  it("Rollback: the selected rows after one prompt; a new file is deleted", async () => {
    await shows("the staged file listed", (x) => x.items.some((i) => i.trim() === "[ ] ci-staged.ts"));
    await tell({ type: "selection", ids: [row("changes", "web", "ci-staged.ts")] });
    await answer("Discard File");
    await tell({ type: "rollback" });
    await waitFor("the file rolled back", () => (!fs.existsSync(file("web", "ci-staged.ts")) ? true : undefined));
    assert.strictEqual(git(repos.web.root, "status", "--porcelain"), "", "nothing left in acme-web");
    await shows("nothing left to commit", (x) => x.items.length === 0);
  });
});

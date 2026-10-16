import * as assert from "assert";
import * as vscode from "vscode";
import type { OpenDiffArgs } from "../changesTree";
import type { LogSnapshot } from "../logView";
import type { WebviewMessage } from "../protocol";
import type { Pair } from "../compareModel";
import { UNCOMMITTED, type Commit } from "../types";
import { EXPECTED_ORDER } from "./fixture";

const snapshot = () => vscode.commands.executeCommand<LogSnapshot>("polylog._itest.snapshot");
const send = (m: WebviewMessage) => vscode.commands.executeCommand("polylog._itest.send", m);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ALL = { text: "", author: "", mine: false, branch: "", repoIds: null, date: "all" as const };

async function waitFor<T>(what: string, probe: () => PromiseLike<T | undefined> | T | undefined, ms = 20000): Promise<T> {
  const start = Date.now();
  const end = start + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) {
      // On a slow CI runner, name the step that took the time.
      if (Date.now() - start > 3000) console.log(`    (slow wait: ${what}, ${Date.now() - start} ms)`);
      return v;
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}
const until = (what: string, ok: (s: LogSnapshot) => boolean) =>
  waitFor(what, async () => {
    const s = await snapshot();
    return s && ok(s) ? s : undefined;
  });
const diffTab = () =>
  waitFor("a diff editor", () => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    return input instanceof vscode.TabInputTextDiff && (input.modified.scheme === "git" || input.modified.scheme === "polylog") ? input : undefined;
  });
const tabCount = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).length;
const closeEditors = () => vscode.commands.executeCommand("workbench.action.closeAllEditors");
const args = (c: Commit, path: string): OpenDiffArgs => ({ repoId: c.repoId, sha: c.sha, parent: c.parents[0] ?? null, path });
const bySubject = (s: LogSnapshot, prefix: string) => s.rows.find((r) => r.subject.startsWith(prefix))!;

describe("Polylog panel", () => {
  before(async () => {
    await vscode.commands.executeCommand("polylog.open");
    await until("the Log webview", (s) => s.readyCount >= 1 && s.repos.length === 3);
    await send({ type: "filter", filter: ALL });
  });

  it("merges commits from every repository, newest first", async () => {
    const s = await until("six rows", (x) => x.rows.length === 6);
    assert.deepStrictEqual(s.rows.map((r) => r.subject), EXPECTED_ORDER);
    assert.strictEqual(new Set(s.rows.map((r) => r.repoId)).size, 3);
  });

  it("narrows by message and by repository", async () => {
    await send({ type: "filter", filter: { ...ALL, text: "acme-7" } });
    let s = await until("two ACME-7 rows", (x) => x.rows.length === 2);
    assert.deepStrictEqual(s.rows.map((r) => r.subject), ["docs: link ACME-7 from the changelog", "feat: add retry to uploader (ACME-7)"]);
    const web = s.repos.find((r) => r.name === "acme-web")!;
    await send({ type: "filter", filter: { ...ALL, repoIds: [web.id] } });
    s = await until("acme-web rows only", (x) => x.rows.length === 2 && x.rows.every((r) => r.repoId === web.id));
    assert.deepStrictEqual(s.persistedFilter?.repoIds, [web.id], "the ticked repositories are saved for the next window");
    await send({ type: "ready" }); // the webview re-created (a reload, or VS Code dropping it)
    s = await until("the replay", (x) => x.rows.length === 2);
    assert.deepStrictEqual(s.filter.repoIds, [web.id], "and a re-created webview gets them back");
    await send({ type: "filter", filter: ALL });
    await until("six rows again", (x) => x.rows.length === 6);
  });

  it("filters by author, alone and together with search", async () => {
    await send({ type: "filter", filter: { ...ALL, author: "DANA" } });
    let s = await until("dana's three commits", (x) => x.rows.length === 3);
    assert.ok(s.rows.every((r) => r.author === "dana"));
    await send({ type: "filter", filter: { ...ALL, author: "rin@example.com", text: "acme-7" } });
    s = await until("rin's ACME-7 commits", (x) => x.rows.length === 2 && x.rows.every((r) => r.author === "rin"));
    await send({ type: "filter", filter: { ...ALL, author: "dana", text: "acme-7" } });
    await until("no rows: dana never mentions ACME-7", (x) => x.rows.length === 0);
    await send({ type: "filter", filter: ALL });
    await until("six rows again", (x) => x.rows.length === 6);
  });

  it("remembers the Repositories pane width the user dragged to", async () => {
    assert.strictEqual((await snapshot()).layout.repoPaneWidth, 190, "default width");
    await send({ type: "layout", repoPaneWidth: 240 });
    assert.strictEqual((await snapshot()).layout.repoPaneWidth, 240);
    await send({ type: "layout", repoPaneWidth: Number.NaN });
    assert.strictEqual((await snapshot()).layout.repoPaneWidth, 240, "a bad width from the webview is ignored");
  });

  it("Group by Repository is on by default and can be turned off and on", async () => {
    assert.strictEqual((await snapshot()).layout.groupByRepo, true);
    await vscode.commands.executeCommand("polylog.hideRepos");
    assert.strictEqual((await snapshot()).layout.groupByRepo, false);
    await vscode.commands.executeCommand("polylog.showRepos");
    assert.strictEqual((await snapshot()).layout.groupByRepo, true);
  });

  it("several authors: a commit by any of them matches, and the box suggests who committed", async () => {
    await send({ type: "filter", filter: { ...ALL, authors: ["dana"] } });
    await until("dana's three commits", (x) => x.rows.length === 3 && x.rows.every((r) => r.author === "dana"));
    await send({ type: "filter", filter: { ...ALL, authors: ["dana", "rin@example.com"] } });
    await until("dana's and rin's six commits", (x) => x.rows.length === 6);
    await send({ type: "filter", filter: { ...ALL, authors: ["noor"] } });
    await until("nobody named noor", (x) => x.rows.length === 0);
    await send({ type: "filter", filter: ALL });
    await sleep(300);
    assert.strictEqual((await snapshot()).authors.length, 0, "nothing is read until the Author box is focused");
    await send({ type: "wantSuggestions", kind: "authors" });
    const s = await until("author suggestions read", (x) => x.authors.length === 2);
    assert.deepStrictEqual(s.authors.map((a) => [a.name, a.email, a.count]).sort(), [["dana", "dana@example.com", 3], ["rin", "rin@example.com", 3]]);
    await until("six rows again", (x) => x.rows.length === 6);
  });

  it("Me is one more author beside the picked ones", async () => {
    await until("identities read", (x) => x.me.length === 3);
    // Me is dana, except in acme-libs where it is rin. So Me plus rin is every commit
    // except dana's one in acme-libs ("chore: bump deps").
    await send({ type: "filter", filter: { ...ALL, mine: true, authors: ["rin"] } });
    const s = await until("my commits and rin's", (x) => x.rows.length === 5);
    assert.ok(!s.rows.some((r) => r.subject === "chore: bump deps"), "dana is not Me in acme-libs");
    await send({ type: "filter", filter: ALL });
    await until("six rows again", (x) => x.rows.length === 6);
  });

  it("the path filter keeps commits that touched it, in every repository", async () => {
    await send({ type: "filter", filter: { ...ALL, path: "upload.go" } });
    let s = await until("upload.go's commits", (x) => x.rows.length === 2);
    assert.ok(s.rows.every((r) => s.repos.find((p) => p.id === r.repoId)?.name === "acme-api"), "only the repo that has the file");
    await send({ type: "filter", filter: { ...ALL, path: "**/*.md" } });
    s = await until("the markdown commit", (x) => x.rows.length === 1);
    assert.strictEqual(s.rows[0].subject, "docs: link ACME-7 from the changelog", "a glob");
    await send({ type: "filter", filter: { ...ALL, path: "client.ts", authors: ["rin"] } });
    s = await until("rin's commit to client.ts", (x) => x.rows.length === 1);
    assert.strictEqual(s.rows[0].subject, "feat: scaffold web", "path and author together");
    await send({ type: "filter", filter: { ...ALL, path: ":(top)../../etc" } });
    s = await until("an unsafe path ignored", (x) => x.rows.length === 6);
    assert.strictEqual(s.filter.path, undefined, "dropped by the host, never passed to git");
    await send({ type: "filter", filter: { ...ALL, path: "client.ts" } });
    await until("client.ts's commits", (x) => x.rows.length === 2);
    const api = s.repos.find((r) => r.name === "acme-api")!;
    await vscode.commands.executeCommand("polylog.fileHistory", vscode.Uri.file(require("path").join(api.root, "upload.go")));
    s = await until("upload.go history, whatever the path filter", (x) => x.history?.path === "upload.go" && x.rows.length === 2);
    await send({ type: "exitHistory" });
    s = await until("the path filter back", (x) => x.history === null && x.rows.length === 2);
    assert.strictEqual(s.filter.path, "client.ts");
    await send({ type: "filter", filter: ALL });
    await until("six rows again", (x) => x.rows.length === 6);
  });

  it("the uncommitted store follows saves and git events, one repository at a time", async () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const cp = require("child_process") as typeof import("child_process");
    await send({ type: "filter", filter: ALL });
    const web = (await until("six rows", (x) => x.rows.length === 6)).repos.find((r) => r.name === "acme-web")!;
    const git = (...args: string[]) => cp.execFileSync("git", args, { cwd: web.root }).toString().trim();
    const head = git("rev-parse", "HEAD");
    const work = (x: LogSnapshot) => x.uncommitted.find((w) => w.repoId === web.id);
    fs.writeFileSync(path.join(web.root, "client.ts"), "export const ok = false;\n");
    fs.writeFileSync(path.join(web.root, "notes.md"), "todo\n");
    try {
      // Read in the background after the first page: no toggle, nothing to open.
      await send({ type: "refresh" });
      let s = await until("acme-web's uncommitted files", (x) => work(x)?.changes.length === 2);
      assert.deepStrictEqual([work(s)!.staged, [...work(s)!.changes].sort()], [[], ["client.ts", "notes.md"]]);
      assert.ok(!s.rows.some((r) => r.sha === UNCOMMITTED), "the Commit list shows only commits");

      await closeEditors();
      await vscode.commands.executeCommand("polylog.openDiff", { repoId: web.id, sha: UNCOMMITTED, parent: head, path: "client.ts" });
      const input = await waitFor("a working-tree diff", () => {
        const t = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        return t instanceof vscode.TabInputTextDiff && t.modified.scheme === "file" ? t : undefined;
      });
      assert.strictEqual((await vscode.workspace.openTextDocument(input.original)).getText(), "export const ok = true;\n", "the left side is the last commit");

      // A save in the editor reads its repository again.
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(web.root, "notes.md")));
      fs.writeFileSync(path.join(web.root, "extra.ts"), "x\n");
      const edit = new vscode.WorkspaceEdit();
      edit.insert(doc.uri, new vscode.Position(0, 0), "more ");
      await vscode.workspace.applyEdit(edit);
      let mark = await snapshot();
      await doc.save();
      await until("the files after a save", (x) => work(x)?.changes.length === 3);
      // Only the saved file's repository is read again (VS Code's Git reports it too, a moment later).
      await sleep(1500);
      const statusSince = (from: LogSnapshot, to: LogSnapshot) => to.spawnLog.slice(from.spawnLog.length).filter((x) => x.cmd === "status").map((x) => x.root);
      let now = await snapshot();
      const read = statusSince(mark, now);
      assert.ok(read.length > 0 && read.every((root) => root === web.root), `a save re-reads only its own repository, not all of them (read: ${read.join(", ")})`);

      // A save that changes nothing git reports changes nothing.
      mark = now;
      const again = new vscode.WorkspaceEdit();
      again.insert(doc.uri, new vscode.Position(0, 0), "x");
      await vscode.workspace.applyEdit(again);
      await doc.save();
      await sleep(1500);
      now = await snapshot();
      assert.ok(statusSince(mark, now).length > 0, "it was read again");
      assert.deepStrictEqual(work(now), work(mark), "the same files on both sides");
      assert.ok(now.uncommittedChanges - mark.uncommittedChanges <= 1, "at most one change: the file's edit time moved, nothing else");

      // A save outside every repository reads nothing. First let VS Code's Git finish reporting
      // the saves above (on a slow runner its report comes seconds later).
      const quiet = () => waitFor("git to go quiet", async () => {
        const a = await snapshot();
        await sleep(1500);
        const b = await snapshot();
        return b.spawnLog.length === a.spawnLog.length ? b : undefined;
      });
      mark = await quiet();
      const outside = path.join(require("os").tmpdir(), `polylog-outside-${Date.now()}.txt`);
      fs.writeFileSync(outside, "a\n");
      const other = await vscode.workspace.openTextDocument(vscode.Uri.file(outside));
      const edit3 = new vscode.WorkspaceEdit();
      edit3.insert(other.uri, new vscode.Position(0, 0), "b");
      await vscode.workspace.applyEdit(edit3);
      await other.save();
      await sleep(1000);
      // VS Code's Git may still report acme-web on its own; the other repositories stay unread.
      const outsideRead = statusSince(mark, await snapshot());
      assert.ok(outsideRead.every((root) => root === web.root), `a file outside every repository is not a working-tree change (read: ${outsideRead.join(", ")})`);
      await closeEditors();
      fs.rmSync(outside, { force: true });

      // A date change cannot change the working tree: repositories VS Code's Git reports on are
      // not read again (a late report of acme-web's own saves may still read acme-web).
      mark = await quiet();
      assert.ok(mark.reported.length > 0, "VS Code's Git reports on the fixture repositories (else this proves nothing)");
      await send({ type: "filter", filter: { ...ALL, date: "30d" } });
      await until("the 30-day page", (x) => x.filter.date === "30d" && x.stats.reloads > mark.stats.reloads);
      await sleep(300);
      const reread = statusSince(mark, await snapshot()).filter((root) => mark.reported.includes(root) && root !== web.root);
      assert.deepStrictEqual(reread, [], "the working tree is not read again for a date change");
      // Where VS Code's Git reports nothing (here git.autorefresh off), no event keeps them
      // current: those repositories are read every time.
      const gitCfg = () => vscode.workspace.getConfiguration("git");
      await gitCfg().update("autorefresh", false, vscode.ConfigurationTarget.Global);
      try {
        mark = await snapshot();
        await send({ type: "filter", filter: { ...ALL, date: "7d" } });
        await until("the 7-day page", (x) => x.filter.date === "7d" && x.stats.reloads > mark.stats.reloads);
        await waitFor("every repository read again", async () => (new Set(statusSince(mark, await snapshot())).size === mark.repos.length ? true : undefined));
      } finally {
        await gitCfg().update("autorefresh", undefined, vscode.ConfigurationTarget.Global);
      }
      await send({ type: "filter", filter: ALL });
      await until("all time again", (x) => x.filter.date === "all" && x.rows.length === 6);
      mark = await snapshot();
      await send({ type: "refresh" });
      await waitFor("Refresh reads it again", async () => (statusSince(mark, await snapshot()).length >= 3 ? true : undefined));
      // Unticking a repository takes it out of the uncommitted work; ticking it back reads it.
      await send({ type: "filter", filter: { ...ALL, repoIds: s.repos.filter((r) => r.id !== web.id).map((r) => r.id) } });
      await until("acme-web left out", (x) => work(x) === undefined);
      await send({ type: "filter", filter: ALL });
      await until("acme-web back", (x) => work(x)?.changes.length === 3);
    } finally {
      await closeEditors();
      git("checkout", "--", ".");
      git("clean", "-fdq");
    }
    await send({ type: "refresh" });
    await until("six rows, nothing uncommitted", (x) => x.rows.length === 6 && (work(x)?.changes.length ?? 0) + (work(x)?.staged.length ?? 0) === 0);
  });

  it("the Uncommitted view: Staged and Changes, stage, unstage, discard, commit", async () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const cp = require("child_process") as typeof import("child_process");
    await send({ type: "filter", filter: ALL });
    const s0 = await until("six rows", (x) => x.rows.length === 6);
    const web = s0.repos.find((r) => r.name === "acme-web")!;
    const who = { ...process.env, GIT_AUTHOR_NAME: "dana", GIT_AUTHOR_EMAIL: "dana@example.com", GIT_COMMITTER_NAME: "dana", GIT_COMMITTER_EMAIL: "dana@example.com" };
    const git = (...args: string[]) => cp.execFileSync("git", args, { cwd: web.root, env: who }).toString().trim();
    const head = git("rev-parse", "HEAD");
    const view = () => vscode.commands.executeCommand<{ message?: string; items: string[] }>("polylog._itest.uncommitted");
    const answer = (v: string | undefined) => vscode.commands.executeCommand("polylog._itest.answer", v);
    const seen = (what: string, ok: (items: string[]) => boolean) => waitFor(what, async () => { const v = await view(); return ok(v.items) ? v.items : undefined; });
    const staged = () => git("diff", "--cached", "--name-only").split("\n").filter(Boolean).sort();
    fs.writeFileSync(path.join(web.root, "client.ts"), "export const ok = 2;\n");
    fs.writeFileSync(path.join(web.root, "notes.md"), "todo\n");
    fs.writeFileSync(path.join(web.root, "extra.ts"), "x\n");
    git("add", "extra.ts");
    const smart = vscode.workspace.getConfiguration("git");
    try {
      await vscode.commands.executeCommand("polylog.focusUncommitted");
      await send({ type: "refresh" });
      let items = await seen("acme-web's uncommitted files", (i) => i.includes("acme-web | 3 files [repo.stageable]") && i.includes("  Staged | 1") && i.includes("  Changes | 2"));
      assert.ok(items.includes("    notes.md | new"), "untracked files say new");

      await vscode.commands.executeCommand("polylog.stage", { repoId: web.id, group: "changes", path: "client.ts" });
      assert.deepStrictEqual(staged(), ["client.ts", "extra.ts"], "git add, as git itself sees it");
      await seen("client.ts staged", (i) => i.includes("  Staged | 2") && i.includes("  Changes | 1"));
      await vscode.commands.executeCommand("polylog.unstage", { repoId: web.id, group: "staged", path: "client.ts" });
      assert.deepStrictEqual(staged(), ["extra.ts"], "unstaged again");
      await seen("client.ts back in Changes", (i) => i.includes("  Staged | 1") && i.includes("  Changes | 2"));

      // A file row's right-click: Open File opens the workspace copy.
      await vscode.commands.executeCommand("polylog.openWorkingFile", { kind: "file", repoId: web.id, group: "changes", path: "client.ts" });
      await waitFor("client.ts open", () => (vscode.window.activeTextEditor?.document.uri.fsPath === path.join(web.root, "client.ts") ? true : undefined));
      await closeEditors();

      // Discard asks first; Cancel changes nothing.
      await answer("Cancel");
      await vscode.commands.executeCommand("polylog.discard", { repoId: web.id, group: "changes", path: "notes.md" });
      assert.ok(fs.existsSync(path.join(web.root, "notes.md")), "Cancel keeps the file");
      await answer("Discard File");
      await vscode.commands.executeCommand("polylog.discard", { repoId: web.id, group: "changes", path: "notes.md" });
      assert.ok(!fs.existsSync(path.join(web.root, "notes.md")), "a new file is deleted when discarded");
      await seen("notes.md gone", (i) => !i.some((x) => x.includes("notes.md")));

      // Commit… with a message: the staged files only.
      await vscode.commands.executeCommand("polylog.stage", { repoId: web.id, group: "changes", path: "client.ts" });
      await seen("both staged", (i) => i.includes("  Staged | 2"));
      await answer("feat: commit from the view");
      await vscode.commands.executeCommand("polylog.commitRepo", { repoId: web.id });
      assert.strictEqual(git("log", "-1", "--format=%s"), "feat: commit from the view");
      await until("the new commit at the top of the Log", (x) => x.rows[0]?.subject === "feat: commit from the view");
      await seen("acme-web has nothing left", (i) => !i.some((x) => x.startsWith("acme-web")));

      // Nothing staged, git.enableSmartCommit off: it asks; Cancel commits nothing.
      fs.writeFileSync(path.join(web.root, "client.ts"), "export const ok = 3;\n");
      await send({ type: "refresh" });
      await seen("client.ts changed again", (i) => i.includes("acme-web | 1 file [repo.stageable]"));
      await smart.update("enableSmartCommit", false, vscode.ConfigurationTarget.Global);
      const before = git("rev-parse", "HEAD");
      await answer("Cancel");
      await vscode.commands.executeCommand("polylog.commitRepo", { repoId: web.id });
      assert.strictEqual(git("rev-parse", "HEAD"), before, "Cancel: nothing committed");
    } finally {
      await smart.update("enableSmartCommit", undefined, vscode.ConfigurationTarget.Global);
      await answer(undefined); // drop any answer left unused
      await closeEditors();
      git("reset", "-q", "--hard", head);
      git("clean", "-fdq");
    }
    await send({ type: "refresh" });
    await until("six rows again", (x) => x.rows.length === 6);
  });

  it("the Log's Commits | Uncommitted switch: a badge, review rows, the Changes view, then back", async () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const cp = require("child_process") as typeof import("child_process");
    await send({ type: "filter", filter: ALL });
    const s0 = await until("six rows", (x) => x.rows.length === 6);
    const web = s0.repos.find((r) => r.name === "acme-web")!;
    const api = s0.repos.find((r) => r.name === "acme-api")!;
    const git = (root: string, ...args: string[]) => cp.execFileSync("git", args, { cwd: root }).toString().trim();
    fs.writeFileSync(path.join(web.root, "client.ts"), "export const ok = 1;\n");
    fs.writeFileSync(path.join(api.root, "upload.go"), "package upload\n\nfunc Retry() { retry() }\n");
    fs.writeFileSync(path.join(api.root, "notes.md"), "n\n");
    try {
      await send({ type: "refresh" });
      let s = await until("both repositories behind the switch", (x) => x.workRows.length === 2 && x.workTotals.files === 3);
      assert.ok(s.workKnown, "the badge has a number once every repository was read");
      assert.deepStrictEqual(s.workRows.map((r) => r.split(" | ")[0]).sort(), ["acme-api", "acme-web"]);
      assert.ok(s.workRows.some((r) => r.startsWith("acme-api | 2 files · notes.md, upload.go | 1 new")), `the row: preview and tags (${s.workRows.join(" / ")})`);
      assert.ok((s.posts.uncommitted?.count ?? 0) > 0, "the webview was told");
      const before = { rows: s.rows.map((r) => r.subject), filter: s.filter };

      await send({ type: "logMode", mode: "uncommitted" });
      await until("the Uncommitted side", (x) => x.logMode === "uncommitted");
      await send({ type: "selectWork", repoId: api.id });
      s = await until("acme-api's files in the Changes view", (x) => x.changes.items[0]?.startsWith("acme-api | 2 files · not committed") === true);
      assert.deepStrictEqual(s.changes.items.slice(1).sort(), ["  notes.md | new", "  upload.go | +1 −1"]);
      // Its files open the same diffs as the Uncommitted view.
      await closeEditors();
      await vscode.commands.executeCommand("polylog.openDiff", { repoId: api.id, sha: UNCOMMITTED, parent: git(api.root, "rev-parse", "HEAD"), path: "upload.go" });
      await waitFor("a working-tree diff", () => {
        const t = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        return t instanceof vscode.TabInputTextDiff && t.modified.scheme === "file" && t.modified.fsPath.endsWith(path.join("acme-api", "upload.go")) ? true : undefined;
      });

      await send({ type: "logMode", mode: "commits" });
      s = await until("the Commit list again", (x) => x.logMode === "commits");
      assert.deepStrictEqual({ rows: s.rows.map((r) => r.subject), filter: s.filter }, before, "filters and rows exactly as they were");
      assert.ok(!s.changes.items[0]?.includes("not committed"), "the Changes view shows a commit again, not uncommitted work");
    } finally {
      await closeEditors();
      for (const root of [web.root, api.root]) {
        git(root, "checkout", "--", ".");
        git(root, "clean", "-fdq");
      }
    }
    await send({ type: "refresh" });
    await until("nothing uncommitted", (x) => x.workRows.length === 0);
  });

  it("All Files in the Changes view: the commit's whole tree, one folder read at a time", async () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const cp = require("child_process") as typeof import("child_process");
    await send({ type: "filter", filter: ALL });
    const s0 = await until("six rows", (x) => x.rows.length === 6);
    const libs = s0.repos.find((r) => r.name === "acme-libs")!;
    const who = { ...process.env, GIT_AUTHOR_NAME: "rin", GIT_AUTHOR_EMAIL: "rin@example.com", GIT_COMMITTER_NAME: "rin", GIT_COMMITTER_EMAIL: "rin@example.com" };
    const git = (...args: string[]) => cp.execFileSync("git", args, { cwd: libs.root, env: who }).toString().trim();
    const head = git("rev-parse", "HEAD");
    const lsTrees = (from: LogSnapshot, to: LogSnapshot) => to.spawnLog.slice(from.spawnLog.length).filter((x) => x.cmd === "ls-tree").length;
    try {
      // An unchanged folder, then a commit that adds a file two folders deep and deletes another.
      fs.mkdirSync(path.join(libs.root, "lib"), { recursive: true });
      fs.writeFileSync(path.join(libs.root, "lib", "x.ts"), "x\n");
      git("add", "lib/x.ts");
      git("commit", "-q", "-m", "chore: add lib");
      fs.mkdirSync(path.join(libs.root, "src", "a"), { recursive: true });
      fs.writeFileSync(path.join(libs.root, "src", "a", "one.ts"), "one\n");
      git("add", "src/a/one.ts");
      git("rm", "-q", "CHANGELOG.md");
      git("commit", "-q", "-m", "feat: one, without the changelog");
      const sha = git("rev-parse", "HEAD");
      await send({ type: "refresh" });
      // Listed (not necessarily first: both test commits share one second, and ties have a fixed order).
      await until("the new commit", (x) => x.rows.some((r) => r.sha === sha));
      await send({ type: "select", repoId: libs.id, sha });
      await until("its changed files", (x) => x.changes.items.some((i) => i.includes("one.ts")));

      let mark = await snapshot();
      await vscode.commands.executeCommand("polylog.changesShowAll");
      let s = await until("the whole tree", (x) => x.changes.items.some((i) => i.trim().startsWith("package.json")) && x.changes.items.some((i) => i.trim().startsWith("one.ts")));
      const items = s.changes.items.map((i) => i.trim());
      assert.ok(items.includes("package.json |"), `an unchanged file, plain (${items.join(" / ")})`);
      assert.ok(items.some((i) => i.startsWith("CHANGELOG.md | ")), "the deleted file is listed where it was");
      assert.ok(items.some((i) => i.startsWith("one.ts | +1 −0")), "the added file, two folders down, opened because it holds a change");
      assert.ok(items.includes("lib |"), "a folder with no change, closed");
      assert.ok(!items.includes("x.ts |"), "and not read until opened");
      assert.strictEqual(lsTrees(mark, s), 3, "one git ls-tree per folder shown: the root, src, src/a");

      mark = s;
      await vscode.commands.executeCommand("polylog._itest.expandChanges", "lib");
      s = await until("lib's files", (x) => x.changes.items.some((i) => i.trim() === "x.ts |"));
      assert.strictEqual(lsTrees(mark, s), 1, "opening a folder reads that folder only");

      await closeEditors();
      await vscode.commands.executeCommand("polylog.openRevision", { repoId: libs.id, sha, path: "package.json" });
      const doc = await waitFor("package.json at that commit", () => {
        const d = vscode.window.activeTextEditor?.document;
        return (d?.uri.scheme === "git" || d?.uri.scheme === "polylog") && d.uri.path.endsWith("package.json") ? d : undefined;
      });
      assert.strictEqual(doc.getText(), git("show", `${sha}:package.json`) + "\n", "the file as it was at that commit");

      await vscode.commands.executeCommand("polylog.changesShowChanged");
      s = await until("changed files only", (x) => !x.changes.items.some((i) => i.trim().startsWith("package.json")));
      assert.ok(s.changes.items.some((i) => i.includes("one.ts")));
    } finally {
      await Promise.resolve(vscode.commands.executeCommand("polylog.changesShowChanged")).catch(() => undefined);
      await closeEditors();
      git("reset", "-q", "--hard", head);
      git("clean", "-fdq");
    }
    await send({ type: "refresh" });
    await until("six rows again", (x) => x.rows.length === 6);
  });

  it("the Uncommitted view, edge cases: both halves, staged diffs, group discard, smart commit, hooks, drafts", async () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const cp = require("child_process") as typeof import("child_process");
    await send({ type: "filter", filter: ALL });
    const s0 = await until("six rows", (x) => x.rows.length === 6);
    const web = s0.repos.find((r) => r.name === "acme-web")!;
    const who = { ...process.env, GIT_AUTHOR_NAME: "dana", GIT_AUTHOR_EMAIL: "dana@example.com", GIT_COMMITTER_NAME: "dana", GIT_COMMITTER_EMAIL: "dana@example.com" };
    const git = (...args: string[]) => cp.execFileSync("git", args, { cwd: web.root, env: who }).toString().trim();
    const head = git("rev-parse", "HEAD");
    const view = () => vscode.commands.executeCommand<{ message?: string; items: string[]; lastError?: string }>("polylog._itest.uncommitted");
    const answer = (v: string | undefined) => vscode.commands.executeCommand("polylog._itest.answer", v);
    const seen = (what: string, ok: (items: string[]) => boolean) => waitFor(what, async () => { const v = await view(); return ok(v.items) ? v.items : undefined; });
    const write = (f: string, text: string) => fs.writeFileSync(path.join(web.root, f), text);
    const gitCfg = () => vscode.workspace.getConfiguration("git");
    const api = (vscode.extensions.getExtension("vscode.git")!.exports as { getAPI(v: 1): { getRepository(u: vscode.Uri): { inputBox: { value: string } } | null } }).getAPI(1);
    const rightText = async () => {
      const t = await waitFor("a diff", () => { const i = vscode.window.tabGroups.activeTabGroup.activeTab?.input; return i instanceof vscode.TabInputTextDiff ? i : undefined; });
      return (await vscode.workspace.openTextDocument(t.modified)).getText();
    };
    try {
      await vscode.commands.executeCommand("polylog.focusUncommitted");
      // Review Focus 1: staged, then edited again: in both groups; the Staged diff shows the staged text, fresh after each stage.
      write("client.ts", "export const ok = 1;\n");
      git("add", "client.ts");
      write("client.ts", "export const ok = 2;\n");
      await send({ type: "refresh" });
      await seen("client.ts in both groups", (i) => i.includes("  Staged | 1") && i.includes("  Changes | 1"));
      await closeEditors();
      await vscode.commands.executeCommand("polylog.openUncommittedDiff", { repoId: web.id, group: "staged", path: "client.ts" });
      assert.strictEqual(await rightText(), "export const ok = 1;\n", "Staged: the index's version");
      await vscode.commands.executeCommand("polylog.stage", { repoId: web.id, group: "changes", path: "client.ts" });
      await seen("one Staged row, no Changes row", (i) => i.includes("  Staged | 1") && !i.includes("  Changes | 1"));
      // The first diff is still open: a stale index document would show here.
      await vscode.commands.executeCommand("polylog.openUncommittedDiff", { repoId: web.id, group: "staged", path: "client.ts" });
      assert.strictEqual(await rightText(), "export const ok = 2;\n", "staged again: the new index version, not a stale document");
      await closeEditors();

      // Review Focus 2: Discard a group with new files in it.
      write("one.md", "1\n");
      write("two.md", "2\n");
      await send({ type: "refresh" });
      await seen("two new files", (i) => i.some((x) => x.includes("one.md")) && i.some((x) => x.includes("two.md")));
      await answer("Discard All");
      await vscode.commands.executeCommand("polylog.discard", { repoId: web.id, group: "changes" });
      assert.ok(!fs.existsSync(path.join(web.root, "one.md")) && !fs.existsSync(path.join(web.root, "two.md")), "both new files deleted");

      // A failing pre-commit hook: git's own words, and the staged files stay staged.
      const hook = path.join(web.root, ".git", "hooks", "pre-commit");
      fs.writeFileSync(hook, "#!/bin/sh\necho 'acme hook says no' >&2\nexit 1\n", { mode: 0o755 });
      await answer("feat: blocked by the hook");
      await vscode.commands.executeCommand("polylog.commitRepo", { repoId: web.id });
      fs.rmSync(hook);
      const err = (await view()).lastError ?? "";
      assert.match(err, /acme hook says no/, `the hook's message (${err})`);
      assert.deepStrictEqual(git("diff", "--cached", "--name-only"), "client.ts", "still staged");
      assert.strictEqual(git("rev-parse", "HEAD"), head, "nothing committed");

      // A draft in Source Control's message box survives a commit from Polylog.
      const repo = api.getRepository(vscode.Uri.file(web.root))!;
      repo.inputBox.value = "draft: half-written";
      await answer("feat: committed from Polylog");
      await vscode.commands.executeCommand("polylog.commitRepo", { repoId: web.id });
      assert.strictEqual(git("log", "-1", "--format=%s"), "feat: committed from Polylog");
      assert.strictEqual(repo.inputBox.value, "draft: half-written", "the Source Control draft is kept");

      // Review Focus 3: nothing staged, git.enableSmartCommit on: commit all without asking; smartCommitChanges "tracked" leaves new files out.
      write("client.ts", "export const ok = 3;\n");
      write("scratch.md", "scratch\n");
      await send({ type: "refresh" });
      await seen("a change and a new file", (i) => i.some((x) => x.includes("scratch.md")) && i.some((x) => x.includes("client.ts")));
      await gitCfg().update("enableSmartCommit", true, vscode.ConfigurationTarget.Global);
      await gitCfg().update("smartCommitChanges", "tracked", vscode.ConfigurationTarget.Global);
      await answer("feat: smart, tracked only");
      await vscode.commands.executeCommand("polylog.commitRepo", { repoId: web.id });
      assert.strictEqual(git("log", "-1", "--format=%s"), "feat: smart, tracked only", "no question asked: the only answer was the message");
      assert.match(git("status", "--porcelain"), /\?\? scratch\.md/, "the new file was left out");
    } finally {
      await gitCfg().update("enableSmartCommit", undefined, vscode.ConfigurationTarget.Global);
      await gitCfg().update("smartCommitChanges", undefined, vscode.ConfigurationTarget.Global);
      await answer(undefined);
      await closeEditors();
      try { fs.rmSync(path.join(web.root, ".git", "hooks", "pre-commit"), { force: true }); } catch { /* gone */ }
      git("reset", "-q", "--hard", head);
      git("clean", "-fdq");
    }
    await send({ type: "refresh" });
    await until("six rows again", (x) => x.rows.length === 6);
  });

  it("Discard deletes exactly what its prompt listed, and also new files VS Code's Git hides", async () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const cp = require("child_process") as typeof import("child_process");
    const s0 = await until("six rows", (x) => x.rows.length === 6);
    const web = s0.repos.find((r) => r.name === "acme-web")!;
    const view = () => vscode.commands.executeCommand<{ items: string[] }>("polylog._itest.uncommitted");
    const seen = (what: string, ok: (items: string[]) => boolean) => waitFor(what, async () => { const v = await view(); return ok(v.items) ? v.items : undefined; });
    const at = (f: string) => path.join(web.root, f);
    const cfg = vscode.workspace.getConfiguration("git");
    try {
      await vscode.commands.executeCommand("polylog.focusUncommitted");
      fs.writeFileSync(at("listed.md"), "1\n");
      await send({ type: "refresh" });
      await seen("listed.md", (i) => i.some((l) => l.includes("listed.md")));
      // While the confirmation is open, a build writes another new file: it was not in the prompt.
      await vscode.commands.executeCommand("polylog._itest.beforeAnswer", async () => {
        fs.writeFileSync(at("late.md"), "2\n");
        await vscode.commands.executeCommand("polylog.refreshUncommitted");
        await seen("late.md read", (i) => i.some((l) => l.includes("late.md")));
      });
      await vscode.commands.executeCommand("polylog._itest.answer", "Discard All");
      await vscode.commands.executeCommand("polylog.discard", { repoId: web.id, group: "changes" });
      await waitFor("listed.md gone", () => (fs.existsSync(at("listed.md")) ? undefined : true));
      assert.ok(fs.existsSync(at("late.md")), "a file that appeared while the prompt was open is kept");
      // git.untrackedChanges hidden: VS Code's Git does not list new files, Polylog still deletes the one confirmed.
      fs.rmSync(at("late.md"));
      await cfg.update("untrackedChanges", "hidden", vscode.ConfigurationTarget.Global);
      fs.writeFileSync(at("hidden-new.md"), "3\n");
      await vscode.commands.executeCommand("polylog.refreshUncommitted");
      await seen("hidden-new.md", (i) => i.some((l) => l.includes("hidden-new.md")));
      await vscode.commands.executeCommand("polylog._itest.answer", "Discard File");
      await vscode.commands.executeCommand("polylog.discard", { repoId: web.id, group: "changes", path: "hidden-new.md" });
      await waitFor("hidden-new.md deleted", () => (fs.existsSync(at("hidden-new.md")) ? undefined : true));
    } finally {
      await vscode.commands.executeCommand("polylog._itest.beforeAnswer", undefined);
      await vscode.commands.executeCommand("polylog._itest.answer", undefined);
      await cfg.update("untrackedChanges", undefined, vscode.ConfigurationTarget.Global);
      for (const f of ["listed.md", "late.md", "hidden-new.md"]) fs.rmSync(at(f), { force: true });
      cp.execFileSync("git", ["checkout", "--", "."], { cwd: web.root });
    }
    await send({ type: "refresh" });
  });

  it("Discard a staged file, and Discard All Changes on a repository: back to the last commit", async () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const cp = require("child_process") as typeof import("child_process");
    const s0 = await until("six rows", (x) => x.rows.length === 6);
    const web = s0.repos.find((r) => r.name === "acme-web")!;
    const git = (...args: string[]) => cp.execFileSync("git", args, { cwd: web.root }).toString().trim();
    const view = () => vscode.commands.executeCommand<{ items: string[]; lastError?: string }>("polylog._itest.uncommitted");
    const seen = (what: string, ok: (items: string[]) => boolean) => waitFor(what, async () => { const v = await view(); return ok(v.items) ? v.items : undefined; });
    const at = (f: string) => path.join(web.root, f);
    const committed = git("show", "HEAD:client.ts");
    // An earlier test's error stays as the last one shown; Discard must not add its own.
    const errorBefore = (await view()).lastError;
    try {
      await vscode.commands.executeCommand("polylog.focusUncommitted");
      // One staged file: its staged change and its working-tree change both go.
      fs.writeFileSync(at("client.ts"), "export const ok = 1;\n");
      git("add", "client.ts");
      fs.writeFileSync(at("client.ts"), "export const ok = 2;\n");
      await send({ type: "refresh" });
      await seen("client.ts staged and changed", (i) => i.includes("  Staged | 1") && i.includes("  Changes | 1"));
      await vscode.commands.executeCommand("polylog._itest.answer", "Discard File");
      await vscode.commands.executeCommand("polylog.discard", { repoId: web.id, group: "staged", path: "client.ts" });
      await waitFor("client.ts restored", () => (fs.readFileSync(at("client.ts"), "utf8") === `${committed}\n` ? true : undefined));
      assert.strictEqual(git("status", "--porcelain"), "", "nothing staged, nothing changed");

      // The whole repository: a staged edit, a staged new file, an edit, an untracked file.
      fs.writeFileSync(at("client.ts"), "export const ok = 3;\n");
      fs.writeFileSync(at("added.ts"), "export {};\n");
      git("add", "client.ts", "added.ts");
      fs.writeFileSync(at("CHANGELOG.md"), "- edited\n");
      fs.writeFileSync(at("loose.md"), "x\n");
      await send({ type: "refresh" });
      await seen("four files", (i) => i.includes("acme-web | 4 files [repo.stageable]"));
      await vscode.commands.executeCommand("polylog._itest.answer", "Discard All");
      await vscode.commands.executeCommand("polylog.discardAll", { repoId: web.id });
      await waitFor("acme-web clean", () => (git("status", "--porcelain") === "" ? true : undefined));
      assert.ok(!fs.existsSync(at("added.ts")) && !fs.existsSync(at("loose.md")), "new files deleted, staged or not");
      await seen("acme-web has nothing left", (i) => !i.some((x) => x.startsWith("acme-web")));
      assert.strictEqual((await view()).lastError, errorBefore, "no error from Discard");
    } finally {
      await vscode.commands.executeCommand("polylog._itest.answer", undefined);
      git("reset", "-q", "--hard");
      git("clean", "-fdq");
    }
    await send({ type: "refresh" });
  });

  it("the Changes view on the Uncommitted side: Discard a file (staged and edited: one file), Discard All Changes on its root", async () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const s0 = await until("six rows", (x) => x.rows.length === 6);
    const api = s0.repos.find((r) => r.name === "acme-api")!;
    const cp = require("child_process") as typeof import("child_process");
    const git = (root: string, ...args: string[]) => cp.execFileSync("git", args, { cwd: root }).toString().trim();
    const at = (f: string) => path.join(api.root, f);
    const committed = git(api.root, "show", "HEAD:upload.go");
    try {
      fs.writeFileSync(at("upload.go"), "staged\n");
      git(api.root, "add", "upload.go");
      fs.writeFileSync(at("upload.go"), "edited again\n");
      fs.writeFileSync(at("notes.md"), "n\n");
      await send({ type: "refresh" });
      await send({ type: "logMode", mode: "uncommitted" });
      await until("the Uncommitted side", (x) => x.logMode === "uncommitted");
      await send({ type: "selectWork", repoId: api.id });
      await until("acme-api's files in the Changes view", (x) => x.changes.items[0]?.startsWith("acme-api | 2 files") === true);
      // Stage and Unstage from a Changes view row: each takes its own half of the file.
      const node = (p: string) => ({ kind: "file", path: p, owner: { repoId: api.id, sha: UNCOMMITTED, parent: null } });
      await vscode.commands.executeCommand("polylog.stage", node("notes.md"));
      await waitFor("notes.md staged", () => (git(api.root, "diff", "--cached", "--name-only").split("\n").includes("notes.md") ? true : undefined));
      await vscode.commands.executeCommand("polylog.unstage", node("upload.go"));
      await waitFor("upload.go unstaged", () => (git(api.root, "diff", "--cached", "--name-only") === "notes.md" ? true : undefined));
      assert.strictEqual(fs.readFileSync(at("upload.go"), "utf8"), "edited again\n", "Unstage keeps the working-tree edit");
      await vscode.commands.executeCommand("polylog.unstage", node("notes.md"));
      await waitFor("nothing staged", () => (git(api.root, "diff", "--cached", "--name-only") === "" ? true : undefined));
      git(api.root, "add", "upload.go");
      fs.writeFileSync(at("upload.go"), "edited again, after staging\n");
      await send({ type: "refresh" });
      await until("upload.go staged and edited again", (x) => {
        const w = x.uncommitted.find((u) => u.repoId === api.id);
        return w !== undefined && w.staged.includes("upload.go") && w.changes.includes("upload.go");
      });
      // A file node as the Changes view passes it: staged and edited again is still "Discard File".
      await vscode.commands.executeCommand("polylog._itest.answer", "Discard File");
      await vscode.commands.executeCommand("polylog.discard", { kind: "file", path: "upload.go", owner: { repoId: api.id, sha: UNCOMMITTED, parent: null } });
      await waitFor("upload.go restored", () => (fs.readFileSync(at("upload.go"), "utf8") === `${committed}\n` ? true : undefined));
      assert.strictEqual(git(api.root, "status", "--porcelain"), "?? notes.md", "only the other file is left");
      // The root row: everything in the repository.
      await until("acme-api down to one file", (x) => x.changes.items[0]?.startsWith("acme-api | 1 file") === true);
      await vscode.commands.executeCommand("polylog._itest.answer", "Discard All");
      await vscode.commands.executeCommand("polylog.discardAll", { kind: "commit" });
      await waitFor("acme-api clean", () => (git(api.root, "status", "--porcelain") === "" ? true : undefined));
    } finally {
      await vscode.commands.executeCommand("polylog._itest.answer", undefined);
      git(api.root, "reset", "-q", "--hard");
      git(api.root, "clean", "-fdq");
      await send({ type: "logMode", mode: "commits" });
    }
    await send({ type: "refresh" });
  });

  it("bad input is ignored, not thrown: a null message, a malformed File History URI, a ../ diff path, a foreign revision", async () => {
    const s0 = await until("six rows", (x) => x.rows.length === 6);
    const c = bySubject(s0, "feat: add retry");
    // A null message from the webview, and a malformed polylog: URI for File History.
    await send(null as unknown as WebviewMessage);
    await vscode.commands.executeCommand("polylog.fileHistory", vscode.Uri.parse("polylog:/%E0%A4%A?x=%"));
    // A diff of a path that climbs out of the repository: refused, nothing opened.
    const before = vscode.window.tabGroups.all.flatMap((g) => g.tabs).length;
    const opened = await vscode.commands.executeCommand("polylog.openDiff", { repoId: c.repoId, sha: c.sha, parent: c.parents[0], path: "../../etc/passwd" });
    assert.strictEqual(opened, undefined);
    assert.strictEqual(vscode.window.tabGroups.all.flatMap((g) => g.tabs).length, before);
    // A revision document for a folder that is not one of the repositories: empty, no git run.
    const { encodeRevision } = require("../revisionUri") as typeof import("../revisionUri");
    const spawns = (await snapshot()).spawnLog.length;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.from({ scheme: "polylog", ...encodeRevision({ root: "/not/a/repo", ref: c.sha, path: "x.ts" }) }));
    assert.strictEqual(doc.getText(), "");
    assert.ok(!(await snapshot()).spawnLog.slice(spawns).some((x) => x.root === "/not/a/repo"), "no git for a foreign root");
    assert.strictEqual((await snapshot()).rows.length, 6, "the Log is unharmed");
  });

  it("on the Uncommitted side, a refresh or a commit selection leaves its files in the Changes view", async () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const cp = require("child_process") as typeof import("child_process");
    const s0 = await until("six rows", (x) => x.rows.length === 6);
    const web = s0.repos.find((r) => r.name === "acme-web")!;
    fs.writeFileSync(path.join(web.root, "client.ts"), "export const ok = 8;\n");
    try {
      await send({ type: "refresh" });
      await until("acme-web behind the switch", (x) => x.workRows.length === 1);
      await send({ type: "logMode", mode: "uncommitted" });
      const uncommitted = (x: LogSnapshot) => x.changes.items[0]?.includes("not committed") === true;
      await until("its files", uncommitted);
      // A refresh: the commit rows are read again, none of them is the work tree.
      await send({ type: "refresh" });
      await sleep(600);
      assert.ok(uncommitted(await snapshot()), "still the uncommitted files after a refresh");
      // A commit selection (the Commit list re-selects its top row when rows change).
      const c = bySubject(s0, "feat: add retry");
      await send({ type: "select", repoId: c.repoId, sha: c.sha });
      await sleep(600);
      assert.ok(uncommitted(await snapshot()), "a commit selection does not replace them");
      // Back on Commits: that selected commit.
      await send({ type: "logMode", mode: "commits" });
      await until("the selected commit on the Commits side", (x) => x.changes.items.some((i) => i.includes("upload.go")));
    } finally {
      await send({ type: "logMode", mode: "commits" });
      cp.execFileSync("git", ["checkout", "--", "."], { cwd: web.root });
    }
    await send({ type: "refresh" });
    await until("nothing uncommitted", (x) => x.workRows.length === 0);
  });

  it("Commit: nothing to take asks nothing; a failed commit leaves the Log alone; a folder's own git settings apply", async () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const cp = require("child_process") as typeof import("child_process");
    const s0 = await until("six rows", (x) => x.rows.length === 6);
    const web = s0.repos.find((r) => r.name === "acme-web")!;
    const folder = vscode.workspace.workspaceFolders!.find((f) => f.uri.fsPath === web.root)!;
    const cfg = vscode.workspace.getConfiguration("git", folder.uri);
    const asked = () => vscode.commands.executeCommand<number>("polylog._itest.asked");
    const view = () => vscode.commands.executeCommand<{ items: string[]; lastError?: string }>("polylog._itest.uncommitted");
    const hook = path.join(web.root, ".git", "hooks", "pre-commit");
    try {
      await vscode.commands.executeCommand("polylog.focusUncommitted");
      // This folder's own settings (not the user's): smart commit, tracked files only.
      await cfg.update("enableSmartCommit", true, vscode.ConfigurationTarget.WorkspaceFolder);
      await cfg.update("smartCommitChanges", "tracked", vscode.ConfigurationTarget.WorkspaceFolder);
      fs.writeFileSync(path.join(web.root, "brand-new.md"), "x\n");
      await send({ type: "refresh" });
      await waitFor("brand-new.md", async () => ((await view()).items.some((i) => i.includes("brand-new.md")) ? true : undefined));
      const before = await asked();
      await vscode.commands.executeCommand("polylog.commitRepo", { repoId: web.id });
      assert.strictEqual(await asked(), before, "only a new file and tracked-only smart commit: nothing to commit, nothing asked");
      // A failed commit: git's words, and no Log reload.
      fs.writeFileSync(path.join(web.root, "client.ts"), "export const ok = 5;\n");
      cp.execFileSync("git", ["add", "client.ts"], { cwd: web.root });
      fs.writeFileSync(hook, "#!/bin/sh\necho 'acme hook says no' >&2\nexit 1\n", { mode: 0o755 });
      await send({ type: "refresh" });
      await waitFor("staged", async () => ((await view()).items.some((i) => i.includes("Staged | 1")) ? true : undefined));
      const reloads = (await snapshot()).stats.reloads;
      await vscode.commands.executeCommand("polylog._itest.answer", "feat: blocked");
      await vscode.commands.executeCommand("polylog.commitRepo", { repoId: web.id });
      const err = (await view()).lastError ?? "";
      assert.match(err, /acme hook says no/);
      assert.ok(!err.endsWith(".."), `one period (${err})`);
      assert.strictEqual((await snapshot()).stats.reloads, reloads, "a failed commit does not reload the Log");
      const pal = vscode.extensions.getExtension("lntvan166.polylog-git")!.packageJSON.contributes.menus.commandPalette as { command: string; when: string }[];
      assert.strictEqual(pal.find((m) => m.command === "polylog.uncommittedClose")?.when, "polylog.uncommittedShown", "Close only while shown");
    } finally {
      await vscode.commands.executeCommand("polylog._itest.answer", undefined);
      fs.rmSync(hook, { force: true });
      await cfg.update("enableSmartCommit", undefined, vscode.ConfigurationTarget.WorkspaceFolder);
      await cfg.update("smartCommitChanges", undefined, vscode.ConfigurationTarget.WorkspaceFolder);
      // Folder settings live in the repository's .vscode/: gone with the test.
      fs.rmSync(path.join(web.root, ".vscode"), { recursive: true, force: true });
      fs.rmSync(path.join(web.root, "brand-new.md"), { force: true });
      cp.execFileSync("git", ["reset", "-q"], { cwd: web.root });
      cp.execFileSync("git", ["checkout", "--", "."], { cwd: web.root });
    }
    await send({ type: "refresh" });
  });

  it("Commit with the Path box set says how many files the commit really takes, and stops if you decline", async () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const cp = require("child_process") as typeof import("child_process");
    const s0 = await until("six rows", (x) => x.rows.length === 6);
    const web = s0.repos.find((r) => r.name === "acme-web")!;
    const git = (...args: string[]) => cp.execFileSync("git", args, { cwd: web.root }).toString().trim();
    const head = git("rev-parse", "HEAD");
    const view = () => vscode.commands.executeCommand<{ items: string[] }>("polylog._itest.uncommitted");
    try {
      await vscode.commands.executeCommand("polylog.focusUncommitted");
      fs.writeFileSync(path.join(web.root, "client.ts"), "export const ok = 7;\n");
      fs.writeFileSync(path.join(web.root, "outside.md"), "x\n");
      git("add", "client.ts", "outside.md");
      // Both staged first (unfiltered), so the next "Staged | 1" is the Path box's own read.
      await send({ type: "refresh" });
      await waitFor("both staged", async () => ((await view()).items.some((i) => i.includes("Staged | 2")) ? true : undefined));
      await send({ type: "filter", filter: { ...ALL, path: "client.ts" } });
      await waitFor("only client.ts shown", async () => ((await view()).items.some((i) => i.includes("Staged | 1")) ? true : undefined));
      await vscode.commands.executeCommand("polylog._itest.answer", "Cancel");
      await vscode.commands.executeCommand("polylog.commitRepo", { repoId: web.id });
      assert.strictEqual(await vscode.commands.executeCommand("polylog._itest.lastWarning"), "The commit takes 2 files in acme-web, not 1.");
      assert.strictEqual(git("rev-parse", "HEAD"), head, "declined: nothing committed");
    } finally {
      await vscode.commands.executeCommand("polylog._itest.answer", undefined);
      await send({ type: "filter", filter: ALL });
      git("reset", "-q");
      fs.rmSync(path.join(web.root, "outside.md"), { force: true });
      git("checkout", "--", ".");
    }
    await send({ type: "refresh" });
  });

  it("the switch and File History, a re-created webview, the old setting, the Repo menu in the Uncommitted view", async () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const cp = require("child_process") as typeof import("child_process");
    await send({ type: "filter", filter: ALL });
    const s0 = await until("six rows", (x) => x.rows.length === 6);
    const web = s0.repos.find((r) => r.name === "acme-web")!;
    fs.writeFileSync(path.join(web.root, "client.ts"), "export const ok = 9;\n");
    try {
      await send({ type: "refresh" });
      await until("acme-web behind the switch", (x) => x.workRows.length === 1);
      const uv = await vscode.commands.executeCommand<{ description: string }>("polylog._itest.uncommitted");
      assert.strictEqual(uv.description, "1 file · 1 repository", "the Uncommitted view's title counts the work");
      // File History from the Uncommitted side goes back to the Commit list.
      await send({ type: "logMode", mode: "uncommitted" });
      await until("Uncommitted", (x) => x.logMode === "uncommitted");
      await vscode.commands.executeCommand("polylog.fileHistory", { kind: "file", repoId: web.id, group: "changes", path: "client.ts" });
      let s = await until("File History on the Commit list", (x) => x.history?.path === "client.ts" && x.logMode === "commits");
      await until("the history's commits in the Changes view", (x) => !x.changes.items[0]?.includes("not committed") && x.rows.length > 0);
      await send({ type: "exitHistory" });
      await until("history closed", (x) => x.history === null);
      // A re-created webview starts on Commits, and so does the host.
      await send({ type: "logMode", mode: "uncommitted" });
      await until("Uncommitted again", (x) => x.logMode === "uncommitted");
      await send({ type: "ready" });
      s = await until("Commits after a new webview", (x) => x.logMode === "commits");
      // The removed setting is gone (VS Code refuses to write an unregistered one), and the
      // Commit list has no Uncommitted row.
      const props = vscode.extensions.getExtension("lntvan166.polylog-git")!.packageJSON.contributes.configuration.properties as Record<string, unknown>;
      assert.strictEqual(props["polylog.showUncommitted"], undefined);
      await send({ type: "refresh" });
      s = await until("only commits", (x) => x.rows.length === 6);
      assert.ok(!s.rows.some((r) => r.sha === UNCOMMITTED));
      // The Repo menu on the Uncommitted view's repository rows.
      const menus = vscode.extensions.getExtension("lntvan166.polylog-git")!.packageJSON.contributes.menus["view/item/context"] as { command: string; when: string }[];
      for (const c of ["polylog.repoShowOnly", "polylog.repoOpenFolder", "polylog.repoCopyPath", "polylog.repoPull"]) {
        assert.ok(menus.some((m) => m.command === c && m.when.includes("view == polylog.uncommitted") && m.when.includes("repo")), `${c} on a repository row of the Uncommitted view`);
      }
    } finally {
      cp.execFileSync("git", ["checkout", "--", "."], { cwd: web.root });
    }
    await send({ type: "refresh" });
    await until("nothing uncommitted", (x) => x.workRows.length === 0);
  });

  it("Stage needs VS Code's Git: a repository it closes turns review only, and back when reopened", async () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const cp = require("child_process") as typeof import("child_process");
    const s0 = await until("six rows", (x) => x.rows.length === 6);
    const libs = s0.repos.find((r) => r.name === "acme-libs")!;
    const view = () => vscode.commands.executeCommand<{ items: string[] }>("polylog._itest.uncommitted");
    const row = (suffix: string) => waitFor(`acme-libs ${suffix}`, async () => ((await view()).items.some((i) => i.startsWith("acme-libs") && i.endsWith(suffix)) ? true : undefined));
    fs.writeFileSync(path.join(libs.root, "package.json"), "{ \"x\": 1 }\n");
    try {
      await send({ type: "refresh" });
      await row("[repo.stageable]");
      await vscode.commands.executeCommand("git.close", vscode.Uri.file(libs.root));
      await row("[repo.readonly]");
      await vscode.commands.executeCommand("git.openRepository", libs.root);
      await row("[repo.stageable]");
    } finally {
      cp.execFileSync("git", ["checkout", "--", "."], { cwd: libs.root });
    }
  });

  it("Me means each repository's own user.email", async () => {
    await until("identities read", (x) => x.me.length === 3);
    await send({ type: "filter", filter: { ...ALL, mine: true } });
    const s = await until("my commits", (x) => x.rows.length === 3);
    // acme-libs has a repo-local identity (rin); the others use the global one (dana).
    assert.deepStrictEqual(s.rows.map((r) => r.subject), ["docs: link ACME-7 from the changelog", "fix: guard nil response", "feat: scaffold api"]);
    await send({ type: "filter", filter: ALL });
    await until("six rows again", (x) => x.rows.length === 6);
  });

  it("right-click a repository: Show Only, Hide, Show All, Copy Path, Exclude", async () => {
    await send({ type: "filter", filter: ALL });
    const s0 = await until("six rows", (x) => x.rows.length === 6);
    const [web, api, libs] = ["acme-web", "acme-api", "acme-libs"].map((n) => s0.repos.find((r) => r.name === n)!);
    // What VS Code passes from a webview right-click: the element's data-vscode-context.
    const on = (repoId: string, section = "repo") => ({ webviewSection: section, repoId });
    await vscode.commands.executeCommand("polylog.repoShowOnly", on(web.id, "commit"));
    let s = await until("acme-web only", (x) => x.rows.length === 2 && x.rows.every((r) => r.repoId === web.id));
    assert.deepStrictEqual(s.filter.repoIds, [web.id], "from a commit row too, and the filter is the pane's");
    await vscode.commands.executeCommand("polylog.repoShowAll");
    await until("every repository", (x) => x.rows.length === 6 && x.filter.repoIds === null);
    await vscode.commands.executeCommand("polylog.repoHide", on(api.id));
    s = await until("all but acme-api", (x) => x.rows.length > 0 && !x.rows.some((r) => r.repoId === api.id));
    assert.deepStrictEqual(s.filter.repoIds, s0.repos.map((r) => r.id).filter((id) => id !== api.id), "the others stay ticked");
    await vscode.commands.executeCommand("polylog.repoShowAll");
    await until("every repository again", (x) => x.filter.repoIds === null && x.rows.length === 6);
    await vscode.commands.executeCommand("polylog.repoShowOnly", on("/not/a/repo"));
    assert.strictEqual((await snapshot()).filter.repoIds, null, "an id that is not a listed repository is ignored");

    await vscode.commands.executeCommand("polylog.repoCopyPath", on(libs.id));
    assert.strictEqual(await vscode.env.clipboard.readText(), libs.root);

    // With the pane hidden, a commit row's Show Only brings the pane back: no invisible filter.
    await vscode.commands.executeCommand("polylog.hideRepos");
    await vscode.commands.executeCommand("polylog.repoShowOnly", on(web.id, "commit"));
    s = await until("acme-web only, pane shown", (x) => x.filter.repoIds?.length === 1 && x.rows.length === 2);
    assert.strictEqual(s.layout.groupByRepo, true, "the filter is never one the user cannot see");
    await vscode.commands.executeCommand("polylog.repoShowAll");
    await until("every repository", (x) => x.filter.repoIds === null && x.rows.length === 6);

    const cfg = () => vscode.workspace.getConfiguration("polylog");
    // The user's own (global) exclusions stay: arrays do not merge across settings scopes.
    await cfg().update("excludeRepos", ["no-such-repo-*"], vscode.ConfigurationTarget.Global);
    try {
      // Excluding the repo shown alone must not leave a filter that matches nothing.
      await vscode.commands.executeCommand("polylog.repoShowOnly", on(libs.id));
      await until("acme-libs only", (x) => x.filter.repoIds?.[0] === libs.id);
      await vscode.commands.executeCommand("polylog.repoExclude", on(libs.id));
      s = await until("acme-libs left out", (x) => x.repos.length === 2 && !x.repos.some((r) => r.id === libs.id));
      const inspected = cfg().inspect<string[]>("excludeRepos");
      assert.deepStrictEqual(inspected?.globalValue, ["no-such-repo-*", libs.root.replace(/\\/g, "/")], "its exact path, added to the user's own list (not a workspace file inside a repo)");
      assert.strictEqual(inspected?.workspaceValue, undefined);
      s = await until("every remaining repository shown", (x) => x.filter.repoIds === null && x.rows.length > 0);
    } finally {
      await cfg().update("excludeRepos", undefined, vscode.ConfigurationTarget.Global);
    }
    await send({ type: "refresh" });
    await until("three repositories again", (x) => x.repos.length === 3 && x.rows.length === 6);
  });

  it("right-click a repository behind its upstream: Pull, through VS Code's own Git", async () => {
    const cp = require("child_process") as typeof import("child_process");
    const fs = require("fs") as typeof import("fs");
    const os = require("os") as typeof import("os");
    const path = require("path") as typeof import("path");
    await send({ type: "filter", filter: ALL });
    const s0 = await until("six rows", (x) => x.rows.length === 6);
    const web = s0.repos.find((r) => r.name === "acme-web")!;
    const who = { ...process.env, GIT_AUTHOR_NAME: "rin", GIT_AUTHOR_EMAIL: "rin@example.com", GIT_COMMITTER_NAME: "rin", GIT_COMMITTER_EMAIL: "rin@example.com" };
    const git = (cwd: string, ...args: string[]) => cp.execFileSync("git", args, { cwd, env: who }).toString().trim();
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), "polylog-pull-"));
    const branch = git(web.root, "rev-parse", "--abbrev-ref", "HEAD");
    const before = git(web.root, "rev-parse", "HEAD");
    try {
      git(remote, "clone", "-q", "--bare", web.root, "web.git");
      const bare = path.join(remote, "web.git");
      git(web.root, "remote", "add", "origin", bare);
      git(web.root, "fetch", "-q", "origin");
      git(web.root, "branch", `--set-upstream-to=origin/${branch}`, branch);
      const theirs = git(bare, "commit-tree", `${branch}^{tree}`, "-p", branch, "-m", "chore: pulled from the remote");
      git(bare, "update-ref", `refs/heads/${branch}`, theirs);
      await vscode.commands.executeCommand("polylog.fetchAll");
      await until("acme-web behind by one", (x) => x.sync[web.id]?.behind === 1);

      const mark = await snapshot();
      await vscode.commands.executeCommand("polylog.repoPull", { webviewSection: "repo", repoId: web.id });
      await waitFor("the branch at the remote's commit", () => (git(web.root, "rev-parse", "HEAD") === theirs ? true : undefined));
      const ours = (await snapshot()).spawnLog.slice(mark.spawnLog.length).filter((x) => x.cmd === "pull");
      assert.deepStrictEqual(ours, [], "VS Code's own Git pulled it (its Pull, with its settings and messages), not Polylog's fallback");
      const s = await until("the pulled commit in the Log, no badge", (x) => x.sync[web.id] === undefined && x.rows.some((r) => r.subject === "chore: pulled from the remote"));
      assert.strictEqual(s.rows.length, 7);
    } finally {
      const quietly = (f: () => unknown) => { try { f(); } catch { /* not set up */ } };
      quietly(() => git(web.root, "reset", "-q", "--keep", before));
      quietly(() => git(web.root, "branch", "--unset-upstream", branch));
      quietly(() => git(web.root, "remote", "remove", "origin"));
      fs.rmSync(remote, { recursive: true, force: true });
    }
    await send({ type: "refresh" });
    await until("six rows again", (x) => x.rows.length === 6 && x.sync[web.id] === undefined);
  });

  it("Fetch and Pull All: fast-forwards the repositories behind; a diverged one and one with local changes in the way are left as they were", async () => {
    const cp = require("child_process") as typeof import("child_process");
    const fs = require("fs") as typeof import("fs");
    const os = require("os") as typeof import("os");
    const path = require("path") as typeof import("path");
    await send({ type: "filter", filter: ALL });
    const s0 = await until("six rows", (x) => x.rows.length === 6);
    const who = { ...process.env, GIT_AUTHOR_NAME: "rin", GIT_AUTHOR_EMAIL: "rin@example.com", GIT_COMMITTER_NAME: "rin", GIT_COMMITTER_EMAIL: "rin@example.com" };
    const git = (cwd: string, ...args: string[]) => cp.execFileSync("git", args, { cwd, env: who }).toString().trim();
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), "polylog-pullall-"));
    const repos = Object.fromEntries(["acme-web", "acme-api", "acme-libs"].map((n) => {
      const r = s0.repos.find((x) => x.name === n)!;
      return [n, { ...r, branch: git(r.root, "rev-parse", "--abbrev-ref", "HEAD"), before: git(r.root, "rev-parse", "HEAD") }];
    }));
    const web = repos["acme-web"], api = repos["acme-api"], libs = repos["acme-libs"];
    try {
      // Each gets a remote one commit ahead: acme-web's touches nothing local; acme-libs' changes
      // package.json, which has a local edit; acme-api also has a commit of its own (diverged).
      const theirs: Record<string, string> = {};
      for (const [n, r] of Object.entries(repos)) {
        git(remote, "clone", "-q", "--bare", r.root, `${n}.git`);
        const bare = path.join(remote, `${n}.git`);
        git(r.root, "remote", "add", "origin", bare);
        git(r.root, "fetch", "-q", "origin");
        git(r.root, "branch", `--set-upstream-to=origin/${r.branch}`, r.branch);
        const blob = cp.execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: bare, input: n === "acme-libs" ? "{\"v\": 2}\n" : "remote\n" }).toString().trim();
        const idx = path.join(remote, `${n}.index`);
        const env = { ...who, GIT_INDEX_FILE: idx };
        cp.execFileSync("git", ["read-tree", r.branch], { cwd: bare, env });
        cp.execFileSync("git", ["update-index", "--add", "--cacheinfo", `100644,${blob},${n === "acme-libs" ? "package.json" : "REMOTE.md"}`], { cwd: bare, env });
        const tree = cp.execFileSync("git", ["write-tree"], { cwd: bare, env }).toString().trim();
        theirs[n] = git(bare, "commit-tree", tree, "-p", r.branch, "-m", "chore: from the remote");
        git(bare, "update-ref", `refs/heads/${r.branch}`, theirs[n]);
      }
      git(api.root, "commit", "-q", "--allow-empty", "-m", "wip: local only");
      const apiLocal = git(api.root, "rev-parse", "HEAD");
      fs.writeFileSync(path.join(libs.root, "package.json"), "{\"local\": true}\n");
      // merge.autoStash would stash the edit, fast-forward and apply it back with conflict markers.
      git(libs.root, "config", "merge.autoStash", "true");

      const result = await vscode.commands.executeCommand<{ pulled: string[]; skipped: { name: string; reason: string }[] }>("polylog.fetchAndPullAll");
      assert.deepStrictEqual(result.pulled, ["acme-web"]);
      assert.deepStrictEqual(result.skipped.map((x) => `${x.name}: ${x.reason}`).sort(), ["acme-api: it has diverged from its upstream", "acme-libs: local changes to the same files"]);
      assert.strictEqual(git(web.root, "rev-parse", "HEAD"), theirs["acme-web"], "fast-forwarded to the remote's commit");
      assert.strictEqual(git(api.root, "rev-parse", "HEAD"), apiLocal, "a diverged branch is not touched");
      assert.strictEqual(git(libs.root, "rev-parse", "HEAD"), libs.before, "nothing merged over local changes");
      assert.strictEqual(fs.readFileSync(path.join(libs.root, "package.json"), "utf8"), "{\"local\": true}\n", "the local edit kept");
      assert.strictEqual(git(libs.root, "stash", "list"), "", "nothing stashed");
      await until("acme-web no longer behind", (x) => x.sync[web.id] === undefined && x.sync[libs.id]?.behind === 1);
    } finally {
      const quietly = (f: () => unknown) => { try { f(); } catch { /* not set up */ } };
      for (const r of Object.values(repos)) {
        quietly(() => git(r.root, "checkout", "-q", "--", "."));
        quietly(() => git(r.root, "reset", "-q", "--hard", r.before));
        quietly(() => git(r.root, "branch", "--unset-upstream", r.branch));
        quietly(() => git(r.root, "remote", "remove", "origin"));
      }
      quietly(() => git(libs.root, "config", "--unset", "merge.autoStash"));
      fs.rmSync(remote, { recursive: true, force: true });
      // In the cleanup: a failure here must not leave stale ↓ marks for the tests after it.
      await send({ type: "refresh" });
      await until("six rows again", (x) => x.rows.length === 6 && Object.keys(x.sync).length === 0);
    }
  });

  it("right-click a commit: Copy Commit ID, Copy Message, Open on Remote", async () => {
    const cp = require("child_process") as typeof import("child_process");
    await send({ type: "filter", filter: ALL });
    const s = await until("six rows", (x) => x.rows.length === 6);
    const c = bySubject(s, "feat: add retry to uploader");
    const repo = s.repos.find((r) => r.id === c.repoId)!;
    const on = { webviewSection: "commit", repoId: c.repoId, sha: c.sha };
    await vscode.commands.executeCommand("polylog.commitCopySha", on);
    assert.strictEqual(await vscode.env.clipboard.readText(), c.sha);
    await vscode.commands.executeCommand("polylog.commitCopyMessage", on);
    const full = cp.execFileSync("git", ["show", "-s", "--format=%B", c.sha], { cwd: repo.root }).toString().trim();
    assert.strictEqual(await vscode.env.clipboard.readText(), full, "the whole message, not only the subject the row shows");

    const git = (...args: string[]) => cp.execFileSync("git", args, { cwd: repo.root }).toString().trim();
    assert.strictEqual(await vscode.commands.executeCommand("polylog.commitOpenOnRemote", on), undefined, "no remote: nothing to open");
    git("remote", "add", "origin", "git@github.com:acme/acme-api.git");
    try {
      assert.strictEqual(await vscode.commands.executeCommand("polylog.commitOpenOnRemote", on), `https://github.com/acme/acme-api/commit/${c.sha}`);
    } finally {
      git("remote", "remove", "origin");
    }
    await vscode.env.clipboard.writeText("unchanged");
    await vscode.commands.executeCommand("polylog.commitCopySha", { ...on, sha: "not-a-sha" });
    await vscode.commands.executeCommand("polylog.commitCopySha", { ...on, sha: UNCOMMITTED });
    assert.strictEqual(await vscode.env.clipboard.readText(), "unchanged", "only a real commit of a listed repository");
  });

  it("the Repositories pane shows how far each repository is from its upstream, following VS Code's Git", async () => {
    const cp = require("child_process") as typeof import("child_process");
    const web = (await snapshot()).repos.find((r) => r.name === "acme-web")!;
    const git = (...args: string[]) => cp.execFileSync("git", args, { cwd: web.root }).toString().trim();
    const branch = git("rev-parse", "--abbrev-ref", "HEAD");
    // An upstream one commit ahead (made without touching the working tree).
    const theirs = cp.execFileSync("git", ["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "theirs"], {
      cwd: web.root, env: { ...process.env, GIT_AUTHOR_NAME: "rin", GIT_AUTHOR_EMAIL: "rin@example.com", GIT_COMMITTER_NAME: "rin", GIT_COMMITTER_EMAIL: "rin@example.com" },
    }).toString().trim();
    git("update-ref", "refs/heads/polylog-up", theirs);
    git("branch", "--set-upstream-to=polylog-up", branch);
    try {
      // No Refresh: VS Code's Git reports the new upstream; that repo is read again. Its file
      // watcher may not see a .git/config change on every runner, so ask it to look (its own status).
      const api = (vscode.extensions.getExtension("vscode.git")!.exports as { getAPI(v: 1): { getRepository(u: vscode.Uri): { status(): Promise<void> } | null } }).getAPI(1);
      await api.getRepository(vscode.Uri.file(web.root))?.status();
      const s = await until("acme-web behind by one", (x) => x.sync[web.id]?.behind === 1);
      assert.deepStrictEqual(s.sync[web.id], { ahead: 0, behind: 1 });
      assert.ok(Object.keys(s.sync).every((id) => id === web.id), "repositories without an upstream show nothing");
    } finally {
      git("branch", "--unset-upstream", branch);
      git("branch", "-D", "polylog-up");
    }
    // Cleanup, not what is tested: Refresh reads every repository again (VS Code's Git may
    // report the removed upstream late on a busy runner).
    await send({ type: "refresh" });
    await until("no badge once it has no upstream", (x) => x.sync[web.id] === undefined && x.rows.length > 0);
  });

  it("Fetch All fetches every repository, then Show Only Repositories Behind picks the ones to pull", async () => {
    const cp = require("child_process") as typeof import("child_process");
    const fs = require("fs") as typeof import("fs");
    const os = require("os") as typeof import("os");
    const path = require("path") as typeof import("path");
    await send({ type: "filter", filter: ALL });
    const s0 = await until("six rows", (x) => x.rows.length === 6);
    const web = s0.repos.find((r) => r.name === "acme-web")!;
    const api = s0.repos.find((r) => r.name === "acme-api")!;
    const who = { ...process.env, GIT_AUTHOR_NAME: "rin", GIT_AUTHOR_EMAIL: "rin@example.com", GIT_COMMITTER_NAME: "rin", GIT_COMMITTER_EMAIL: "rin@example.com" };
    const git = (cwd: string, ...args: string[]) => cp.execFileSync("git", args, { cwd, env: who }).toString().trim();
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), "polylog-remote-"));
    const branch = git(web.root, "rev-parse", "--abbrev-ref", "HEAD");
    try {
      git(remote, "clone", "-q", "--bare", web.root, "web.git");
      const bare = path.join(remote, "web.git");
      git(web.root, "remote", "add", "origin", bare);
      git(web.root, "fetch", "-q", "origin");
      git(web.root, "branch", `--set-upstream-to=origin/${branch}`, branch);
      // acme-api's remote cannot be reached: its fetch fails, the others still run.
      git(api.root, "remote", "add", "origin", path.join(remote, "missing.git"));
      // Someone pushed a commit: it is on the remote only.
      const theirs = git(bare, "commit-tree", `${branch}^{tree}`, "-p", branch, "-m", "theirs");
      git(bare, "update-ref", `refs/heads/${branch}`, theirs);
      assert.strictEqual((await snapshot()).sync[web.id], undefined, "not known before a fetch: Polylog never fetches on its own");
      const running = vscode.commands.executeCommand<{ fetched: number; failed: string[]; summary?: string }>("polylog.fetchAll");
      assert.strictEqual((await snapshot()).fetching, true, "the toolbar shows it is fetching");
      const result = await running;
      assert.deepStrictEqual(result, { fetched: 2, failed: ["acme-api"] }, "every repository fetched; the unreachable one named");
      assert.strictEqual((await snapshot()).fetching, false);
      // The unreachable remote gone: every fetch succeeds, and the status bar says what it found.
      git(api.root, "remote", "remove", "origin");
      const ok = await vscode.commands.executeCommand<{ fetched: number; failed: string[]; summary?: string }>("polylog.fetchAll");
      assert.strictEqual(ok.summary, "Polylog: fetched 3 repositories · 1 behind its upstream");
      const s = await until("acme-web behind by one", (x) => x.sync[web.id]?.behind === 1);
      assert.deepStrictEqual(s.sync[web.id], { ahead: 0, behind: 1 });

      await vscode.commands.executeCommand("polylog.showBehind");
      await until("only the repository behind", (x) => x.filter.repoIds?.join() === web.id && x.rows.every((r) => r.repoId === web.id));
      await vscode.commands.executeCommand("polylog.repoShowAll");
      await until("every repository", (x) => x.filter.repoIds === null && x.rows.length === 6);
    } finally {
      // Each step on its own: one failing must not leave the others' state for later tests.
      const quietly = (f: () => unknown) => { try { f(); } catch { /* not set up */ } };
      quietly(() => git(web.root, "branch", "--unset-upstream", branch));
      quietly(() => git(web.root, "remote", "remove", "origin"));
      quietly(() => git(api.root, "remote", "remove", "origin"));
      fs.rmSync(remote, { recursive: true, force: true });
    }
    await send({ type: "refresh" });
    await until("no badge without the remote", (x) => x.sync[web.id] === undefined && x.rows.length === 6);
  });

  it("hiding the Repositories pane clears its repo filter", async () => {
    const web = (await snapshot()).repos.find((r) => r.name === "acme-web")!;
    await send({ type: "filter", filter: { ...ALL, repoIds: [web.id] } });
    await until("acme-web only", (x) => x.rows.length === 2);
    await vscode.commands.executeCommand("polylog.hideRepos");
    const s = await until("every repo again", (x) => x.rows.length === 6);
    assert.strictEqual(s.filter.repoIds, null, "no invisible filter left behind");
    await vscode.commands.executeCommand("polylog.showRepos");
  });

  it("fills the native Changes tree when a commit is selected", async () => {
    const c = bySubject(await snapshot(), "feat: add retry");
    await send({ type: "select", repoId: c.repoId, sha: c.sha });
    const s = await until("the tree for the retry commit", (x) => x.changes.items.some((i) => i.includes("upload.go")));
    assert.strictEqual(s.changes.message, undefined);
    assert.match(s.changes.items[0], /^feat: add retry to uploader \(ACME-7\) \| [0-9a-f]{7} · rin · /);
    assert.deepStrictEqual(s.changes.items.slice(1), ["  upload.go | +2 −0"]);
    assert.strictEqual(s.changes.description, `acme-api · ${c.sha.slice(0, 7)} · 1 file`, "the title says which repository and commit");
  });

  it("the tree follows the last selection, not a slower earlier one", async () => {
    const s0 = await snapshot();
    const a = bySubject(s0, "chore: bump deps");
    const b = bySubject(s0, "fix: guard nil");
    // Not awaited: the second selection must race the first, as holding ↓ does.
    void send({ type: "select", repoId: a.repoId, sha: a.sha });
    await send({ type: "select", repoId: b.repoId, sha: b.sha });
    const s = await until("the tree for the last selection", (x) => x.changes.items[0]?.startsWith("fix: guard nil") && x.changes.message === undefined);
    await sleep(500);
    assert.ok((await snapshot()).changes.items[0].startsWith("fix: guard nil"), "an earlier, slower detail overwrote the tree");
    assert.deepStrictEqual(s.changes.items.slice(1), ["  client.ts | +1 −1"]);
  });

  it("opens a file's diff in the editor area", async () => {
    await closeEditors();
    const c = bySubject(await snapshot(), "feat: add retry");
    await vscode.commands.executeCommand("polylog.openDiff", args(c, "upload.go"));
    const input = await diffTab();
    assert.strictEqual((await vscode.workspace.openTextDocument(input.original)).getText(), "package upload\n");
    assert.match((await vscode.workspace.openTextDocument(input.modified)).getText(), /func Retry/);
  });

  it("Open File on a diff opens the file as it is in the workspace now", async () => {
    await closeEditors();
    const c = bySubject(await snapshot(), "feat: scaffold api");
    await vscode.commands.executeCommand("polylog.openDiff", args(c, "upload.go"));
    const input = await diffTab();
    // The editor title button passes the diff's modified side.
    await vscode.commands.executeCommand("polylog.openWorkingFile", input.modified);
    const editor = await waitFor("the workspace file", () => {
      const e = vscode.window.activeTextEditor;
      return e?.document.uri.scheme === "file" ? e : undefined;
    });
    const api = (await snapshot()).repos.find((r) => r.name === "acme-api")!;
    assert.strictEqual(editor.document.uri.fsPath, require("path").join(api.root, "upload.go"));
    assert.match(editor.document.getText(), /func Retry/, "today's content, not the revision's");
  });

  it("Open File from a Changes file's right-click opens the workspace file", async () => {
    await closeEditors();
    const c = bySubject(await snapshot(), "fix: guard nil");
    await send({ type: "select", repoId: c.repoId, sha: c.sha });
    await until("the tree for that commit", (x) => x.changes.items.some((i) => i.includes("client.ts")));
    // The tree passes its file node, as for File History.
    await vscode.commands.executeCommand("polylog.openWorkingFile", { kind: "file", path: "client.ts" });
    const editor = await waitFor("the workspace file", () => {
      const e = vscode.window.activeTextEditor;
      return e?.document.uri.scheme === "file" ? e : undefined;
    });
    assert.match(editor.document.uri.fsPath, /acme-web[\\/]client\.ts$/);
    await closeEditors();
  });

  it("menu parity: commit actions from the Changes root and a Compare row, Copy Path, File History from Compare, Stage/Unstage All", async () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const cp = require("child_process") as typeof import("child_process");
    const s0 = await until("six rows", (x) => x.rows.length === 6);
    const web = s0.repos.find((r) => r.name === "acme-web")!;
    const c = bySubject(s0, "fix: guard nil");
    const clip = async () => vscode.env.clipboard.readText();
    // The Changes view's root row (a commit): Copy Commit ID and Copy Message, as on the Log's row.
    await send({ type: "select", repoId: c.repoId, sha: c.sha });
    await until("the tree for that commit", (x) => x.changes.items.some((i) => i.includes("client.ts")));
    await vscode.commands.executeCommand("polylog.commitCopySha", { kind: "commit" });
    assert.strictEqual(await clip(), c.sha);
    await vscode.commands.executeCommand("polylog.commitCopyMessage", { kind: "commit" });
    assert.strictEqual(await clip(), "fix: guard nil response");
    // A Compare commit row passes its node: { kind, repoId, commit }.
    await vscode.env.clipboard.writeText("");
    await vscode.commands.executeCommand("polylog.commitCopySha", { kind: "commit", id: "x", repoId: c.repoId, commit: { sha: c.sha } });
    assert.strictEqual(await clip(), c.sha);
    // Copy Path and Copy Relative Path from a Changes file row.
    await vscode.commands.executeCommand("polylog.copyRelativePath", { kind: "file", path: "client.ts" });
    assert.strictEqual(await clip(), "client.ts");
    await vscode.commands.executeCommand("polylog.copyFilePath", { kind: "file", path: "client.ts" });
    assert.strictEqual(await clip(), path.join(web.root, "client.ts"));
    // File History from a Compare file row (it has a side).
    await vscode.commands.executeCommand("polylog.fileHistory", { kind: "file", id: "x", repoId: web.id, side: "left", path: "client.ts", name: "client.ts", file: { path: "client.ts", added: 1, deleted: 0 }, both: false });
    await until("File History from Compare", (x) => x.history?.path === "client.ts");
    await send({ type: "exitHistory" });
    await until("history closed", (x) => x.history === null);
    // Stage All and Unstage All on an Uncommitted view repository row.
    const git = (...args: string[]) => cp.execFileSync("git", args, { cwd: web.root }).toString().trim();
    try {
      fs.writeFileSync(path.join(web.root, "client.ts"), "export const ok = 9;\n");
      fs.writeFileSync(path.join(web.root, "extra.md"), "x\n");
      await send({ type: "refresh" });
      await until("two changed files", (x) => x.uncommitted.find((u) => u.repoId === web.id)?.changes.length === 2);
      await vscode.commands.executeCommand("polylog.stageAll", { kind: "repo", repoId: web.id });
      await waitFor("both staged", () => (git("diff", "--cached", "--name-only").split("\n").sort().join(",") === "client.ts,extra.md" ? true : undefined));
      await until("both staged in the store", (x) => x.uncommitted.find((u) => u.repoId === web.id)?.staged.length === 2);
      await vscode.commands.executeCommand("polylog.unstageAll", { kind: "repo", repoId: web.id });
      await waitFor("nothing staged", () => (git("diff", "--cached", "--name-only") === "" ? true : undefined));
    } finally {
      git("reset", "-q", "--hard");
      git("clean", "-fdq");
    }
    await send({ type: "refresh" });
  });

  it("several selected rows: one Stage, one Discard prompt across repositories; a Changes view folder stages its files", async () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const cp = require("child_process") as typeof import("child_process");
    const s0 = await until("six rows", (x) => x.rows.length === 6);
    const web = s0.repos.find((r) => r.name === "acme-web")!;
    const api = s0.repos.find((r) => r.name === "acme-api")!;
    const git = (root: string, ...args: string[]) => cp.execFileSync("git", args, { cwd: root }).toString().trim();
    const work = (x: LogSnapshot, id: string) => x.uncommitted.find((u) => u.repoId === id);
    const row = (repoId: string, p: string) => ({ kind: "file", repoId, group: "changes", path: p });
    try {
      fs.mkdirSync(path.join(web.root, "docs"), { recursive: true });
      fs.writeFileSync(path.join(web.root, "docs", "a.md"), "a\n");
      fs.writeFileSync(path.join(web.root, "docs", "b.md"), "b\n");
      fs.writeFileSync(path.join(web.root, "client.ts"), "export const ok = 7;\n");
      fs.writeFileSync(path.join(api.root, "upload.go"), "changed\n");
      await send({ type: "refresh" });
      await until("work in both", (x) => work(x, web.id)?.changes.length === 3 && work(x, api.id)?.changes.length === 1);
      // Stage two selected rows: the right-clicked one and the rest of the selection.
      await vscode.commands.executeCommand("polylog.stage", row(web.id, "docs/a.md"), [row(web.id, "docs/a.md"), row(web.id, "client.ts")]);
      await waitFor("two staged", () => (git(web.root, "diff", "--cached", "--name-only").split("\n").sort().join(",") === "client.ts,docs/a.md" ? true : undefined));
      git(web.root, "reset", "-q");
      await send({ type: "refresh" });
      await until("nothing staged in the store", (x) => work(x, web.id)?.staged.length === 0);
      // A Changes view folder on the Uncommitted side: Stage takes every file under it.
      await send({ type: "logMode", mode: "uncommitted" });
      await until("the Uncommitted side", (x) => x.logMode === "uncommitted");
      await send({ type: "selectWork", repoId: web.id });
      await until("acme-web in the Changes view", (x) => x.changes.items[0]?.startsWith("acme-web") === true);
      await vscode.commands.executeCommand("polylog.stage", { kind: "folder", path: "docs" });
      await waitFor("docs staged", () => (git(web.root, "diff", "--cached", "--name-only").split("\n").sort().join(",") === "docs/a.md,docs/b.md" ? true : undefined));
      await send({ type: "logMode", mode: "commits" });
      await send({ type: "refresh" });
      await until("docs staged in the store", (x) => work(x, web.id)?.staged.length === 2);
      // Discard rows of two repositories: one prompt for all of them.
      await vscode.commands.executeCommand("polylog._itest.answer", "Discard All");
      await vscode.commands.executeCommand("polylog.discard", row(web.id, "client.ts"), [row(web.id, "client.ts"), row(api.id, "upload.go")]);
      assert.strictEqual(await vscode.commands.executeCommand("polylog._itest.lastWarning"), "Discard changes in 2 files in 2 repositories?");
      await waitFor("both restored", () => (git(web.root, "status", "--porcelain", "--", "client.ts") === "" && git(api.root, "status", "--porcelain") === "" ? true : undefined));
      assert.strictEqual(git(web.root, "diff", "--cached", "--name-only").split("\n").sort().join(","), "docs/a.md,docs/b.md", "rows not selected are left alone");
    } finally {
      await vscode.commands.executeCommand("polylog._itest.answer", undefined);
      await send({ type: "logMode", mode: "commits" });
      for (const r of [web, api]) {
        git(r.root, "reset", "-q", "--hard");
        git(r.root, "clean", "-fdq");
      }
    }
    await send({ type: "refresh" });
  });

  it("profiles: read from polylog.profiles, switched by Show and Switch Profile…, other filters kept", async () => {
    const s0 = await until("six rows", (x) => x.rows.length === 6);
    const id = (name: string) => s0.repos.find((r) => r.name === name)!.id;
    const cfg = vscode.workspace.getConfiguration("polylog");
    try {
      await cfg.update("profiles", { backend: ["acme-api", "acme-libs", "acme-jobs"], web: ["acme-web"], bad: "acme-web" }, vscode.ConfigurationTarget.Workspace);
      let s = await until("profiles resolved", (x) => x.profiles.length === 2);
      assert.deepStrictEqual(s.profiles.map((p) => [p.name, p.ids, p.missing]), [
        ["backend", [id("acme-api"), id("acme-libs")], ["acme-jobs"]],
        ["web", [id("acme-web")], []],
      ], "a malformed profile is skipped; a missing repository is reported, not an error");
      // A filter set beforehand stays: a profile changes only the repositories.
      await send({ type: "filter", filter: { ...s.filter, author: "dana" } });
      await vscode.commands.executeCommand("polylog.profileShow", { webviewSection: "profile", profile: "backend" });
      s = await until("backend ticked", (x) => x.filter.repoIds?.join() === [id("acme-api"), id("acme-libs")].join());
      assert.strictEqual(s.filter.author, "dana", "Author kept");
      await vscode.commands.executeCommand("polylog._itest.answer", "web");
      await vscode.commands.executeCommand("polylog.profileSwitch");
      await until("web ticked", (x) => x.filter.repoIds?.join() === id("acme-web"));
      await vscode.commands.executeCommand("polylog._itest.answer", "All repositories");
      await vscode.commands.executeCommand("polylog.profileSwitch");
      await until("All again", (x) => x.filter.repoIds === null);
    } finally {
      await vscode.commands.executeCommand("polylog._itest.answer", undefined);
      await cfg.update("profiles", undefined, vscode.ConfigurationTarget.Workspace);
      await send({ type: "filter", filter: ALL });
    }
    await until("no profiles, six rows again", (x) => x.profiles.length === 0 && x.rows.length === 6);
  });

  it("profiles: save the ticks, a repository's Profiles…, update, rename (refuses a taken name), delete asks", async () => {
    const s0 = await until("six rows", (x) => x.rows.length === 6);
    const id = (name: string) => s0.repos.find((r) => r.name === name)!.id;
    const cfg = vscode.workspace.getConfiguration("polylog");
    const saved = () => cfg.inspect<Record<string, string[]>>("profiles")?.workspaceValue;
    const answer = (v: string | undefined) => vscode.commands.executeCommand("polylog._itest.answer", v);
    try {
      await send({ type: "filter", filter: { ...ALL, repoIds: [id("acme-api"), id("acme-libs")] } });
      await answer("backend");
      await vscode.commands.executeCommand("polylog.profileSave");
      await waitFor("backend saved", () => (saved()?.backend?.join() === "acme-api,acme-libs" ? true : undefined));
      await until("backend resolved", (x) => x.profiles.some((p) => p.name === "backend"));
      // A repository's Profiles…: add acme-web to backend and make a new profile with it.
      await answer(JSON.stringify(["backend", "New profile with acme-web…"]));
      await answer("web");
      await vscode.commands.executeCommand("polylog.repoProfiles", { webviewSection: "repo", repoId: id("acme-web") });
      await waitFor("memberships", () => (saved()?.backend?.join() === "acme-api,acme-libs,acme-web" && saved()?.web?.join() === "acme-web" ? true : undefined));
      // ...and take it out again: unticked = removed.
      await answer(JSON.stringify([]));
      await vscode.commands.executeCommand("polylog.repoProfiles", { webviewSection: "repo", repoId: id("acme-web") });
      await waitFor("removed", () => (saved()?.backend?.join() === "acme-api,acme-libs" && saved()?.web?.length === 0 ? true : undefined));
      // Update to Current Selection.
      await send({ type: "filter", filter: { ...ALL, repoIds: [id("acme-api")] } });
      await vscode.commands.executeCommand("polylog.profileUpdate", { webviewSection: "profile", profile: "backend" });
      await waitFor("updated", () => (saved()?.backend?.join() === "acme-api" ? true : undefined));
      // Rename to a taken name (any case) changes nothing; to a free one, renames.
      await answer("WEB");
      await vscode.commands.executeCommand("polylog.profileRename", { webviewSection: "profile", profile: "backend" });
      assert.ok(saved()?.backend && !saved()?.WEB, "a taken name is refused");
      await answer("api");
      await vscode.commands.executeCommand("polylog.profileRename", { webviewSection: "profile", profile: "backend" });
      await waitFor("renamed", () => (saved()?.api?.join() === "acme-api" && !saved()?.backend ? true : undefined));
      // Delete asks; Cancel keeps it.
      await answer("Cancel");
      await vscode.commands.executeCommand("polylog.profileDelete", { webviewSection: "profile", profile: "api" });
      assert.ok(saved()?.api, "Cancel keeps it");
      await answer("Delete");
      await vscode.commands.executeCommand("polylog.profileDelete", { webviewSection: "profile", profile: "api" });
      await waitFor("deleted", () => (saved()?.api === undefined ? true : undefined));
      assert.strictEqual(await vscode.commands.executeCommand("polylog._itest.lastWarning"), 'Delete profile "api"?');
    } finally {
      await answer(undefined);
      await cfg.update("profiles", undefined, vscode.ConfigurationTarget.Workspace);
      await send({ type: "filter", filter: ALL });
    }
  });

  it("profiles: a write never copies User-level profiles into the workspace; Profiles… with no change writes nothing", async () => {
    const s0 = await until("six rows", (x) => x.rows.length === 6);
    const id = (name: string) => s0.repos.find((r) => r.name === name)!.id;
    const cfg = vscode.workspace.getConfiguration("polylog");
    const ws = () => vscode.workspace.getConfiguration("polylog").inspect<Record<string, string[]>>("profiles")?.workspaceValue;
    const answer = (v: string | undefined) => vscode.commands.executeCommand("polylog._itest.answer", v);
    try {
      await cfg.update("profiles", { personal: ["acme-web"] }, vscode.ConfigurationTarget.Global);
      await until("the User profile is listed", (x) => x.profiles.some((p) => p.name === "personal"));
      // Accepting Profiles… unchanged writes no workspace setting at all.
      await answer(JSON.stringify(["personal"]));
      await vscode.commands.executeCommand("polylog.repoProfiles", { webviewSection: "repo", repoId: id("acme-web") });
      assert.strictEqual(ws(), undefined, "nothing changed: nothing written");
      // Saving a workspace profile writes only it.
      await send({ type: "filter", filter: { ...ALL, repoIds: [id("acme-api")] } });
      await answer("backend");
      await vscode.commands.executeCommand("polylog.profileSave");
      await waitFor("backend saved", () => (ws()?.backend ? true : undefined));
      assert.deepStrictEqual(ws(), { backend: ["acme-api"] }, "the User profile is not copied into the workspace");
      // Deleting a User-level profile from here leaves both scopes as they were.
      await answer("Delete");
      await vscode.commands.executeCommand("polylog.profileDelete", { webviewSection: "profile", profile: "personal" });
      assert.deepStrictEqual(ws(), { backend: ["acme-api"] });
      assert.deepStrictEqual(cfg.inspect<Record<string, string[]>>("profiles")?.globalValue, { personal: ["acme-web"] });
    } finally {
      await answer(undefined);
      await cfg.update("profiles", undefined, vscode.ConfigurationTarget.Global);
      await cfg.update("profiles", undefined, vscode.ConfigurationTarget.Workspace);
      await send({ type: "filter", filter: ALL });
    }
    await until("no profiles, six rows again", (x) => x.profiles.length === 0 && x.rows.length === 6);
  });

  it("a diff side shows who last changed the cursor's line, as of that commit", async () => {
    await closeEditors();
    const c = bySubject(await snapshot(), "feat: add retry");
    await vscode.commands.executeCommand("polylog.openDiff", args(c, "upload.go"));
    const input = await diffTab();
    const editor = await waitFor("the modified side focused", () => {
      const e = vscode.window.activeTextEditor;
      return e?.document.uri.toString() === input.modified.toString() ? e : undefined;
    });
    const blameOn = (line: number, re: RegExp) => {
      editor.selection = new vscode.Selection(line, 0, line, 0);
      return waitFor(`blame on line ${line + 1}`, async () => {
        const b = await vscode.commands.executeCommand<{ line: number; text: string } | undefined>("polylog._itest.blame");
        return b && b.line === line && re.test(b.text) ? b : undefined;
      });
    };
    await blameOn(2, /^feat: add retry to uploader \(ACME-7\), rin \(.+ ago\)$/);
    await blameOn(0, /^feat: scaffold api, dana /);
    const config = vscode.workspace.getConfiguration("polylog");
    await config.update("blame", false, vscode.ConfigurationTarget.Global);
    try {
      await waitFor("blame cleared when turned off", async () => ((await vscode.commands.executeCommand("polylog._itest.blame")) === undefined ? true : undefined));
    } finally {
      await config.update("blame", undefined, vscode.ConfigurationTarget.Global);
    }
  });

  it("shows an empty before side for a root commit", async () => {
    await closeEditors();
    const c = bySubject(await snapshot(), "feat: scaffold api");
    await vscode.commands.executeCommand("polylog.openDiff", args(c, "upload.go"));
    const input = await diffTab();
    assert.strictEqual((await vscode.workspace.openTextDocument(input.original)).getText(), "");
  });

  it("Enter opens the first file even before the list loads", async () => {
    await closeEditors();
    const c = bySubject(await snapshot(), "docs: link ACME-7");
    // Not awaited: Enter lands while the file list is still loading.
    void send({ type: "select", repoId: c.repoId, sha: c.sha });
    await send({ type: "openFirst", repoId: c.repoId, sha: c.sha });
    const input = await diffTab();
    assert.match(input.modified.path, /CHANGELOG\.md$/);
    await sleep(300);
    assert.strictEqual(tabCount(), 1, "opened exactly once");
  });

  it("an unknown selection cannot leave the tree stuck loading", async () => {
    const c = bySubject(await snapshot(), "chore: bump deps");
    // Not awaited: the bad select arrives while c's detail is in flight.
    void send({ type: "select", repoId: c.repoId, sha: c.sha });
    await send({ type: "select", repoId: c.repoId, sha: "f".repeat(40) });
    await sleep(800);
    const s = await snapshot();
    assert.notStrictEqual(s.changes.message, "Loading changed files…", "the in-flight detail was killed by a select that was never valid");
    assert.ok(s.changes.items[0]?.startsWith("chore: bump deps"));
  });

  it("clears the tree when the selected commit leaves the list", async () => {
    const c = bySubject(await snapshot(), "fix: guard nil");
    await send({ type: "select", repoId: c.repoId, sha: c.sha });
    await send({ type: "filter", filter: { ...ALL, text: "no commit says this" } });
    const s = await until("zero rows", (x) => x.rows.length === 0);
    assert.strictEqual(s.changes.message, "Select a commit in the Log to see its changed files.");
    assert.deepStrictEqual(s.changes.items, []);
    await send({ type: "filter", filter: ALL });
    await until("six rows again", (x) => x.rows.length === 6);
  });

  it("colors tree files by what the commit did to them", async () => {
    const retry = bySubject(await snapshot(), "feat: add retry");
    await send({ type: "select", repoId: retry.repoId, sha: retry.sha });
    let s = await until("retry decorations", (x) => x.changes.decorations.length > 0 && x.changes.items[0].startsWith("feat: add retry"));
    assert.deepStrictEqual(s.changes.decorations, ["upload.go M gitDecoration.modifiedResourceForeground"]);
    const root = bySubject(s, "feat: scaffold api");
    await send({ type: "select", repoId: root.repoId, sha: root.sha });
    s = await until("root decorations", (x) => x.changes.items[0]?.startsWith("feat: scaffold api") && x.changes.decorations.length > 0);
    assert.deepStrictEqual(s.changes.decorations, ["upload.go A gitDecoration.addedResourceForeground"]);
  });

  it("tree files are not worktree URIs (no live git or Problems decorations)", async () => {
    const c = bySubject(await snapshot(), "feat: add retry");
    await send({ type: "select", repoId: c.repoId, sha: c.sha });
    const s = await until("the retry tree", (x) => x.changes.items.some((i) => i.includes("upload.go")));
    assert.ok(s.changes.schemes.length > 0);
    assert.ok(s.changes.schemes.every((sc) => sc !== "file"), `worktree file: URIs attract live decorations: ${s.changes.schemes}`);
  });

  it("rejects refs that are not SHAs", async () => {
    await closeEditors();
    const c = (await snapshot()).rows[0];
    const bad = "--output=/tmp/polylog-pwned";
    await vscode.commands.executeCommand("polylog.openDiff", { ...args(c, "x"), sha: bad });
    await send({ type: "openFirst", repoId: c.repoId, sha: bad });
    await send({ type: "select", repoId: c.repoId, sha: bad });
    await sleep(300);
    assert.strictEqual(tabCount(), 0);
  });

  it("File History lists one file's commits and the diff follows the selection", async () => {
    await closeEditors();
    await send({ type: "filter", filter: { ...ALL, date: "7d" } });
    const api = (await snapshot()).repos.find((r) => r.name === "acme-api")!;
    await vscode.commands.executeCommand("polylog.fileHistory", vscode.Uri.file(require("path").join(api.root, "upload.go")));
    let s = await until("upload.go history", (x) => x.history?.path === "upload.go" && x.rows.length === 2);
    assert.strictEqual(s.filter.date, "all", "file history shows all time");
    assert.deepStrictEqual(s.rows.map((r) => r.subject), ["feat: add retry to uploader (ACME-7)", "feat: scaffold api"]);
    // Opening a history shows its newest revision straight away (the Log selects row 0).
    await until("the newest revision is shown", (x) => x.changes.items[0]?.startsWith("feat: add retry") === true);
    const older = s.rows[1];
    await send({ type: "select", repoId: older.repoId, sha: older.sha });
    const input = await waitFor("the older revision's diff", () => {
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      return tab instanceof vscode.TabInputTextDiff && (tab.modified.scheme === "git" || tab.modified.scheme === "polylog") && tab.modified.query.includes(older.sha) ? tab : undefined;
    });
    assert.strictEqual((await vscode.workspace.openTextDocument(input.modified)).getText(), "package upload\n");
    await until("the file is highlighted in Changes", (x) => x.changes.focused === "upload.go" && x.changes.items[0]?.startsWith("feat: scaffold api") === true);
    await until("the file selected in the Changes tree", (x) => x.changes.selected.join() === "upload.go");
    await send({ type: "exitHistory" });
    s = await until("all commits again", (x) => x.history === null);
    assert.strictEqual(s.filter.date, "7d", "closing the history restores the previous date range");
    await send({ type: "filter", filter: ALL });
    await until("six rows again", (x) => x.rows.length === 6);
    await closeEditors();
  });

  it("File History shows every commit of the file, whatever the search and author, and gives them back on close", async () => {
    await send({ type: "filter", filter: { ...ALL, text: "retry", author: "rin", mine: true, authors: ["noor"] } });
    await until("the filtered log", (x) => x.filter.text === "retry");
    const api = (await snapshot()).repos.find((r) => r.name === "acme-api")!;
    await vscode.commands.executeCommand("polylog.fileHistory", vscode.Uri.file(require("path").join(api.root, "upload.go")));
    let s = await until("upload.go history", (x) => x.history?.path === "upload.go" && x.rows.length === 2);
    assert.deepStrictEqual(s.rows.map((r) => r.subject), ["feat: add retry to uploader (ACME-7)", "feat: scaffold api"], "dana's commit shows too, and so does the one that never says retry");
    assert.deepStrictEqual([s.filter.text, s.filter.author, s.filter.mine, s.filter.authors], ["", "", false, undefined], "the boxes and chips are empty while in the history");
    assert.deepStrictEqual([s.persistedFilter?.text, s.persistedFilter?.author, s.persistedFilter?.mine, s.persistedFilter?.authors], ["retry", "rin", true, ["noor"]], "a reload now would bring the user's filters back");
    await send({ type: "exitHistory" });
    s = await until("all commits again", (x) => x.history === null);
    assert.deepStrictEqual([s.filter.text, s.filter.author, s.filter.mine, s.filter.authors], ["retry", "rin", true, ["noor"]], "closing the history gives the search, author and chips back");
    await send({ type: "filter", filter: ALL });
    await until("six rows again", (x) => x.rows.length === 6);
  });

  it("stepping through a history keeps one diff tab even with preview editors off", async () => {
    await closeEditors();
    const cfg = vscode.workspace.getConfiguration("workbench.editor");
    await cfg.update("enablePreview", false, vscode.ConfigurationTarget.Global);
    try {
      const api = (await snapshot()).repos.find((r) => r.name === "acme-api")!;
      await vscode.commands.executeCommand("polylog.fileHistory", vscode.Uri.file(require("path").join(api.root, "upload.go")));
      const s = await until("upload.go history", (x) => x.history?.path === "upload.go" && x.rows.length === 2);
      // The Log selects row 0 on its own; on a slow host that can land after a step below.
      await until("the newest revision is shown", (x) => x.changes.items[0]?.startsWith("feat: add retry") === true);
      for (const row of [s.rows[1], s.rows[0], s.rows[1]]) {
        await send({ type: "select", repoId: row.repoId, sha: row.sha });
        await waitFor(`the diff for ${row.subject}`, () => {
          const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
          return tab instanceof vscode.TabInputTextDiff && tab.modified.query.includes(row.sha) ? tab : undefined;
        });
      }
      await sleep(300);
      const diffs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputTextDiff);
      assert.strictEqual(diffs.length, 1, "each step replaced the previous history diff");
      // Holding ↓/↑: the next step arrives while the previous one is still swapping tabs.
      for (const row of [s.rows[0], s.rows[1], s.rows[0], s.rows[1], s.rows[0]]) await send({ type: "select", repoId: row.repoId, sha: row.sha });
      await sleep(1500);
      const after = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputTextDiff);
      assert.deepStrictEqual(after.map((t) => (t.input as vscode.TabInputTextDiff).modified.query.includes(s.rows[0].sha)), [true],
        "rapid steps leave exactly one diff tab, showing the last selection");
      await send({ type: "exitHistory" });
      await until("all commits again", (x) => x.history === null);
      // A later File History is a new session: it must not close the diff this one left open.
      const web = (await snapshot()).repos.find((r) => r.name === "acme-web")!;
      await vscode.commands.executeCommand("polylog.fileHistory", vscode.Uri.file(require("path").join(web.root, "client.ts")));
      const w = await until("client.ts history", (x) => x.history?.path === "client.ts" && x.rows.length === 2);
      await until("its newest revision is shown", (x) => x.changes.items[0]?.startsWith("fix: guard nil") === true);
      await send({ type: "select", repoId: w.rows[1].repoId, sha: w.rows[1].sha });
      await sleep(1500);
      const kept = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputTextDiff)
        .map((t) => (t.input as vscode.TabInputTextDiff).modified.path);
      assert.deepStrictEqual(kept.sort(), ["/client.ts", "/upload.go"], "upload.go's diff from the previous session is still open");
      await send({ type: "exitHistory" });
      await until("all commits again", (x) => x.history === null);
    } finally {
      await cfg.update("enablePreview", undefined, vscode.ConfigurationTarget.Global);
      await closeEditors();
    }
  });

  it("File History never overwrites the saved date range, and ends if its repo leaves", async () => {
    await send({ type: "filter", filter: { ...ALL, date: "7d" } });
    const api = (await snapshot()).repos.find((r) => r.name === "acme-api")!;
    await vscode.commands.executeCommand("polylog.fileHistory", vscode.Uri.file(require("path").join(api.root, "upload.go")));
    let s = await until("history", (x) => x.history !== null);
    assert.strictEqual(s.filter.date, "all");
    assert.strictEqual(s.persistedFilter?.date, "7d", "a window reload now would bring back 7 days, not all time");
    const cfg = vscode.workspace.getConfiguration("polylog");
    await cfg.update("excludeRepos", ["acme-api"], vscode.ConfigurationTarget.Global);
    try {
      await send({ type: "refresh" });
      s = await until("history ended", (x) => x.history === null && x.repos.length === 2);
      assert.strictEqual(s.filter.date, "7d", "and the previous range is back");
    } finally {
      await cfg.update("excludeRepos", undefined, vscode.ConfigurationTarget.Global);
      await send({ type: "refresh" });
      await until("three repos again", (x) => x.repos.length === 3);
      await send({ type: "filter", filter: ALL });
      await until("six rows again", (x) => x.rows.length === 6);
    }
  });

  it("a branch is used where it exists, the current branch elsewhere", async () => {
    await send({ type: "filter", filter: { ...ALL, branch: "prod" } });
    const s = await until("prod in acme-api only", (x) => x.rows.length === 5 && x.branchUse?.found === 1);
    assert.deepStrictEqual(s.branchUse, { branch: "prod", found: 1, fallback: 2 });
    assert.ok(!s.rows.some((r) => r.subject.startsWith("feat: add retry")), "acme-api shows prod, which is one commit behind");
    await send({ type: "filter", filter: ALL });
    await until("six rows again", (x) => x.rows.length === 6);
  });

  it("offers branch names found across repositories", async () => {
    assert.strictEqual((await snapshot()).branches.length, 0, "nothing is read until the Branch box is focused");
    await send({ type: "wantSuggestions", kind: "branches" });
    const s = await until("branch suggestions", (x) => x.branches.length > 0);
    assert.deepStrictEqual(s.branches.find((b) => b.name === "main"), { name: "main", count: 3 });
    assert.deepStrictEqual(s.branches.find((b) => b.name === "prod"), { name: "prod", count: 1 });
  });

  it("keeps the Log alive when the panel shows another tab", async () => {
    const before = (await snapshot()).readyCount;
    await vscode.commands.executeCommand("workbench.action.terminal.focus");
    await sleep(500);
    await vscode.commands.executeCommand("polylog.open");
    await sleep(1000);
    assert.strictEqual((await snapshot()).readyCount, before, "the webview was destroyed and re-created");
  });

  it("switching git.path takes effect at once, and a path that cannot run falls back", async function () {
    if (process.platform === "win32") this.skip(); // the wrapper is a shell script
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const os = require("os") as typeof import("os");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "polylog-gitpath-"));
    const calls = path.join(dir, "calls.log");
    const wrapper = path.join(dir, "git-wrapper");
    // Records every call, then runs the real git from PATH.
    fs.writeFileSync(wrapper, `#!/bin/sh\necho "$@" >> "${calls}"\nexec git "$@"\n`, { mode: 0o755 });
    const cfg = vscode.workspace.getConfiguration("git");
    const reloads = async () => (await snapshot()).stats.reloads;
    try {
      let before = await reloads();
      await cfg.update("path", wrapper, vscode.ConfigurationTarget.Global);
      let s = await until("a reload through the new git", (x) => x.stats.reloads > before && x.rows.length > 0 && !x.failures.length);
      await waitFor("the wrapper to be used", () => (fs.existsSync(calls) && /log /.test(fs.readFileSync(calls, "utf8")) ? true : undefined));
      assert.ok(s.rows.length > 0, "the Log still lists commits through the wrapper");

      before = await reloads();
      await cfg.update("path", path.join(dir, "no-such-git"), vscode.ConfigurationTarget.Global);
      s = await until("a reload after switching to a path that cannot run", (x) => x.stats.reloads > before && x.rows.length > 0);
      assert.deepStrictEqual(s.failures, [], "falls back to a git that runs instead of failing every repo");

      before = await reloads();
      await cfg.update("path", undefined, vscode.ConfigurationTarget.Global);
      await until("a reload after clearing git.path", (x) => x.stats.reloads > before && x.rows.length > 0);
      fs.writeFileSync(calls, "");
      await send({ type: "refresh" });
      await until("a refresh", (x) => x.rows.length > 0);
      await sleep(300);
      assert.strictEqual(fs.readFileSync(calls, "utf8"), "", "the old git.path is no longer used");
    } finally {
      await cfg.update("path", undefined, vscode.ConfigurationTarget.Global);
    }
  });

  // Last: it leaves Changes hidden for the rest of the session, as a user who hid it wants.
  it("Polylog never reopens a view: a hidden Changes view stays hidden, and keeps the selection", async () => {
    const rows = (await until("six rows", (x) => x.rows.length === 6)).rows;
    const c = rows.find((r) => r.subject.startsWith("feat: add retry"))!;
    const other = rows.find((r) => r.subject.startsWith("fix: guard nil"))!;
    await send({ type: "select", repoId: c.repoId, sha: c.sha });
    await until("Changes showing the commit", (x) => x.changesVisible && x.changes.items.some((i) => i.includes("upload.go")));
    await vscode.commands.executeCommand("polylog.changes.removeView");
    await sleep(1200);
    assert.strictEqual((await snapshot()).changesVisible, false, "hidden on the first try: nothing reopens it");
    // Rule 5: it still follows the selection while hidden, and shows it when opened.
    await send({ type: "select", repoId: other.repoId, sha: other.sha });
    await sleep(800);
    let s = await snapshot();
    assert.strictEqual(s.changesVisible, false, "a selection does not bring it back");
    assert.ok(s.changes.items.some((i) => i.includes("client.ts")), "but it has the new commit's files");
    await vscode.commands.executeCommand("polylog.changes.focus");
    s = await until("shown again by the user", (x) => x.changesVisible);
    assert.ok(s.changes.items.some((i) => i.includes("client.ts")));
  });

  describe("Compare Branches", () => {
    const os = require("os") as typeof import("os");
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const cp = require("child_process") as typeof import("child_process");
    const store = () => vscode.commands.executeCommand<{ pair: Pair | null; reading: boolean; rows: string[] }>("polylog._itest.compareStore");
    const pick = (p: Pair | null) => vscode.commands.executeCommand("polylog._itest.comparePick", p);
    const git = (root: string, args: string[], input?: string) => cp.execFileSync("git", args, { cwd: root, input, env: { ...process.env, ...ID } }).toString().trim();
    const ID = { GIT_AUTHOR_NAME: "dana", GIT_AUTHOR_EMAIL: "dana@example.com", GIT_COMMITTER_NAME: "dana", GIT_COMMITTER_EMAIL: "dana@example.com" };
    let n = 0;
    /** A commit on top of `parent` with these files, made without touching the working tree or the checked-out branch. */
    function commitOn(root: string, parent: string | null, files: Record<string, string>, message: string, time: number): string {
      const idx = path.join(os.tmpdir(), `polylog-itest-index-${process.pid}-${n++}`);
      const env = { ...process.env, ...ID, GIT_INDEX_FILE: idx, GIT_AUTHOR_DATE: `${time} +0000`, GIT_COMMITTER_DATE: `${time} +0000` };
      const run = (args: string[], input?: string) => cp.execFileSync("git", args, { cwd: root, input, env }).toString().trim();
      try {
        run(parent ? ["read-tree", parent] : ["read-tree", "--empty"]);
        for (const [name, content] of Object.entries(files)) run(["update-index", "--add", "--cacheinfo", `100644,${run(["hash-object", "-w", "--stdin"], content)},${name}`]);
        return run(["commit-tree", run(["write-tree"]), ...(parent ? ["-p", parent] : []), "-m", message]);
      } finally {
        fs.rmSync(idx, { force: true });
      }
    }
    const T = 1758001000;
    let roots: Record<string, string>;

    before(async () => {
      const s = await until("six rows", (x) => x.rows.length === 6);
      roots = Object.fromEntries(s.repos.map((r) => [r.name, r.root]));
      // acme-api: ◀ two (one a cherry-pick), ▶ two (its twin and a hotfix). acme-web: ◀ one. acme-libs: the same commit on both.
      const api = roots["acme-api"];
      const apiBase = git(api, ["rev-parse", "HEAD"]);
      const rel1 = commitOn(api, apiBase, { "limit.go": "package limit\n" }, "feat: rate limit per client", T);
      const rel2 = commitOn(api, rel1, { "retry.go": "package retry\n" }, "fix: retry on 503", T + 10);
      const prod1 = commitOn(api, apiBase, { "retry.go": "package retry\n" }, "fix: retry on 503", T + 20);
      const prod2 = commitOn(api, prod1, { "timeout.go": "package timeout\n", "limit.go": "package limit // prod\n" }, "hotfix: raise upstream timeout", T + 30);
      git(api, ["update-ref", "refs/heads/release-1.4", rel2]);
      git(api, ["update-ref", "refs/heads/prod", prod2]);
      const web = roots["acme-web"];
      const webBase = git(web, ["rev-parse", "HEAD"]);
      git(web, ["update-ref", "refs/heads/release-1.4", commitOn(web, webBase, { "billing.ts": "export {};\n" }, "feat: billing page", T + 40)]);
      git(web, ["update-ref", "refs/heads/prod", webBase]);
      git(web, ["update-ref", "refs/heads/lone", commitOn(web, null, { "README.md": "lone\n" }, "chore: unrelated history", T + 50)]);
      const libs = roots["acme-libs"];
      git(libs, ["update-ref", "refs/heads/release-1.4", "HEAD"]);
      git(libs, ["update-ref", "refs/heads/prod", "HEAD"]);
    });

    after(async () => {
      await pick(null);
      for (const root of Object.values(roots)) for (const b of ["release-1.4", "prod", "lone"]) cp.spawnSync("git", ["update-ref", "-d", `refs/heads/${b}`], { cwd: root });
      await send({ type: "filter", filter: ALL });
    });

    it("counts each side in every ticked repository; identical and missing ones are not listed", async () => {
      await pick({ left: "release-1.4", right: "prod" });
      const s = await waitFor("all read", async () => {
        const x = await store();
        return !x.reading && x.rows.length === 3 ? x : undefined;
      });
      assert.ok(s.rows.includes("acme-api ◀1 ▶1 =1"), s.rows.join(" | "));
      assert.ok(s.rows.includes("acme-web ◀1 ▶0 =0"));
      assert.ok(s.rows.includes("acme-libs identical"));
      // A branch one repository lacks.
      cp.spawnSync("git", ["update-ref", "-d", "refs/heads/prod"], { cwd: roots["acme-libs"] });
      await vscode.commands.executeCommand("polylog._itest.compareRefresh");
      await waitFor("acme-libs missing", async () => ((await store()).rows.includes("acme-libs missing") ? true : undefined));
      git(roots["acme-libs"], ["update-ref", "refs/heads/prod", "HEAD"]);
    });

    it("the same files means identical, and merge commits are not counted", async () => {
      const libs = roots["acme-libs"];
      const web = roots["acme-web"];
      const libsHead = git(libs, ["rev-parse", "HEAD"]);
      const webBase = git(web, ["rev-parse", "HEAD"]);
      // acme-libs: live has one more commit, but the same files (an empty commit).
      git(libs, ["update-ref", "refs/heads/rc", libsHead]);
      git(libs, ["update-ref", "refs/heads/live", git(libs, ["commit-tree", `${libsHead}^{tree}`, "-p", libsHead, "-m", "chore: empty"])]);
      // acme-web: live has a hotfix and the merge that brought it in.
      const hot = commitOn(web, webBase, { "hotfix.ts": "export {};\n" }, "fix: hotfix", T + 80);
      git(web, ["update-ref", "refs/heads/rc", webBase]);
      git(web, ["update-ref", "refs/heads/live", git(web, ["commit-tree", `${hot}^{tree}`, "-p", webBase, "-p", hot, "-m", "Merge hotfix into live"])]);
      try {
        await pick({ left: "rc", right: "live" });
        const s = await waitFor("read", async () => {
          const x = await store();
          return !x.reading && x.rows.some((r) => r.startsWith("acme-web")) ? x : undefined;
        });
        assert.ok(s.rows.includes("acme-libs identical"), s.rows.join(" | "));
        assert.ok(s.rows.includes("acme-web ◀0 ▶1 =0"), s.rows.join(" | "));
      } finally {
        for (const root of [libs, web]) for (const b of ["rc", "live"]) cp.spawnSync("git", ["update-ref", "-d", `refs/heads/${b}`], { cwd: root });
      }
    });

    it("two branches with no shared history say so", async () => {
      await pick({ left: "lone", right: "prod" });
      const s = await waitFor("read", async () => {
        const x = await store();
        return !x.reading && x.rows.some((r) => r.startsWith("acme-web")) ? x : undefined;
      });
      assert.ok(s.rows.includes("acme-web no common history"), s.rows.join(" | "));
      assert.ok(s.rows.includes("acme-api missing"));
    });

    it("unticking a repository drops it at once, even while its read is in flight", async () => {
      const s0 = await snapshot();
      const api = s0.repos.find((r) => r.name === "acme-api")!;
      const others = s0.repos.filter((r) => r.id !== api.id).map((r) => r.id);
      const pending = pick({ left: "release-1.4", right: "prod" });
      await send({ type: "filter", filter: { ...ALL, repoIds: others } });
      await pending;
      const s = await waitFor("read", async () => {
        const x = await store();
        return !x.reading ? x : undefined;
      });
      assert.ok(!s.rows.some((r) => r.startsWith("acme-api")), s.rows.join(" | "));
      await send({ type: "filter", filter: ALL });
      await waitFor("acme-api back", async () => ((await store()).rows.includes("acme-api ◀1 ▶1 =1") ? true : undefined));
    });

    it("a name that is not a branch never reaches git", async () => {
      const before = (await snapshot()).spawnLog.length;
      await pick({ left: "-x", right: "prod" });
      await pick({ left: "a..b", right: "prod" });
      const after = await snapshot();
      assert.ok(!after.spawnLog.slice(before).some((x) => x.cmd === "rev-parse"), "no rev-parse for a bad name");
    });

    type Repos = { open: boolean; description: string; message: string | undefined; pair: Pair | null; mode: string; roots: string[]; selected: string | undefined; accents: number[] };
    type SideSnap = { open: boolean; title: string; description: string; message: string | undefined; tree: string[]; files: string[]; dimmed: string[] };
    const repos = () => vscode.commands.executeCommand<Repos>("polylog._itest.compare");
    const sideOf = (s: "left" | "right") => vscode.commands.executeCommand<SideSnap>("polylog._itest.compareSide", s);
    const viewPick = (p: Pair) => vscode.commands.executeCommand("polylog._itest.compareView", p);
    const select = (id: string) => vscode.commands.executeCommand("polylog._itest.compareSelect", id);
    const until2 = <T>(what: string, get: () => Thenable<T>, ok: (x: T) => boolean) =>
      waitFor(what, async () => {
        const x = await get();
        return ok(x) ? x : undefined;
      });
    const tabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).length;

    it("the Polylog Compare tab: Repositories with counts; selecting one fills both sides", async () => {
      await viewPick({ left: "release-1.4", right: "prod" });
      await vscode.commands.executeCommand("polylog.compareBranches");
      const r = await until2("listed", repos, (x) => x.open && x.roots.length === 2 && x.selected !== undefined);
      assert.strictEqual(r.description, "release-1.4 ↔ prod");
      assert.deepStrictEqual(r.roots, ["acme-api", "acme-web"], "names only: commit counts mislead when changes travel by cherry-pick (they are in the tooltip)");
      assert.strictEqual(r.selected, roots["acme-api"], "the first listed repository is selected");
      // Like the Log's Repo List: each repository's own color, as a dot.
      const { accentOf, assignAccents } = require("../webview/view") as typeof import("../webview/view");
      const accents = assignAccents((await snapshot()).repos);
      assert.deepStrictEqual(r.accents, ["acme-api", "acme-web"].map((n) => accentOf(accents, roots[n])));
      const pkg = vscode.extensions.getExtension("lntvan166.polylog-git")!.packageJSON.contributes;
      const views = pkg.views as Record<string, { id: string; icon?: string; type?: string }[]>;
      assert.deepStrictEqual(pkg.viewsContainers, {
        panel: [{ id: "polylog", title: "Polylog", icon: "media/polylog.svg" }, { id: "polylog-compare", title: "Polylog Compare", icon: "media/compare.svg" }],
        activitybar: [{ id: "polylog-side", title: "Polylog", icon: "media/polylog.svg" }],
      });
      assert.deepStrictEqual(Object.fromEntries(Object.entries(views).map(([c, vs]) => [c, vs.map((v) => [v.id, v.icon])])), {
        polylog: [["polylog.log", "$(history)"], ["polylog.changes", "$(diff)"]],
        "polylog-compare": [["polylog.compare", "$(repo)"], ["polylog.compareLeft", "$(arrow-left)"], ["polylog.compareRight", "$(arrow-right)"]],
        "polylog-side": [["polylog.uncommitted", "$(diff-modified)"]],
      }, "Layout D: Log + Changes; the Compare tab; Uncommitted in the side bar");
      assert.strictEqual(views["polylog-compare"][0].type, "webview", "Repositories: the Branch boxes need a page; Left and Right stay native trees");
      assert.strictEqual(views["polylog-compare"][1].type, undefined);
      const menus = pkg.menus["webview/context"] as { command: string; when: string }[];
      for (const c of ["polylog.repoPull", "polylog.repoShowOnly", "polylog.repoHide", "polylog.repoOpenFolder", "polylog.repoCopyPath"]) {
        assert.ok(menus.some((m) => m.command === c && m.when.includes("webviewId == 'polylog.compare'")), `${c} on a Compare repository row`);
      }
      // The page's Branch boxes and rows: a pick and a click reach the host.
      const rsend = (m: import("../compareProtocol").ReposWebview) => vscode.commands.executeCommand("polylog._itest.compareReposSend", m);
      await rsend({ type: "pick", pair: { left: "prod", right: "release-1.4" } });
      await until2("picked in the page", repos, (x) => x.description === "prod ↔ release-1.4" && x.roots.length === 2);
      await rsend({ type: "pick", pair: { left: "release-1.4", right: "prod" } });
      await until2("picked back", repos, (x) => x.description === "release-1.4 ↔ prod" && x.roots.length === 2);
      await rsend({ type: "select", repoId: roots["acme-web"] });
      await until2("row clicked", repos, (x) => x.selected === roots["acme-web"]);
      await rsend({ type: "select", repoId: roots["acme-api"] });
      const left = await until2("left side", () => sideOf("left"), (x) => x.tree.length > 0);
      assert.strictEqual(left.title, "release-1.4 only");
      // retry.go, cherry-picked to both: the same at both tips now, so hidden by default; limit.go still differs.
      assert.strictEqual(left.description, "acme-api · 1 file · 1 already on both (hidden)");
      assert.deepStrictEqual(left.tree, ["limit.go | +1 −0 · both"]);
      const right = await until2("right side", () => sideOf("right"), (x) => x.tree.length > 0);
      assert.strictEqual(right.title, "prod only");
      assert.deepStrictEqual(right.tree, ["limit.go | +1 −0 · both", "timeout.go | +1 −0"]);
      // Show Files Already on Both: listed again, dimmed; Hide puts it back.
      await vscode.commands.executeCommand("polylog.compareShowSame");
      try {
        const shown = await until2("left with retry.go", () => sideOf("left"), (x) => x.tree.length === 2);
        assert.strictEqual(shown.description, "acme-api · 2 files");
        assert.deepStrictEqual(shown.tree, ["limit.go | +1 −0 · both", "retry.go | +1 −0 · already on both"]);
        assert.deepStrictEqual(shown.dimmed, ["retry.go"]);
        const rshown = await until2("right with retry.go", () => sideOf("right"), (x) => x.tree.length === 3);
        assert.deepStrictEqual(rshown.dimmed, ["retry.go"]);
      } finally {
        await vscode.commands.executeCommand("polylog.compareHideSame");
      }
      await until2("left hides it again", () => sideOf("left"), (x) => x.tree.length === 1);
      await vscode.commands.executeCommand("polylog.compareOpenFile", { side: "right", repoId: roots["acme-api"], path: "timeout.go" });
      const tab = await waitFor("a diff", () => {
        const t = vscode.window.tabGroups.activeTabGroup.activeTab;
        return t?.input instanceof vscode.TabInputTextDiff ? t.input : undefined;
      });
      // A click: the file as the two branches have it now — left pane the right branch (prod), right pane the left one.
      assert.strictEqual((await vscode.workspace.openTextDocument(tab.original)).getText(), "package timeout\n", "prod has timeout.go");
      assert.strictEqual((await vscode.workspace.openTextDocument(tab.modified)).getText(), "", "release-1.4 does not");
      assert.match(vscode.window.tabGroups.activeTabGroup.activeTab!.label, /\(prod ↔ release-1\.4\)/);
      // limit.go, changed on both sides: both halves in one diff.
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await vscode.commands.executeCommand("polylog.compareOpenFile", { side: "left", repoId: roots["acme-api"], path: "limit.go" });
      const both = await waitFor("limit.go between branches", () => {
        const t = vscode.window.tabGroups.activeTabGroup.activeTab;
        return t?.input instanceof vscode.TabInputTextDiff ? t.input : undefined;
      });
      assert.strictEqual((await vscode.workspace.openTextDocument(both.original)).getText(), "package limit // prod\n");
      assert.strictEqual((await vscode.workspace.openTextDocument(both.modified)).getText(), "package limit\n");
      // Right-click → Changes since the split: merge base ↔ that side (what the merge brings).
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await vscode.commands.executeCommand("polylog.compareOpenSinceSplit", { side: "right", repoId: roots["acme-api"], path: "timeout.go" });
      const since = await waitFor("since the split", () => {
        const t = vscode.window.tabGroups.activeTabGroup.activeTab;
        return t?.input instanceof vscode.TabInputTextDiff ? t.input : undefined;
      });
      assert.strictEqual((await vscode.workspace.openTextDocument(since.original)).getText(), "");
      assert.strictEqual((await vscode.workspace.openTextDocument(since.modified)).getText(), "package timeout\n");
      const items = vscode.extensions.getExtension("lntvan166.polylog-git")!.packageJSON.contributes.menus["view/item/context"] as { command: string; when: string }[];
      assert.ok(items.some((m) => m.command === "polylog.compareOpenSinceSplit" && m.when.includes("viewItem =~ /^compareFile/")));
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      // Another repository: both sides follow; a file of the old one no longer opens.
      await select(roots["acme-web"]);
      await until2("acme-web left", () => sideOf("left"), (x) => x.tree.join() === "billing.ts | +1 −0");
      assert.strictEqual((await sideOf("right")).message, "No changes on this side.");
      // A click from acme-api's tree, landing after the selection moved: billing.ts is acme-web's, not acme-api's.
      const before = tabs();
      await vscode.commands.executeCommand("polylog.compareOpenFile", { side: "left", repoId: roots["acme-api"], path: "billing.ts" });
      await sleep(300);
      assert.strictEqual(tabs(), before, "a file opens only from the repository whose files are shown");
    });

    it("Repositories says what it knows: nothing before the read, 'the same files' only once it is done, ticks followed", async () => {
      type Posted = { repos?: { empty?: string; message?: string; rows: unknown[] } };
      const posted = () => vscode.commands.executeCommand<Posted>("polylog._itest.comparePosted");
      await viewPick({ left: "release-1.4", right: "release-1.4" });
      await vscode.commands.executeCommand("polylog.compareShow");
      await until2("same names", repos, (x) => x.message?.startsWith("Pick two different") === true);
      // Not yet read: no claim.
      await vscode.commands.executeCommand("polylog._itest.compareView", { left: "release-1.4", right: "prod" });
      const during = await posted();
      assert.notStrictEqual(during.repos?.empty, "release-1.4 and prod have the same files in every repository.", "no claim before the read is done");
      // Nothing ticked: the message follows the ticks.
      const s0 = await snapshot();
      try {
        await send({ type: "filter", filter: { ...ALL, repoIds: [] } });
        await waitFor("no ticks", async () => ((await posted()).repos?.message === "No repositories are ticked in the Repo List." ? true : undefined));
      } finally {
        await send({ type: "filter", filter: ALL });
      }
      await waitFor("ticked again", async () => ((await posted()).repos?.message === undefined && ((await posted()).repos?.rows.length ?? 0) > 0 ? true : undefined));
      assert.ok(s0.repos.length > 0);
    });

    it("Compare minors: one read per show, Compare with… clears the sides, a half pair keeps its guidance, no wasted side reads", async () => {
      type Posted = { repos?: { message?: string }; state?: { pair: Pair | null } };
      const posted = () => vscode.commands.executeCommand<Posted>("polylog._itest.comparePosted");
      const rsend = (m: import("../compareProtocol").ReposWebview) => vscode.commands.executeCommand("polylog._itest.compareReposSend", m);
      await viewPick({ left: "release-1.4", right: "prod" });
      await vscode.commands.executeCommand("polylog.compareShow");
      await until2("listed", repos, (x) => x.open && x.roots.length === 2);
      // Hide and show again: each ticked repository's branches are resolved once, not twice.
      await vscode.commands.executeCommand("workbench.action.terminal.toggleTerminal");
      await until2("hidden", repos, (x) => !x.open);
      const before = (await snapshot()).spawnLog.length;
      await vscode.commands.executeCommand("polylog.compareShow");
      await until2("read again", repos, (x) => x.open && x.roots.length === 2);
      await sleep(300);
      const log = (await snapshot()).spawnLog.slice(before);
      const ticked = (await snapshot()).repos.length;
      assert.strictEqual(log.filter((x) => x.cmd === "rev-parse").length, ticked, "one rev-parse per repository");
      // While the list was being read, the selection moved on its own: the sides read once, for the final one.
      assert.ok(log.filter((x) => x.cmd === "diff").length <= 3, `side reads wait for the list (${log.filter((x) => x.cmd === "diff").length} diffs)`);
      // A half pair from the page: the host keeps it and its guidance.
      await rsend({ type: "pending", pair: { left: "release-1.4", right: "" } });
      await waitFor("guidance", async () => ((await posted()).repos?.message === "Pick the branch release-1.4 goes into (▶)." ? true : undefined));
      assert.strictEqual((await sideOf("left")).tree.length, 0, "the old pair's files leave the sides");
      await rsend({ type: "pick", pair: { left: "release-1.4", right: "prod" } });
      await until2("picked", repos, (x) => x.roots.length === 2);
      const pkg = vscode.extensions.getExtension("lntvan166.polylog-git")!.packageJSON;
      assert.ok(!JSON.stringify(pkg.contributes.menus).includes("polylog.comparePair"));
    });

    it("the picked repository survives a panel tab switch; duplicates are always answered", async () => {
      type Posted = { dups?: { repoId: string; items: unknown[] } };
      const posted = () => vscode.commands.executeCommand<Posted>("polylog._itest.comparePosted");
      const rsend = (m: import("../compareProtocol").ReposWebview) => vscode.commands.executeCommand("polylog._itest.compareReposSend", m);
      await viewPick({ left: "release-1.4", right: "prod" });
      await vscode.commands.executeCommand("polylog.compareShow");
      await until2("listed", repos, (x) => x.open && x.roots.length === 2);
      await rsend({ type: "select", repoId: roots["acme-web"] });
      await until2("acme-web picked", repos, (x) => x.selected === roots["acme-web"]);
      await vscode.commands.executeCommand("workbench.action.terminal.toggleTerminal");
      await until2("tab hidden", repos, (x) => !x.open);
      await vscode.commands.executeCommand("polylog.compareShow");
      await until2("back, read again", repos, (x) => x.open && x.roots.length === 2);
      await until2("still acme-web, not the first row", repos, (x) => x.selected === roots["acme-web"]);
      // A repository with no result (or a read that fails): the page still gets an answer.
      await rsend({ type: "wantDups", repoId: "/nowhere" });
      assert.deepStrictEqual((await posted()).dups, { type: "dups", repoId: "/nowhere", items: [] });
    });

    it("after Refresh, a file in Left or Right still opens its diff", async () => {
      await viewPick({ left: "release-1.4", right: "prod" });
      await vscode.commands.executeCommand("polylog.compareShow");
      await until2("listed", repos, (x) => x.open && x.roots.length === 2);
      await select(roots["acme-api"]);
      await until2("api right", () => sideOf("right"), (x) => x.tree.some((l) => l.startsWith("timeout.go")));
      await vscode.commands.executeCommand("polylog.compareRefresh");
      await sleep(400);
      // No snapshot in between: it would read the side again and hide the bug.
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await vscode.commands.executeCommand("polylog.compareOpenFile", { side: "right", repoId: roots["acme-api"], path: "timeout.go" });
      await waitFor("a diff after Refresh", () => (vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff ? true : undefined), 3000);
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    });

    it("the Polylog Compare tab is hidden until Compare Branches is clicked, and × hides it again", async () => {
      const pkg = vscode.extensions.getExtension("lntvan166.polylog-git")!.packageJSON.contributes;
      for (const v of pkg.views["polylog-compare"] as { id: string; when?: string }[]) assert.strictEqual(v.when, "polylog.compareShown", `${v.id} is hidden by default`);
      assert.ok((pkg.menus["view/title"] as { command: string; when: string }[]).some((m) => m.command === "polylog.compareClose" && m.when.includes("view == polylog.compare")));
      await vscode.commands.executeCommand("polylog.compareClose");
      await until2("hidden", repos, (x) => !x.open);
      await vscode.commands.executeCommand("polylog.compareBranches");
      await until2("shown again", repos, (x) => x.open && x.roots.length === 2);
    });

    it("the Polylog side bar is hidden until the Log's Uncommitted button, and × hides it again", async () => {
      const pkg = vscode.extensions.getExtension("lntvan166.polylog-git")!.packageJSON.contributes;
      assert.strictEqual((pkg.views["polylog-side"] as { when?: string }[])[0].when, "polylog.uncommittedShown");
      // The remembered side bar and Compare tab need their context keys after a reload, before any Polylog view opens.
      assert.ok((vscode.extensions.getExtension("lntvan166.polylog-git")!.packageJSON.activationEvents as string[]).includes("onStartupFinished"));
      const titles = pkg.menus["view/title"] as { command: string; when: string; group: string }[];
      assert.ok(titles.some((m) => m.command === "polylog.uncommittedClose" && m.when.includes("view == polylog.uncommitted")));
      const shown = () => vscode.commands.executeCommand<boolean>("polylog._itest.uncommittedShown");
      await vscode.commands.executeCommand("polylog.uncommittedClose");
      assert.strictEqual(await shown(), false);
      await vscode.commands.executeCommand("polylog.focusUncommitted");
      assert.strictEqual(await shown(), true);
      await waitFor("the view on screen", async () => ((await vscode.commands.executeCommand<{ visible: boolean }>("polylog._itest.uncommitted")).visible ? true : undefined));
    });

    it("the Log toolbar's two toggles: click to show, click again to hide; the icon says which", async () => {
      const pkg = vscode.extensions.getExtension("lntvan166.polylog-git")!.packageJSON.contributes;
      const icon = (cmd: string) => (pkg.commands as { command: string; icon?: string }[]).find((c) => c.command === cmd)?.icon;
      const log = (pkg.menus["view/title"] as { command: string; when: string }[]).filter((m) => m.when.startsWith("view == polylog.log"));
      const at = (cmd: string) => log.find((m) => m.command === cmd)?.when;
      // Each button keeps its place whether shown or hidden: one position per button, not per state.
      const pos = (cmd: string) => (log.find((m) => m.command === cmd) as { group?: string } | undefined)?.group;
      assert.strictEqual(pos("polylog.compareShow"), pos("polylog.compareHide"));
      assert.strictEqual(pos("polylog.uncommittedShow"), pos("polylog.uncommittedHide"));
      assert.notStrictEqual(pos("polylog.compareShow"), pos("polylog.uncommittedShow"), "the two buttons never trade places");
      assert.deepStrictEqual([icon("polylog.uncommittedShow"), at("polylog.uncommittedShow")], ["$(diff-modified)", "view == polylog.log && !polylog.uncommittedShown"]);
      assert.deepStrictEqual([icon("polylog.uncommittedHide"), at("polylog.uncommittedHide")], ["$(diff-modified)", "view == polylog.log && polylog.uncommittedShown"]);
      assert.deepStrictEqual([icon("polylog.compareShow"), at("polylog.compareShow")], ["$(git-compare)", "view == polylog.log && !polylog.compareShown"]);
      assert.deepStrictEqual([icon("polylog.compareHide"), at("polylog.compareHide")], ["$(git-compare)", "view == polylog.log && polylog.compareShown"]);
      const shown = () => vscode.commands.executeCommand<boolean>("polylog._itest.uncommittedShown");
      await vscode.commands.executeCommand("polylog.uncommittedShow");
      assert.strictEqual(await shown(), true);
      await vscode.commands.executeCommand("polylog.uncommittedHide");
      assert.strictEqual(await shown(), false);
      await vscode.commands.executeCommand("polylog.compareShow");
      await until2("compare shown", repos, (x) => x.open);
      await vscode.commands.executeCommand("polylog.compareHide");
      await until2("compare hidden", repos, (x) => !x.open);
      await vscode.commands.executeCommand("polylog.compareShow");
      await until2("compare shown again", repos, (x) => x.open);
    });

    it("Commits mode, swap, a new pair, and hiding the tab mid-read", async () => {
      await select(roots["acme-api"]);
      await vscode.commands.executeCommand("polylog._itest.compareMode", "commits");
      let left = await until2("commits", () => sideOf("left"), (x) => x.tree.some((l) => l.startsWith("feat: rate limit")));
      assert.strictEqual(left.description, "acme-api · 1 commit");
      assert.deepStrictEqual(left.tree.map((l) => l.replace(/ · .*$/, "")), ["feat: rate limit per client | dana", "  limit.go | +1 −0"]);
      await vscode.commands.executeCommand("polylog.compareSwap");
      left = await until2("swapped", () => sideOf("left"), (x) => x.title === "prod only" && x.tree[0]?.startsWith("hotfix") === true);
      assert.ok((await repos()).roots.includes("acme-web"));
      await vscode.commands.executeCommand("polylog._itest.compareMode", "files");
      // A new pair: the old pair's files are gone at once.
      await viewPick({ left: "prod", right: "prod" });
      const same = await until2("same", repos, (x) => x.message?.startsWith("Pick two different") === true);
      assert.strictEqual(same.message, "Pick two different branches. Both sides are prod.");
      assert.deepStrictEqual((await sideOf("left")).tree, []);
      // Hide while a read runs: nothing throws; showing it reads again.
      void viewPick({ left: "release-1.4", right: "prod" });
      await vscode.commands.executeCommand("workbench.action.closePanel");
      await until2("hidden", repos, (x) => !x.open);
      await vscode.commands.executeCommand("polylog.compareBranches");
      const back = await until2("shown and read", repos, (x) => x.open && x.roots.length === 2);
      assert.strictEqual(back.pair?.left, "release-1.4", "the last pair is remembered");
    });

    it("a branch that moves: the selected repository's files are read again; unticking it moves the selection", async () => {
      await viewPick({ left: "release-1.4", right: "prod" });
      await until2("listed", repos, (x) => x.roots.length === 2);
      await select(roots["acme-web"]);
      await until2("acme-web files", () => sideOf("left"), (x) => x.tree.join() === "billing.ts | +1 −0");
      const web = roots["acme-web"];
      const tip = git(web, ["rev-parse", "refs/heads/release-1.4"]);
      git(web, ["update-ref", "refs/heads/release-1.4", commitOn(web, tip, { "export.ts": "export {};\n" }, "feat: export CSV", T + 60)]);
      try {
        await vscode.commands.executeCommand("polylog.fetchAll");
        await until2("read again", () => sideOf("left"), (x) => x.tree.includes("export.ts | +1 −0"));
      } finally {
        git(web, ["update-ref", "refs/heads/release-1.4", tip]);
      }
      const s0 = await snapshot();
      await send({ type: "filter", filter: { ...ALL, repoIds: s0.repos.filter((r) => r.id !== web).map((r) => r.id) } });
      await until2("selection moved", repos, (x) => x.selected === roots["acme-api"]);
      await send({ type: "filter", filter: ALL });
    });

    it("both sides share one read of a repository's files, however often the list changes meanwhile", async () => {
      await viewPick({ left: "release-1.4", right: "prod" });
      await until2("listed", repos, (x) => x.roots.length === 2);
      await select(roots["acme-api"]);
      await until2("api left", () => sideOf("left"), (x) => x.tree.length > 0);
      const web = roots["acme-web"];
      const before = (await snapshot()).spawnLog.length;
      await select(web);
      // The list changes while web's files are read: no read starts again.
      for (let i = 0; i < 4; i++) void vscode.commands.executeCommand("polylog._itest.compareRefresh");
      await until2("web left", () => sideOf("left"), (x) => x.tree.join() === "billing.ts | +1 −0");
      await until2("web right", () => sideOf("right"), (x) => x.message === "No changes on this side.");
      await sleep(500);
      const diffs = (await snapshot()).spawnLog.slice(before).filter((x) => x.cmd === "diff" && x.root === web).length;
      assert.strictEqual(diffs, 3, "one readFiles (each side's git diff, and the tips') for both sides");
    });

    it("a file renamed on one side opens against its old name at the other tip", async () => {
      const api = roots["acme-api"];
      const relTip = git(api, ["rev-parse", "refs/heads/release-1.4"]);
      // ren: release-1.4 with limit.go renamed (same content) to rate.go.
      const idx = path.join(os.tmpdir(), `polylog-ren-${process.pid}.index`);
      const env = { ...process.env, GIT_INDEX_FILE: idx };
      cp.execFileSync("git", ["read-tree", relTip], { cwd: api, env });
      const blob = cp.execFileSync("git", ["rev-parse", `${relTip}:limit.go`], { cwd: api }).toString().trim();
      cp.execFileSync("git", ["update-index", "--force-remove", "limit.go"], { cwd: api, env });
      cp.execFileSync("git", ["update-index", "--add", "--cacheinfo", `100644,${blob},rate.go`], { cwd: api, env });
      const tree = cp.execFileSync("git", ["write-tree"], { cwd: api, env }).toString().trim();
      fs.rmSync(idx, { force: true });
      const ren = git(api, ["commit-tree", tree, "-p", relTip, "-m", "refactor: rename limit to rate"]);
      git(api, ["update-ref", "refs/heads/ren", ren]);
      try {
        await viewPick({ left: "ren", right: "release-1.4" });
        await until2("listed", repos, (x) => x.roots.some((r) => r.startsWith("acme-api")));
        await select(api);
        await until2("ren left", () => sideOf("left"), (x) => x.tree.some((t) => t.startsWith("rate.go")));
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
        await vscode.commands.executeCommand("polylog.compareOpenFile", { side: "left", repoId: api, path: "rate.go" });
        const tab = await waitFor("a diff", () => {
          const t = vscode.window.tabGroups.activeTabGroup.activeTab;
          return t?.input instanceof vscode.TabInputTextDiff ? t.input : undefined;
        });
        assert.strictEqual((await vscode.workspace.openTextDocument(tab.original)).getText(), "package limit\n", "release-1.4 has it as limit.go: not an empty side");
        assert.strictEqual((await vscode.workspace.openTextDocument(tab.modified)).getText(), "package limit\n");
      } finally {
        cp.spawnSync("git", ["update-ref", "-d", "refs/heads/ren"], { cwd: api });
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      }
    });

    it("a file's status badge follows the pair (no badge from another pair's same path)", async () => {
      const api = roots["acme-api"];
      await viewPick({ left: "release-1.4", right: "prod" });
      await until2("listed", repos, (x) => x.roots.length === 2);
      await select(api);
      const a = await until2("api left", () => sideOf("left"), (x) => x.files.some((f) => f.startsWith("limit.go ")));
      const relTip = git(api, ["rev-parse", "refs/heads/release-1.4"]);
      git(api, ["update-ref", "refs/heads/rel-mod", commitOn(api, relTip, { "limit.go": "package limit // changed\n" }, "feat: tune the limit", T + 90)]);
      try {
        await viewPick({ left: "rel-mod", right: "release-1.4" });
        await until2("listed", repos, (x) => x.roots.some((r) => r.startsWith("acme-api")));
        await select(api);
        const b = await until2("rel-mod left", () => sideOf("left"), (x) => x.files.some((f) => f.startsWith("limit.go ")));
        const ua = a.files.find((f) => f.startsWith("limit.go "))!;
        const ub = b.files.find((f) => f.startsWith("limit.go "))!;
        assert.match(ua, / A$/);
        assert.match(ub, / M$/);
        assert.notStrictEqual(ua.split(" ")[1], ub.split(" ")[1], "a different result is a different URI, so VS Code asks for its badge again");
      } finally {
        cp.spawnSync("git", ["update-ref", "-d", "refs/heads/rel-mod"], { cwd: api });
      }
    });

    it("a hidden side reads nothing; shown again, it reads the selected repository", async () => {
      await viewPick({ left: "release-1.4", right: "prod" });
      await until2("listed", repos, (x) => x.roots.length === 2);
      await vscode.commands.executeCommand("polylog.compareLeft.removeView");
      await until2("left hidden", () => sideOf("left"), (x) => !x.open);
      const before = (await snapshot()).spawnLog.length;
      await select(roots["acme-web"]);
      await sleep(400);
      const diffs = (await snapshot()).spawnLog.slice(before).filter((x) => x.cmd === "diff").length;
      // readFiles runs both sides' diffs and the tips' in one call: 3 spawns for one side reading, 6 if both read.
      assert.strictEqual(diffs, 3, "only the shown (right) side read its files");
      await vscode.commands.executeCommand("polylog.compareLeft.focus");
      await until2("left shown and read", () => sideOf("left"), (x) => x.open && x.tree.join() === "billing.ts | +1 −0");
    });

    it("a swap while the list is still being read reads what it lacks", async () => {
      const p = pick({ left: "release-1.4", right: "prod" });
      await vscode.commands.executeCommand("polylog._itest.compareSwap");
      await p;
      const s = await waitFor("all rows after the swap", async () => {
        const x = await store();
        return !x.reading && x.rows.length === 3 ? x : undefined;
      });
      assert.ok(s.rows.includes("acme-web ◀0 ▶1 =0"), s.rows.join(" | "));
    });


  });
});

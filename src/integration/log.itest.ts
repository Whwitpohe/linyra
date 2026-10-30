import * as assert from "assert";
import * as vscode from "vscode";
import type { ChangeRow } from "../changesProtocol";
import type { LogSnapshot } from "../logView";
import type { WebviewMessage } from "../protocol";
import { UNCOMMITTED } from "../types";
import { EXPECTED_ORDER } from "./fixture";
import { EXTENSION_ID, snapshot, send, sleep, ALL, removeTestDirectory, waitFor, until, diffTab, tabCount, closeEditors, args, bySubject } from "./helpers";

describe("Linyra panel", () => {
  before(async () => {
    await vscode.commands.executeCommand("linyra.open");
    await until("the Log webview", (s) => s.readyCount >= 1 && s.repos.length === 3);
    await send({ type: "filter", filter: ALL });
  });

  it("merges commits from every repository, newest first", async () => {
    const s = await until("six rows", (x) => x.rows.length === 6);
    assert.deepStrictEqual(s.rows.map((r) => r.subject), EXPECTED_ORDER);
    assert.strictEqual(new Set(s.rows.map((r) => r.repoId)).size, 3);
    assert.strictEqual(s.profiles.length, 0, "retired Polylog profiles are ignored");
    assert.strictEqual(vscode.workspace.getConfiguration("linyra").inspect("excludeRepos")?.workspaceValue, undefined, "activation does not migrate old settings");
    const properties = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON.contributes.configuration.properties;
    // 7 Log settings (Update Project's method among them), 3 for avatars (linyra.avatars, avatarHosts,
    // avatarUrlTemplate) and 6 for AI (enabled, profiles, activeProfile, exclude, maxPromptTokens, commitMessageInstructions).
    assert.strictEqual(Object.keys(properties).length, 16);
    assert.ok(Object.keys(properties).every((key) => key.startsWith("linyra.")), "only Linyra settings are registered");
  });

  it("leaves upstream commands and revision URIs available to their owner", async () => {
    const legacyOpen = vscode.commands.registerCommand("polylog.open", () => "upstream command");
    const legacyContent = vscode.workspace.registerTextDocumentContentProvider("polylog", {
      provideTextDocumentContent: () => "upstream revision",
    });
    try {
      await vscode.commands.executeCommand("linyra.open");
      assert.strictEqual(await vscode.commands.executeCommand("polylog.open"), "upstream command");
      const upstream = await vscode.workspace.openTextDocument(vscode.Uri.parse("polylog:/namespace-isolation.txt"));
      assert.strictEqual(upstream.getText(), "upstream revision");
      const state = await until("Linyra remains available beside upstream registrations", (s) => s.rows.length === 6);
      assert.ok(state.repos.length === 3);
    } finally {
      legacyContent.dispose();
      legacyOpen.dispose();
    }
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

  it("hash lookup finds an old commit outside other filters, opens its diff and exits File History", async () => {
    await send({ type: "filter", filter: ALL });
    const start = await until("six rows for hash lookup", (x) => x.rows.length === 6);
    const target = bySubject(start, "feat: scaffold api");
    const oldFilter = { ...ALL, date: "24h" as const, author: "nobody", mine: true,
      branches: ["missing-branch"], path: "unrelated/path", text: target.sha.slice(0, 7).toUpperCase() };
    await send({ type: "filter", filter: oldFilter });
    let s = await until("old commit found by hash despite filters", (x) => x.rows.length === 1 && x.rows[0].sha === target.sha && x.done);
    assert.strictEqual(s.filter.author, "nobody");
    assert.strictEqual(s.filter.date, "24h", "hash lookup leaves saved filters intact");
    assert.deepStrictEqual(s.filter.branches, ["missing-branch"]);
    assert.strictEqual(s.failures.length, 0);
    await send({ type: "select", repoId: target.repoId, sha: target.sha });
    await until("hash result details", (x) => x.changes.presentation?.details[0]?.sha === target.sha);
    await closeEditors();
    await send({ type: "openFirst", repoId: target.repoId, sha: target.sha });
    await diffTab();
    await closeEditors();
    await send({ type: "filter", filter: { ...oldFilter, text: "" } });
    await until("previous restrictive filters restored", (x) => x.filter.text === "" && x.rows.length === 0 && x.done);
    await send({ type: "filter", filter: ALL });
    await until("all rows again", (x) => x.rows.length === 6);
    const targetRepo = start.repos.find((repo) => repo.id === target.repoId)!;
    await vscode.commands.executeCommand("linyra.fileHistory", vscode.Uri.joinPath(vscode.Uri.file(targetRepo.root), "upload.go"));
    s = await until("file history before hash lookup", (x) => x.history?.path === "upload.go");
    await send({ type: "filter", filter: { ...s.filter, text: target.sha } });
    await until("hash lookup leaves File History", (x) => x.history === null && x.rows.length === 1 && x.rows[0].sha === target.sha);
    await send({ type: "filter", filter: { ...ALL, text: "f".repeat(40) } });
    await until("unknown hash is an empty result", (x) => x.rows.length === 0 && x.done && x.failures.length === 0);
    await send({ type: "filter", filter: ALL });
    await until("six rows after hash lookup", (x) => x.rows.length === 6);
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

  it("searches with operators: author:, file:, and ref: only where a repository has it", async () => {
    const cp = require("child_process") as typeof import("child_process");
    await send({ type: "filter", filter: ALL });
    const api = (await until("six rows", (x) => x.rows.length === 6)).repos.find((r) => r.name === "acme-api")!;
    await send({ type: "filter", filter: { ...ALL, text: "author:rin" }, now: true });
    await until("rin's three commits", (x) => x.rows.length === 3 && x.rows.every((r) => r.author === "rin"));
    await send({ type: "filter", filter: { ...ALL, text: "file:upload.go" }, now: true });
    await until("upload.go's two commits", (x) => x.rows.length === 2 && x.rows.every((r) => r.repoId === api.id));
    await send({ type: "filter", filter: { ...ALL, text: "author:dana file:*.GO" }, now: true });
    await until("dana's Go commit, ignoring case", (x) => x.rows.length === 1 && x.rows[0].subject === "feat: scaffold api");
    await send({ type: "filter", filter: { ...ALL, text: "retry author:" }, now: true });
    let s = await until("an operator without a value runs nothing", (x) => x.filter.text === "retry author:" && x.done && x.rows.length === 0);
    assert.strictEqual(s.failures.length, 0);
    cp.execFileSync("git", ["branch", "release-1.4", "HEAD~1"], { cwd: api.root });
    try {
      await send({ type: "filter", filter: { ...ALL, text: "ref:release-1.4" }, now: true });
      s = await until("release-1.4, in acme-api only", (x) => x.rows.length === 1 && x.rows[0].subject === "feat: scaffold api");
      assert.strictEqual(s.failures.length, 0, "the repositories without it list nothing and report nothing");
      await send({ type: "filter", filter: { ...ALL, text: "ref:release-1.4..main" }, now: true });
      await until("the range", (x) => x.rows.length === 1 && x.rows[0].subject.startsWith("feat: add retry"));
    } finally {
      cp.execFileSync("git", ["branch", "-D", "release-1.4"], { cwd: api.root });
    }
    await send({ type: "filter", filter: ALL });
    await until("six rows again", (x) => x.rows.length === 6);
  });

  it("one native view keeps Log permanently expanded and remembers the integrated Changes layout", async () => {
    const manifest = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON;
    assert.deepStrictEqual(manifest.contributes.views.linyra.map((view: { id: string }) => view.id), ["linyra.log"]);
    const before = await snapshot();
    await send({ type: "layout", repoPaneWidth: before.layout.repoPaneWidth, changesPaneWidth: 420, changesPaneHeight: 260, showChanges: true });
    let state = await until("integrated changes visible", (x) => x.changesVisible && x.layout.changesPaneWidth === 420);
    assert.strictEqual(state.layout.changesPaneHeight, 260);
    await send({ type: "changesView", message: { type: "ready" } });
    await send({ type: "layout", repoPaneWidth: state.layout.repoPaneWidth, showChanges: false });
    await until("only changed files hidden", (x) => !x.changesVisible && x.layout.showChanges === false);
    assert.ok((await snapshot()).rows.length > 0, "hiding changed files never collapses the Log");
    await send({ type: "layout", repoPaneWidth: state.layout.repoPaneWidth, showChanges: true });
    state = await until("changed files restored", (x) => x.changesVisible);
    assert.strictEqual(state.layout.changesPaneWidth, 420);
    await send({ type: "layout", repoPaneWidth: state.layout.repoPaneWidth, changesPaneWidth: 360, changesPaneHeight: 240, showChanges: true });
  });

  it("restored toolbars preserve grouping, both layout directions, comparison display modes and independently movable changes", async () => {
    const before = await snapshot();
    await send({ type: "toolbarAction", action: "toggleRepos" });
    await until("toolbar toggled grouping", (x) => x.layout.groupByRepo !== before.layout.groupByRepo && x.toolbar.groupByRepo === x.layout.groupByRepo);
    await send({ type: "toolbarAction", action: "toggleRepos" });
    await until("grouping restored", (x) => x.layout.groupByRepo === before.layout.groupByRepo);
    for (const changesLayout of ["sideBySide", "stacked", "auto"] as const) {
      await send({ type: "layout", repoPaneWidth: before.layout.repoPaneWidth, changesLayout });
      assert.strictEqual((await snapshot()).layout.changesLayout, changesLayout);
    }
    for (const mode of ["commits", "files"] as const) {
      await vscode.commands.executeCommand(mode === "files" ? "linyra.compareShowFiles" : "linyra.compareShowCommits");
      const compare = await vscode.commands.executeCommand<{ mode: string }>("linyra._itest.compare");
      assert.strictEqual(compare?.mode, mode, "Show Files / Show Commits is retained in branch comparison");
    }
    await closeEditors();
    // From the Changes view's own ⋯ menu (the Log's ⋯ no longer repeats it).
    await send({ type: "changesView", message: { type: "action", action: "openChangesEditor" } });
    await waitFor("a movable changes editor tab", () => vscode.window.tabGroups.all.flatMap((group) => group.tabs)
      .some((tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes("linyra.changesEditor")) ? true : undefined);
    await closeEditors();
    await vscode.commands.executeCommand("linyra.changes.removeView");
    assert.strictEqual((await snapshot()).layout.showChanges, false);
    await vscode.commands.executeCommand("linyra.changes.focus");
    await until("legacy focus command reaches integrated changes", (x) => x.layout.showChanges === true && x.changesVisible);
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
    await vscode.commands.executeCommand("linyra.hideRepos");
    assert.strictEqual((await snapshot()).layout.groupByRepo, false);
    await vscode.commands.executeCommand("linyra.showRepos");
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
    await vscode.commands.executeCommand("linyra.fileHistory", vscode.Uri.file(require("path").join(api.root, "upload.go")));
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
      await vscode.commands.executeCommand("linyra.openDiff", { repoId: web.id, sha: UNCOMMITTED, parent: head, path: "client.ts" });
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
      // Every read records its cause, so a save is judged by the reads it caused, not by timing.
      // Refresh reads every repository twice (with the page, then forced once it is shown): let
      // the second land first, so a read of every repository after the mark can only be a bug.
      const quiet = () => waitFor("git to go quiet", async () => {
        const a = await snapshot();
        await sleep(1500);
        const b = await snapshot();
        return b.spawnLog.length === a.spawnLog.length ? b : undefined;
      });
      const statusSince = (from: LogSnapshot, to: LogSnapshot) => to.spawnLog.slice(from.spawnLog.length).filter((x) => x.cmd === "status").map((x) => x.root);
      const readsSince = (from: LogSnapshot, to: LogSnapshot, why: string) =>
        to.uncommittedReads.slice(from.uncommittedReads.length).filter((x) => x.why === why).map((x) => x.root);
      let mark = await quiet();
      await doc.save();
      await until("the files after a save", (x) => work(x)?.changes.length === 3);
      // Only the saved file's repository is read again (VS Code's Git reports it too, a moment later).
      await sleep(1500);
      let now = await snapshot();
      const read = readsSince(mark, now, "touched");
      assert.ok(read.length > 0 && read.every((root) => root === web.root), `a save re-reads only its own repository (read: ${read.join(", ")})`);
      if (now.stats.reloads === mark.stats.reloads) {
        assert.deepStrictEqual(readsSince(mark, now, "all"), [], "a save never reads every repository");
      }

      // A save that changes nothing git reports changes nothing.
      mark = now;
      const again = new vscode.WorkspaceEdit();
      again.insert(doc.uri, new vscode.Position(0, 0), "x");
      await vscode.workspace.applyEdit(again);
      await doc.save();
      await sleep(1500);
      now = await snapshot();
      assert.ok(readsSince(mark, now, "touched").length > 0, "it was read again");
      assert.deepStrictEqual(work(now), work(mark), "the same files on both sides");
      assert.ok(now.uncommittedChanges - mark.uncommittedChanges <= 1, "at most one change: the file's edit time moved, nothing else");

      // A save outside every repository reads nothing. First let VS Code's Git finish reporting
      // the saves above (on a slow runner its report comes seconds later).
      mark = await quiet();
      const outside = path.join(require("os").tmpdir(), `linyra-outside-${Date.now()}.txt`);
      fs.writeFileSync(outside, "a\n");
      const other = await vscode.workspace.openTextDocument(vscode.Uri.file(outside));
      const edit3 = new vscode.WorkspaceEdit();
      edit3.insert(other.uri, new vscode.Position(0, 0), "b");
      await vscode.workspace.applyEdit(edit3);
      await other.save();
      await sleep(1000);
      // VS Code's Git may still report acme-web on its own; the other repositories stay unread.
      const outsideRead = readsSince(mark, await snapshot(), "touched");
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
      // Where VS Code's Git reports nothing (here git.autorefresh off), no event keeps them current.
      // A filter still cannot change the working tree, so a reload reads none of them; they are
      // read when the Uncommitted side is shown (and when the window regains focus, and on Refresh).
      const gitCfg = () => vscode.workspace.getConfiguration("git");
      await gitCfg().update("autorefresh", false, vscode.ConfigurationTarget.Global);
      try {
        // Changing git.autorefresh makes VS Code's Git (1.85) look at every repository once more,
        // and report what it found: that lands before the mark, so the window holds the reload only.
        mark = await quiet();
        await send({ type: "filter", filter: { ...ALL, date: "7d" } });
        await until("the 7-day page", (x) => x.filter.date === "7d" && x.stats.reloads > mark.stats.reloads);
        await sleep(300);
        assert.deepStrictEqual(statusSince(mark, await snapshot()), [], "a reload reads no working tree, reported on or not");
        await send({ type: "logMode", mode: "uncommitted" });
        await waitFor("every repository read when the Uncommitted side is shown", async () => (new Set(statusSince(mark, await snapshot())).size === mark.repos.length ? true : undefined));
        await send({ type: "logMode", mode: "commits" });
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

  it("the summary row of uncommitted work: its files on the Commits side until a commit is selected; Commit… for its repository", async () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    await send({ type: "logMode", mode: "commits" });
    await send({ type: "filter", filter: ALL });
    const s = await until("six rows", (x) => x.rows.length === 6);
    const web = s.repos.find((r) => r.name === "acme-web")!;
    const c = s.rows.find((r) => r.repoId === web.id)!;
    const flatten = (nodes: ChangeRow[]): ChangeRow[] => nodes.flatMap((n) => [n, ...flatten(n.children ?? [])]);
    const shows = (name: string) => (x: LogSnapshot) => flatten(x.changes.presentation?.roots ?? []).some((r) => r.label === name) && x.changes.presentation?.details.length === 0;
    const files = ["summary-row.txt", "summary-row-2.txt"].map((f) => path.join(web.root, f));
    fs.writeFileSync(files[0], "work\n");
    try {
      await send({ type: "refresh" });
      await until("acme-web's work read", (x) => x.uncommitted.some((w) => w.repoId === web.id && w.changes.includes("summary-row.txt")));
      await send({ type: "select", repoId: c.repoId, sha: c.sha });
      await until("the commit's files", (x) => x.changes.presentation?.details[0]?.sha === c.sha);
      await send({ type: "showWork", repoId: web.id });
      await until("its work, the Commits side kept", (x) => shows("summary-row.txt")(x) && x.logMode === "commits");
      // A reload keeps the work shown: the commit's files it reads wait aside.
      const reloads = (await snapshot()).stats.reloads;
      await send({ type: "refresh" });
      await until("reloaded", (x) => x.stats.reloads > reloads);
      await sleep(300);
      assert.ok(shows("summary-row.txt")(await snapshot()), "a reload does not put a commit's files in its place");
      // New work shows as it is read.
      fs.writeFileSync(files[1], "more\n");
      await send({ type: "refresh" });
      await until("the new file too", shows("summary-row-2.txt"));
      // The Uncommitted side and back: the commit's tree waited aside all along.
      await send({ type: "logMode", mode: "uncommitted" });
      await until("the Uncommitted side shows the work", (x) => x.logMode === "uncommitted" && shows("summary-row.txt")(x));
      await send({ type: "logMode", mode: "commits" });
      await until("the commit's files back", (x) => x.changes.presentation?.details[0]?.sha === c.sha);
      // No repository named: the most recently edited one's; then a commit's selection takes the view back.
      await send({ type: "showWork" });
      await until("the most recently edited repository's work", shows("summary-row.txt"));
      await send({ type: "select", repoId: c.repoId, sha: c.sha });
      await until("a commit's selection takes the Changes view back", (x) => x.changes.presentation?.details[0]?.sha === c.sha);
      // Commit…: the Commit side bar, with acme-web's files alone ticked.
      await send({ type: "commitWork", repoId: web.id });
      await waitFor("the Commit side bar, acme-web's files ticked", async () => {
        const p = await vscode.commands.executeCommand<{ items: string[]; visible: boolean }>("linyra._itest.commitPanel");
        const ticked = p.items.filter((i) => i.trimStart().startsWith("[x]") && i.includes("summary-row"));
        return p.visible && ticked.length === 2 ? true : undefined;
      });
    } finally {
      for (const f of files) fs.rmSync(f, { force: true });
      await send({ type: "refresh" });
    }
    await until("nothing uncommitted in acme-web", (x) => !x.uncommitted.some((w) => w.repoId === web.id && w.changes.length > 0));
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
    const view = () => vscode.commands.executeCommand<{ message?: string; items: string[] }>("linyra._itest.uncommitted");
    const answer = (v: string | undefined) => vscode.commands.executeCommand("linyra._itest.answer", v);
    const seen = (what: string, ok: (items: string[]) => boolean) => waitFor(what, async () => { const v = await view(); return ok(v.items) ? v.items : undefined; });
    const staged = () => git("diff", "--cached", "--name-only").split("\n").filter(Boolean).sort();
    fs.writeFileSync(path.join(web.root, "client.ts"), "export const ok = 2;\n");
    fs.writeFileSync(path.join(web.root, "notes.md"), "todo\n");
    fs.writeFileSync(path.join(web.root, "extra.ts"), "x\n");
    git("add", "extra.ts");
    const smart = vscode.workspace.getConfiguration("git");
    try {
      await vscode.commands.executeCommand("linyra.focusUncommitted");
      await send({ type: "refresh" });
      let items = await seen("acme-web's uncommitted files", (i) => i.includes("acme-web | 3 files [repo.stageable]") && i.includes("  Staged | 1") && i.includes("  Changes | 2"));
      assert.ok(items.includes("    notes.md | new"), "untracked files say new");

      await vscode.commands.executeCommand("linyra.stage", { repoId: web.id, group: "changes", path: "client.ts" });
      assert.deepStrictEqual(staged(), ["client.ts", "extra.ts"], "git add, as git itself sees it");
      await seen("client.ts staged", (i) => i.includes("  Staged | 2") && i.includes("  Changes | 1"));
      await vscode.commands.executeCommand("linyra.unstage", { repoId: web.id, group: "staged", path: "client.ts" });
      assert.deepStrictEqual(staged(), ["extra.ts"], "unstaged again");
      await seen("client.ts back in Changes", (i) => i.includes("  Staged | 1") && i.includes("  Changes | 2"));

      // A file row's right-click: Open File opens the workspace copy.
      await vscode.commands.executeCommand("linyra.openWorkingFile", { kind: "file", repoId: web.id, group: "changes", path: "client.ts" });
      await waitFor("client.ts open", () => (vscode.window.activeTextEditor?.document.uri.fsPath === path.join(web.root, "client.ts") ? true : undefined));
      await closeEditors();

      // Discard Changes never deletes a new file: nothing to ask, the file stays. Delete… is the command that does.
      const asked = await vscode.commands.executeCommand<number>("linyra._itest.asked");
      await vscode.commands.executeCommand("linyra.discard", { repoId: web.id, group: "changes", path: "notes.md" });
      assert.strictEqual(await vscode.commands.executeCommand<number>("linyra._itest.asked"), asked, "nothing to discard: no question");
      assert.ok(fs.existsSync(path.join(web.root, "notes.md")), "a new file is not Discard's");
      await answer("Cancel");
      await vscode.commands.executeCommand("linyra.deleteNew", { repoId: web.id, group: "changes", path: "notes.md" });
      assert.ok(fs.existsSync(path.join(web.root, "notes.md")), "Cancel keeps the file");
      await answer("Delete");
      await vscode.commands.executeCommand("linyra.deleteNew", { repoId: web.id, group: "changes", path: "notes.md" });
      assert.strictEqual(await vscode.commands.executeCommand("linyra._itest.lastWarning"), 'Delete "notes.md"?');
      assert.ok(!fs.existsSync(path.join(web.root, "notes.md")), "Delete… deletes it");
      await seen("notes.md gone", (i) => !i.some((x) => x.includes("notes.md")));

      // Commit…: the Commit side bar, this repository's files checked, nothing asked; its Commit takes them.
      const panel = () => vscode.commands.executeCommand<{ checked: string; items: string[] }>("linyra._itest.commitPanel");
      const before = await vscode.commands.executeCommand<number>("linyra._itest.asked");
      await vscode.commands.executeCommand("linyra.commitRepo", { repoId: web.id });
      assert.strictEqual(await vscode.commands.executeCommand<number>("linyra._itest.asked"), before, "no input box, no modal");
      await waitFor("acme-web's two files checked", async () => ((await panel()).checked === "2 files checked" ? true : undefined));
      await vscode.commands.executeCommand("linyra._itest.commitSend", { type: "commit", message: "feat: commit from the view", amend: false, push: false, signOff: false });
      assert.strictEqual(git("log", "-1", "--format=%s"), "feat: commit from the view");
      await until("the new commit at the top of the Log", (x) => x.rows[0]?.subject === "feat: commit from the view");
      await seen("acme-web has nothing left", (i) => !i.some((x) => x.startsWith("acme-web")));
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
      assert.ok(s.workRows.includes("acme-api | notes.md, upload.go |  | main"), `the row: preview, no staged tag, the branch from the same git status (${s.workRows.join(" / ")})`);
      assert.ok((s.posts.uncommitted?.count ?? 0) > 0, "the webview was told");
      const before = { rows: s.rows.map((r) => r.subject), filter: s.filter };

      await send({ type: "logMode", mode: "uncommitted" });
      await until("the Uncommitted side", (x) => x.logMode === "uncommitted");
      await send({ type: "selectWork", repoId: api.id });
      s = await until("acme-api's files in the Changes view", (x) => x.changes.items[0]?.startsWith("acme-api | 2 files · not committed") === true);
      assert.deepStrictEqual(s.changes.items.slice(1).sort(), ["  notes.md | new", "  upload.go | +1 −1"]);
      // Its files open the same diffs as the Uncommitted view.
      await closeEditors();
      await vscode.commands.executeCommand("linyra.openDiff", { repoId: api.id, sha: UNCOMMITTED, parent: git(api.root, "rev-parse", "HEAD"), path: "upload.go" });
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
    await vscode.commands.executeCommand("linyra.open");
    await vscode.commands.executeCommand("linyra.changes.focus");
    await until("Changes visible before reading All Files", (x) => x.changesVisible);
    await vscode.commands.executeCommand("linyra.changesShowChanged");
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
      await vscode.commands.executeCommand("linyra.changesShowAll");
      let s = await until("the whole tree", (x) => x.changes.items.some((i) => i.trim().startsWith("package.json")) && x.changes.items.some((i) => i.trim().startsWith("one.ts")));
      const items = s.changes.items.map((i) => i.trim());
      assert.ok(items.includes("package.json |"), `an unchanged file, plain (${items.join(" / ")})`);
      assert.ok(items.some((i) => i.startsWith("CHANGELOG.md | ")), "the deleted file is listed where it was");
      assert.ok(items.some((i) => i.startsWith("one.ts | +1 −0")), "the added file, two folders down, opened because it holds a change");
      assert.ok(items.includes("lib |"), "a folder with no change, closed");
      assert.ok(!items.includes("x.ts |"), "and not read until opened");
      assert.strictEqual(lsTrees(mark, s), 3, "one git ls-tree per folder shown: the root, src, src/a");
      const filterRows = (nodes: ChangeRow[]): ChangeRow[] => nodes.flatMap((node) => [node, ...filterRows(node.children ?? [])]);
      const searchable = filterRows(s.changes.presentation?.searchRoots ?? []);
      const one = searchable.find((node) => node.kind === "file" && node.label === "one.ts");
      assert.strictEqual(one?.path, "src/a/one.ts", "file filtering sees the full changed path in All Files mode");
      assert.ok(!searchable.some((node) => node.label === "package.json"), "changed-file search does not claim to search unopened unchanged folders");
      await closeEditors();
      await vscode.commands.executeCommand("linyra._itest.changesMessage", { type: "open", id: one!.id });
      await diffTab();
      await closeEditors();

      mark = s;
      await vscode.commands.executeCommand("linyra._itest.changesMessage", { type: "action", action: "expandAll" });
      s = await until("lib's files", (x) => x.changes.items.some((i) => i.trim() === "x.ts |"));
      assert.strictEqual(lsTrees(mark, s), 1, "opening a folder reads that folder only");

      await closeEditors();
      await vscode.commands.executeCommand("linyra.openRevision", { repoId: libs.id, sha, path: "package.json" });
      const doc = await waitFor("package.json at that commit", () => {
        const d = vscode.window.activeTextEditor?.document;
        return (d?.uri.scheme === "git" || d?.uri.scheme === "linyra") && d.uri.path.endsWith("package.json") ? d : undefined;
      });
      assert.strictEqual(doc.getText(), git("show", `${sha}:package.json`) + "\n", "the file as it was at that commit");

      await vscode.commands.executeCommand("linyra.changesShowChanged");
      s = await until("changed files only", (x) => !x.changes.items.some((i) => i.trim().startsWith("package.json")));
      assert.ok(s.changes.items.some((i) => i.includes("one.ts")));
    } finally {
      await Promise.resolve(vscode.commands.executeCommand("linyra.changesShowChanged")).catch(() => undefined);
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
    const view = () => vscode.commands.executeCommand<{ message?: string; items: string[]; lastError?: string }>("linyra._itest.uncommitted");
    const answer = (v: string | undefined) => vscode.commands.executeCommand("linyra._itest.answer", v);
    const seen = (what: string, ok: (items: string[]) => boolean) => waitFor(what, async () => { const v = await view(); return ok(v.items) ? v.items : undefined; });
    const write = (f: string, text: string) => fs.writeFileSync(path.join(web.root, f), text);
    const gitCfg = () => vscode.workspace.getConfiguration("git");
    const api = (vscode.extensions.getExtension("vscode.git")!.exports as { getAPI(v: 1): { getRepository(u: vscode.Uri): { inputBox: { value: string } } | null } }).getAPI(1);
    const rightText = async () => {
      const t = await waitFor("a diff", () => { const i = vscode.window.tabGroups.activeTabGroup.activeTab?.input; return i instanceof vscode.TabInputTextDiff ? i : undefined; });
      return (await vscode.workspace.openTextDocument(t.modified)).getText();
    };
    try {
      await vscode.commands.executeCommand("linyra.focusUncommitted");
      // Review Focus 1: staged, then edited again: in both groups; the Staged diff shows the staged text, fresh after each stage.
      write("client.ts", "export const ok = 1;\n");
      git("add", "client.ts");
      write("client.ts", "export const ok = 2;\n");
      await send({ type: "refresh" });
      await seen("client.ts in both groups", (i) => i.includes("  Staged | 1") && i.includes("  Changes | 1"));
      await closeEditors();
      await vscode.commands.executeCommand("linyra.openUncommittedDiff", { repoId: web.id, group: "staged", path: "client.ts" });
      assert.strictEqual(await rightText(), "export const ok = 1;\n", "Staged: the index's version");
      await vscode.commands.executeCommand("linyra.stage", { repoId: web.id, group: "changes", path: "client.ts" });
      await seen("one Staged row, no Changes row", (i) => i.includes("  Staged | 1") && !i.includes("  Changes | 1"));
      // The first diff is still open: a stale index document would show here.
      await vscode.commands.executeCommand("linyra.openUncommittedDiff", { repoId: web.id, group: "staged", path: "client.ts" });
      assert.strictEqual(await rightText(), "export const ok = 2;\n", "staged again: the new index version, not a stale document");
      await closeEditors();

      // Review Focus 2: a group with new files in it. Discard leaves them; Delete… deletes them, after its own prompt.
      write("one.md", "1\n");
      write("two.md", "2\n");
      await send({ type: "refresh" });
      await seen("two new files", (i) => i.some((x) => x.includes("one.md")) && i.some((x) => x.includes("two.md")));
      await answer("Delete");
      await vscode.commands.executeCommand("linyra.deleteNew", { repoId: web.id, group: "changes" });
      assert.ok(!fs.existsSync(path.join(web.root, "one.md")) && !fs.existsSync(path.join(web.root, "two.md")), "both new files deleted");

      // A failing pre-commit hook, through Commit… (the Commit side bar): git's words, and the staged file stays staged.
      const commitPanel = () => vscode.commands.executeCommand<{ checked: string; lastError?: string }>("linyra._itest.commitPanel");
      const commitWith = async (message: string) => {
        await vscode.commands.executeCommand("linyra.commitRepo", { repoId: web.id });
        await waitFor("acme-web's file checked", async () => ((await commitPanel()).checked === "1 file checked" ? true : undefined));
        await vscode.commands.executeCommand("linyra._itest.commitSend", { type: "commit", message, amend: false, push: false, signOff: false });
      };
      const hook = path.join(web.root, ".git", "hooks", "pre-commit");
      fs.writeFileSync(hook, "#!/bin/sh\necho 'acme hook says no' >&2\nexit 1\n", { mode: 0o755 });
      await commitWith("feat: blocked by the hook");
      fs.rmSync(hook);
      const err = (await commitPanel()).lastError ?? "";
      assert.match(err, /acme-web \(.*acme hook says no/, `the repository and the hook's message (${err})`);
      assert.match(err, /The message is kept/, "and what to do");
      assert.deepStrictEqual(git("diff", "--cached", "--name-only"), "client.ts", "still staged");
      assert.strictEqual(git("rev-parse", "HEAD"), head, "nothing committed");

      // A draft in Source Control's message box survives a commit from Linyra.
      const repo = api.getRepository(vscode.Uri.file(web.root))!;
      repo.inputBox.value = "draft: half-written";
      await commitWith("feat: committed from Linyra");
      assert.strictEqual(git("log", "-1", "--format=%s"), "feat: committed from Linyra");
      assert.strictEqual(repo.inputBox.value, "draft: half-written", "the Source Control draft is kept");
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

  it("Delete… deletes exactly what its prompt listed, and also new files VS Code's Git hides", async () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const cp = require("child_process") as typeof import("child_process");
    const s0 = await until("six rows", (x) => x.rows.length === 6);
    const web = s0.repos.find((r) => r.name === "acme-web")!;
    const view = () => vscode.commands.executeCommand<{ items: string[] }>("linyra._itest.uncommitted");
    const seen = (what: string, ok: (items: string[]) => boolean) => waitFor(what, async () => { const v = await view(); return ok(v.items) ? v.items : undefined; });
    const at = (f: string) => path.join(web.root, f);
    const cfg = vscode.workspace.getConfiguration("git");
    try {
      await vscode.commands.executeCommand("linyra.focusUncommitted");
      fs.writeFileSync(at("listed.md"), "1\n");
      await send({ type: "refresh" });
      await seen("listed.md", (i) => i.some((l) => l.includes("listed.md")));
      // While the confirmation is open, a build writes another new file: it was not in the prompt.
      await vscode.commands.executeCommand("linyra._itest.beforeAnswer", async () => {
        fs.writeFileSync(at("late.md"), "2\n");
        await vscode.commands.executeCommand("linyra.refreshUncommitted");
        await seen("late.md read", (i) => i.some((l) => l.includes("late.md")));
      });
      await vscode.commands.executeCommand("linyra._itest.answer", "Delete");
      await vscode.commands.executeCommand("linyra.deleteNew", { repoId: web.id, group: "changes" });
      await waitFor("listed.md gone", () => (fs.existsSync(at("listed.md")) ? undefined : true));
      assert.ok(fs.existsSync(at("late.md")), "a file that appeared while the prompt was open is kept");
      // git.untrackedChanges hidden: VS Code's Git does not list new files, Linyra still deletes the one confirmed.
      fs.rmSync(at("late.md"));
      await cfg.update("untrackedChanges", "hidden", vscode.ConfigurationTarget.Global);
      fs.writeFileSync(at("hidden-new.md"), "3\n");
      await vscode.commands.executeCommand("linyra.refreshUncommitted");
      await seen("hidden-new.md", (i) => i.some((l) => l.includes("hidden-new.md")));
      await vscode.commands.executeCommand("linyra._itest.answer", "Delete");
      await vscode.commands.executeCommand("linyra.deleteNew", { repoId: web.id, group: "changes", path: "hidden-new.md" });
      await waitFor("hidden-new.md deleted", () => (fs.existsSync(at("hidden-new.md")) ? undefined : true));
    } finally {
      await vscode.commands.executeCommand("linyra._itest.beforeAnswer", undefined);
      await vscode.commands.executeCommand("linyra._itest.answer", undefined);
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
    const view = () => vscode.commands.executeCommand<{ items: string[]; lastError?: string }>("linyra._itest.uncommitted");
    const seen = (what: string, ok: (items: string[]) => boolean) => waitFor(what, async () => { const v = await view(); return ok(v.items) ? v.items : undefined; });
    const at = (f: string) => path.join(web.root, f);
    const committed = git("show", "HEAD:client.ts");
    // An earlier test's error stays as the last one shown; Discard must not add its own.
    const errorBefore = (await view()).lastError;
    try {
      await vscode.commands.executeCommand("linyra.focusUncommitted");
      // One staged file: its staged change and its working-tree change both go.
      fs.writeFileSync(at("client.ts"), "export const ok = 1;\n");
      git("add", "client.ts");
      fs.writeFileSync(at("client.ts"), "export const ok = 2;\n");
      await send({ type: "refresh" });
      await seen("client.ts staged and changed", (i) => i.includes("  Staged | 1") && i.includes("  Changes | 1"));
      await vscode.commands.executeCommand("linyra._itest.answer", "Discard File");
      await vscode.commands.executeCommand("linyra.discard", { repoId: web.id, group: "staged", path: "client.ts" });
      await waitFor("client.ts restored", () => (fs.readFileSync(at("client.ts"), "utf8") === `${committed}\n` ? true : undefined));
      assert.strictEqual(git("status", "--porcelain"), "", "nothing staged, nothing changed");

      // The whole repository: a staged edit, a staged new file, and two untracked files (acme-web tracks client.ts only).
      fs.writeFileSync(at("client.ts"), "export const ok = 3;\n");
      fs.writeFileSync(at("added.ts"), "export {};\n");
      git("add", "client.ts", "added.ts");
      fs.writeFileSync(at("CHANGELOG.md"), "- edited\n");
      fs.writeFileSync(at("loose.md"), "x\n");
      await send({ type: "refresh" });
      await seen("four files", (i) => i.includes("acme-web | 4 files [repo.stageable]"));
      // Discard Changes: tracked files back to the last commit; the added file only leaves version control; new files stay.
      await vscode.commands.executeCommand("linyra._itest.answer", "Discard Changes");
      await vscode.commands.executeCommand("linyra.discardAll", { repoId: web.id });
      assert.strictEqual(await vscode.commands.executeCommand("linyra._itest.lastDetail"),
        "This can't be undone. Staged changes are discarded too. The added file leaves version control and stays on disk as a new file. The 2 new files stay: Delete… removes them.");
      await waitFor("only the new files left", () => (git("status", "--porcelain").split("\n").sort().join(",") === "?? CHANGELOG.md,?? added.ts,?? loose.md" ? true : undefined));
      assert.ok(fs.existsSync(at("added.ts")) && fs.existsSync(at("loose.md")) && fs.existsSync(at("CHANGELOG.md")), "no file deleted");
      // Delete New Files… on the repository row: its new files, after their own prompt.
      await vscode.commands.executeCommand("linyra._itest.answer", "Delete");
      await vscode.commands.executeCommand("linyra.deleteNewAll", { webviewSection: "uncommitted", repoId: web.id });
      await waitFor("acme-web clean", () => (git("status", "--porcelain") === "" ? true : undefined));
      await seen("acme-web has nothing left", (i) => !i.some((x) => x.startsWith("acme-web")));
      assert.strictEqual((await view()).lastError, errorBefore, "no error from Discard");
    } finally {
      await vscode.commands.executeCommand("linyra._itest.answer", undefined);
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
      await vscode.commands.executeCommand("linyra.stage", node("notes.md"));
      await waitFor("notes.md staged", () => (git(api.root, "diff", "--cached", "--name-only").split("\n").includes("notes.md") ? true : undefined));
      await vscode.commands.executeCommand("linyra.unstage", node("upload.go"));
      await waitFor("upload.go unstaged", () => (git(api.root, "diff", "--cached", "--name-only") === "notes.md" ? true : undefined));
      assert.strictEqual(fs.readFileSync(at("upload.go"), "utf8"), "edited again\n", "Unstage keeps the working-tree edit");
      await vscode.commands.executeCommand("linyra.unstage", node("notes.md"));
      await waitFor("nothing staged", () => (git(api.root, "diff", "--cached", "--name-only") === "" ? true : undefined));
      git(api.root, "add", "upload.go");
      fs.writeFileSync(at("upload.go"), "edited again, after staging\n");
      await send({ type: "refresh" });
      await until("upload.go staged and edited again", (x) => {
        const w = x.uncommitted.find((u) => u.repoId === api.id);
        return w !== undefined && w.staged.includes("upload.go") && w.changes.includes("upload.go");
      });
      // A file node as the Changes view passes it: staged and edited again is still "Discard File".
      await vscode.commands.executeCommand("linyra._itest.answer", "Discard File");
      await vscode.commands.executeCommand("linyra.discard", { kind: "file", path: "upload.go", owner: { repoId: api.id, sha: UNCOMMITTED, parent: null } });
      await waitFor("upload.go restored", () => (fs.readFileSync(at("upload.go"), "utf8") === `${committed}\n` ? true : undefined));
      assert.strictEqual(git(api.root, "status", "--porcelain"), "?? notes.md", "only the other file is left");
      // The root row: everything in the repository.
      await until("acme-api down to one file", (x) => x.changes.items[0]?.startsWith("acme-api | 1 file") === true);
      // Only a new file left: Discard has nothing to take; Delete… on the root row deletes it.
      await vscode.commands.executeCommand("linyra._itest.answer", "Delete");
      await vscode.commands.executeCommand("linyra.deleteNew", { kind: "commit" });
      await waitFor("acme-api clean", () => (git(api.root, "status", "--porcelain") === "" ? true : undefined));
    } finally {
      await vscode.commands.executeCommand("linyra._itest.answer", undefined);
      git(api.root, "reset", "-q", "--hard");
      git(api.root, "clean", "-fdq");
      await send({ type: "logMode", mode: "commits" });
    }
    await send({ type: "refresh" });
  });

  it("bad input is ignored, not thrown: a null message, a malformed File History URI, a ../ diff path, a foreign revision", async () => {
    const s0 = await until("six rows", (x) => x.rows.length === 6);
    const c = bySubject(s0, "feat: add retry");
    // A null message from the webview, and a malformed linyra: URI for File History.
    await send(null as unknown as WebviewMessage);
    await vscode.commands.executeCommand("linyra.fileHistory", vscode.Uri.parse("linyra:/%E0%A4%A?x=%"));
    // A diff of a path that climbs out of the repository: refused, nothing opened.
    const before = vscode.window.tabGroups.all.flatMap((g) => g.tabs).length;
    const opened = await vscode.commands.executeCommand("linyra.openDiff", { repoId: c.repoId, sha: c.sha, parent: c.parents[0], path: "../../etc/passwd" });
    assert.strictEqual(opened, undefined);
    assert.strictEqual(vscode.window.tabGroups.all.flatMap((g) => g.tabs).length, before);
    // A revision document for a folder that is not one of the repositories: empty, no git run.
    const { encodeRevision } = require("../revisionUri") as typeof import("../revisionUri");
    const spawns = (await snapshot()).spawnLog.length;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.from({ scheme: "linyra", ...encodeRevision({ root: "/not/a/repo", ref: c.sha, path: "x.ts" }) }));
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

  it("Commit… opens the Commit side bar with that repository's files checked, never a prompt; a failed commit leaves the Log alone", async () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const cp = require("child_process") as typeof import("child_process");
    const s0 = await until("six rows", (x) => x.rows.length === 6);
    const web = s0.repos.find((r) => r.name === "acme-web")!;
    const api = s0.repos.find((r) => r.name === "acme-api")!;
    const asked = () => vscode.commands.executeCommand<number>("linyra._itest.asked");
    const panel = () => vscode.commands.executeCommand<{ checked: string; lastError?: string; items: string[] }>("linyra._itest.commitPanel");
    const hook = path.join(web.root, ".git", "hooks", "pre-commit");
    try {
      await vscode.commands.executeCommand("linyra.focusUncommitted");
      // Work in two repositories; Commit… on acme-web checks acme-web's files only.
      fs.writeFileSync(path.join(web.root, "client.ts"), "export const ok = 5;\n");
      fs.writeFileSync(path.join(api.root, "upload.go"), "package upload\n// edited\n");
      await send({ type: "refresh" });
      await waitFor("both repositories in the side bar", async () => ((await panel()).checked === "2 files checked in 2 repositories" ? true : undefined));
      const before = await asked();
      await vscode.commands.executeCommand("linyra.commitRepo", { repoId: web.id });
      assert.strictEqual(await asked(), before, "no input box, no modal");
      await waitFor("acme-web's file only", async () => ((await panel()).checked === "1 file checked" ? true : undefined));
      // Only a new file in the repository: that one is checked (the side bar leaves new files unchecked otherwise).
      cp.execFileSync("git", ["checkout", "--", "client.ts"], { cwd: web.root });
      fs.writeFileSync(path.join(web.root, "brand-new.md"), "x\n");
      await send({ type: "refresh" });
      await waitFor("brand-new.md listed", async () => ((await panel()).items.some((i) => i.includes("brand-new.md")) ? true : undefined));
      await vscode.commands.executeCommand("linyra.commitRepo", { repoId: web.id });
      await waitFor("the new file checked", async () => ((await panel()).checked === "1 file checked" ? true : undefined));
      // A failed commit: which repository did not commit and why, that the message is kept; no Log reload.
      fs.writeFileSync(hook, "#!/bin/sh\necho 'acme hook says no' >&2\nexit 1\n", { mode: 0o755 });
      const reloads = (await snapshot()).stats.reloads;
      await vscode.commands.executeCommand("linyra._itest.commitSend", { type: "commit", message: "feat: blocked", amend: false, push: false, signOff: false });
      const err = (await panel()).lastError ?? "";
      assert.match(err, /^Linyra could not commit: acme-web \(.*acme hook says no.*\)\. The message is kept: fix that, then Commit again\.$/s, err);
      assert.strictEqual((await snapshot()).stats.reloads, reloads, "a failed commit does not reload the Log");
    } finally {
      fs.rmSync(hook, { force: true });
      fs.rmSync(path.join(web.root, "brand-new.md"), { force: true });
      for (const r of [web, api]) {
        cp.execFileSync("git", ["reset", "-q"], { cwd: r.root });
        cp.execFileSync("git", ["checkout", "--", "."], { cwd: r.root });
      }
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
      const uv = await waitFor("the Uncommitted title reflects the refreshed work", async () => {
        const current = await vscode.commands.executeCommand<{ description: string }>("linyra._itest.uncommitted");
        return current.description === "1 file · 1 repository" ? current : undefined;
      });
      assert.strictEqual(uv.description, "1 file · 1 repository", "the Uncommitted view's title counts the work");
      // File History from the Uncommitted side goes back to the Commit list.
      await send({ type: "logMode", mode: "uncommitted" });
      await until("Uncommitted", (x) => x.logMode === "uncommitted");
      await vscode.commands.executeCommand("linyra.fileHistory", { kind: "file", repoId: web.id, group: "changes", path: "client.ts" });
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
      const props = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON.contributes.configuration.properties as Record<string, unknown>;
      assert.strictEqual(props["linyra.showUncommitted"], undefined);
      await send({ type: "refresh" });
      s = await until("only commits", (x) => x.rows.length === 6);
      assert.ok(!s.rows.some((r) => r.sha === UNCOMMITTED));
      // The Repo menu on the Log's Uncommitted rows.
      const menus = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON.contributes.menus["webview/context"] as { command: string; when: string }[];
      for (const c of ["linyra.repoShowOnly", "linyra.repoOpenFolder", "linyra.repoCopyPath", "linyra.repoPull"]) {
        assert.ok(menus.some((m) => m.command === c && m.when.includes("webviewId == 'linyra.log'") && m.when.includes("uncommitted")), `${c} on an Uncommitted row of the Log`);
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
    const view = () => vscode.commands.executeCommand<{ items: string[] }>("linyra._itest.uncommitted");
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
    await vscode.commands.executeCommand("linyra.repoShowOnly", on(web.id, "commit"));
    let s = await until("acme-web only", (x) => x.rows.length === 2 && x.rows.every((r) => r.repoId === web.id));
    assert.deepStrictEqual(s.filter.repoIds, [web.id], "from a commit row too, and the filter is the pane's");
    await vscode.commands.executeCommand("linyra.repoShowAll");
    await until("every repository", (x) => x.rows.length === 6 && x.filter.repoIds === null);
    await vscode.commands.executeCommand("linyra.repoHide", on(api.id));
    s = await until("all but acme-api", (x) => x.rows.length > 0 && !x.rows.some((r) => r.repoId === api.id));
    assert.deepStrictEqual(s.filter.repoIds, s0.repos.map((r) => r.id).filter((id) => id !== api.id), "the others stay ticked");
    await vscode.commands.executeCommand("linyra.repoShowAll");
    await until("every repository again", (x) => x.filter.repoIds === null && x.rows.length === 6);
    await vscode.commands.executeCommand("linyra.repoShowOnly", on("/not/a/repo"));
    assert.strictEqual((await snapshot()).filter.repoIds, null, "an id that is not a listed repository is ignored");

    await vscode.commands.executeCommand("linyra.repoCopyPath", on(libs.id));
    assert.strictEqual(await vscode.commands.executeCommand<string>("linyra._itest.clipboard"), libs.root);

    // With the pane hidden, a commit row's Show Only brings the pane back: no invisible filter.
    await vscode.commands.executeCommand("linyra.hideRepos");
    await vscode.commands.executeCommand("linyra.repoShowOnly", on(web.id, "commit"));
    s = await until("acme-web only, pane shown", (x) => x.filter.repoIds?.length === 1 && x.rows.length === 2);
    assert.strictEqual(s.layout.groupByRepo, true, "the filter is never one the user cannot see");
    await vscode.commands.executeCommand("linyra.repoShowAll");
    await until("every repository", (x) => x.filter.repoIds === null && x.rows.length === 6);

    const cfg = () => vscode.workspace.getConfiguration("linyra");
    // The user's own (global) exclusions stay: arrays do not merge across settings scopes.
    await cfg().update("excludeRepos", ["no-such-repo-*"], vscode.ConfigurationTarget.Global);
    try {
      // Excluding the repo shown alone must not leave a filter that matches nothing.
      await vscode.commands.executeCommand("linyra.repoShowOnly", on(libs.id));
      await until("acme-libs only", (x) => x.filter.repoIds?.[0] === libs.id);
      await vscode.commands.executeCommand("linyra.repoExclude", on(libs.id));
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
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), "linyra-pull-"));
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
      await vscode.commands.executeCommand("linyra.fetchAll");
      await until("acme-web behind by one", (x) => x.sync[web.id]?.behind === 1);

      const mark = await snapshot();
      await vscode.commands.executeCommand("linyra.repoPull", { webviewSection: "repo", repoId: web.id });
      await waitFor("the branch at the remote's commit", () => (git(web.root, "rev-parse", "HEAD") === theirs ? true : undefined));
      const ours = (await snapshot()).spawnLog.slice(mark.spawnLog.length).filter((x) => x.cmd === "pull");
      assert.deepStrictEqual(ours, [], "VS Code's own Git pulled it (its Pull, with its settings and messages), not Linyra's fallback");
      const s = await until("the pulled commit in the Log, no badge", (x) => x.sync[web.id] === undefined && x.rows.some((r) => r.subject === "chore: pulled from the remote"));
      assert.strictEqual(s.rows.length, 7);
    } finally {
      const quietly = (f: () => unknown) => { try { f(); } catch { /* not set up */ } };
      quietly(() => git(web.root, "reset", "-q", "--keep", before));
      quietly(() => git(web.root, "branch", "--unset-upstream", branch));
      quietly(() => git(web.root, "remote", "remove", "origin"));
      await removeTestDirectory(remote);
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
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), "linyra-pullall-"));
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

      const result = await vscode.commands.executeCommand<{ pulled: string[]; skipped: { name: string; reason: string }[] }>("linyra.fetchAndPullAll");
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
      await removeTestDirectory(remote);
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
    await vscode.commands.executeCommand("linyra.commitCopySha", on);
    assert.strictEqual(await vscode.commands.executeCommand<string>("linyra._itest.clipboard"), c.sha);
    await vscode.commands.executeCommand("linyra.commitCopyMessage", on);
    const full = cp.execFileSync("git", ["show", "-s", "--format=%B", c.sha], { cwd: repo.root }).toString().trim();
    assert.strictEqual(await vscode.commands.executeCommand<string>("linyra._itest.clipboard"), full, "the whole message, not only the subject the row shows");

    const git = (...args: string[]) => cp.execFileSync("git", args, { cwd: repo.root }).toString().trim();
    assert.strictEqual(await vscode.commands.executeCommand("linyra.commitOpenOnRemote", on), undefined, "no remote: nothing to open");
    git("remote", "add", "origin", "git@github.com:acme/acme-api.git");
    try {
      assert.strictEqual(await vscode.commands.executeCommand("linyra.commitOpenOnRemote", on), `https://github.com/acme/acme-api/commit/${c.sha}`);
    } finally {
      git("remote", "remove", "origin");
    }
    await vscode.commands.executeCommand("linyra._itest.setClipboard", "unchanged");
    await vscode.commands.executeCommand("linyra.commitCopySha", { ...on, sha: "not-a-sha" });
    await vscode.commands.executeCommand("linyra.commitCopySha", { ...on, sha: UNCOMMITTED });
    assert.strictEqual(await vscode.commands.executeCommand<string>("linyra._itest.clipboard"), "unchanged", "only a real commit of a listed repository");
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
    git("update-ref", "refs/heads/linyra-up", theirs);
    git("branch", "--set-upstream-to=linyra-up", branch);
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
      git("branch", "-D", "linyra-up");
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
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), "linyra-remote-"));
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
      assert.strictEqual((await snapshot()).sync[web.id], undefined, "not known before a fetch: Linyra never fetches on its own");
      const running = vscode.commands.executeCommand<{ fetched: number; failed: string[]; summary?: string }>("linyra.fetchAll");
      assert.strictEqual((await snapshot()).fetching, true, "the toolbar shows it is fetching");
      const result = await running;
      assert.deepStrictEqual(result, { fetched: 2, failed: ["acme-api"] }, "every repository fetched; the unreachable one named");
      assert.strictEqual((await snapshot()).fetching, false);
      // The unreachable remote gone: every fetch succeeds, and the status bar says what it found.
      git(api.root, "remote", "remove", "origin");
      const ok = await vscode.commands.executeCommand<{ fetched: number; failed: string[]; summary?: string }>("linyra.fetchAll");
      assert.strictEqual(ok.summary, "Linyra: fetched 3 repositories · 1 behind its upstream");
      const s = await until("acme-web behind by one", (x) => x.sync[web.id]?.behind === 1);
      assert.deepStrictEqual(s.sync[web.id], { ahead: 0, behind: 1 });

      await vscode.commands.executeCommand("linyra.showBehind");
      await until("only the repository behind", (x) => x.filter.repoIds?.join() === web.id && x.rows.every((r) => r.repoId === web.id));
      await vscode.commands.executeCommand("linyra.repoShowAll");
      await until("every repository including the fetched remote tip", (x) => x.filter.repoIds === null && x.rows.length === 7);
      assert.ok((await snapshot()).rows.some((row) => row.sha === theirs), "all-branches mode includes a fetched commit before it is pulled");
    } finally {
      // Each step on its own: one failing must not leave the others' state for later tests.
      const quietly = (f: () => unknown) => { try { f(); } catch { /* not set up */ } };
      quietly(() => git(web.root, "branch", "--unset-upstream", branch));
      quietly(() => git(web.root, "remote", "remove", "origin"));
      quietly(() => git(api.root, "remote", "remove", "origin"));
      await removeTestDirectory(remote);
    }
    await send({ type: "refresh" });
    await until("no badge without the remote", (x) => x.sync[web.id] === undefined && x.rows.length === 6);
  });

  it("hiding the Repositories pane clears its repo filter", async () => {
    const web = (await snapshot()).repos.find((r) => r.name === "acme-web")!;
    await send({ type: "filter", filter: { ...ALL, repoIds: [web.id] } });
    await until("acme-web only", (x) => x.rows.length === 2);
    await vscode.commands.executeCommand("linyra.hideRepos");
    const s = await until("every repo again", (x) => x.rows.length === 6);
    assert.strictEqual(s.filter.repoIds, null, "no invisible filter left behind");
    await vscode.commands.executeCommand("linyra.showRepos");
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
    await vscode.commands.executeCommand("linyra.openDiff", args(c, "upload.go"));
    const input = await diffTab();
    assert.strictEqual((await vscode.workspace.openTextDocument(input.original)).getText(), "package upload\n");
    assert.match((await vscode.workspace.openTextDocument(input.modified)).getText(), /func Retry/);
  });

  it("Open File on a diff opens the file as it is in the workspace now", async () => {
    await closeEditors();
    const c = bySubject(await snapshot(), "feat: scaffold api");
    await vscode.commands.executeCommand("linyra.openDiff", args(c, "upload.go"));
    const input = await diffTab();
    // The editor title button passes the diff's modified side.
    await vscode.commands.executeCommand("linyra.openWorkingFile", input.modified);
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
    await vscode.commands.executeCommand("linyra.openWorkingFile", { kind: "file", path: "client.ts" });
    const editor = await waitFor("the workspace file", () => {
      const e = vscode.window.activeTextEditor;
      return e?.document.uri.scheme === "file" ? e : undefined;
    });
    assert.match(editor.document.uri.fsPath, /acme-web[\\/]client\.ts$/);
    await closeEditors();
  });

  it("Changes detail view: separate commit metadata, current row ids and guarded copy/open messages", async () => {
    await send({ type: "filter", filter: ALL });
    const start = await until("six rows", (x) => x.rows.length === 6);
    const c = bySubject(start, "fix: guard nil");
    await send({ type: "select", repoId: c.repoId, sha: c.sha });
    const s = await until("separate commit details", (x) => x.changes.presentation?.details[0]?.sha === c.sha && x.changes.presentation?.roots.some((r) => r.label === "client.ts") === true);
    const page = s.changes.presentation!;
    assert.strictEqual(page.details[0].title, c.subject);
    assert.strictEqual(page.details[0].author, c.author);
    assert.strictEqual(page.details[0].email, c.email);
    const withRefs = await until("the selected commit's actual references", (x) => x.changes.presentation?.details[0]?.sha === c.sha && x.changes.presentation.details[0].containing !== undefined);
    const actualRefs = withRefs.changes.presentation!.details[0];
    assert.ok(actualRefs.refs?.some((r) => r.kind === "head" && r.name === "HEAD"));
    // HEAD is on a branch: that branch is listed, marked checked out, and HEAD is not listed beside it.
    assert.ok(actualRefs.containing?.some((r) => r.kind === "local" && r.current), "the checked-out branch contains it");
    assert.ok(!actualRefs.containing?.some((r) => r.kind === "head"), "an attached HEAD is its branch");
    assert.ok(actualRefs.refs?.some((r) => r.kind === "local"), "the actual local branch points here");
    const cp = require("child_process") as typeof import("child_process");
    const repo = s.repos.find((r) => r.id === c.repoId)!;
    const git = (...args: string[]) => cp.execFileSync("git", args, { cwd: repo.root }).toString().trim();
    try {
      git("branch", "linyra-detail-ref", c.sha);
      git("tag", "-a", "linyra-detail-tag", "-m", "detail reference fixture", c.sha);
      git("update-ref", "refs/remotes/linyra-detail-remote/preview", c.sha);
      await send({ type: "refresh" });
      const refreshed = await until("new branch, remote and annotated tag references", (x) => {
        const refs = x.changes.presentation?.details[0]?.refs ?? [];
        return refs.some((r) => r.kind === "local" && r.name === "linyra-detail-ref")
          && refs.some((r) => r.kind === "remote" && r.name === "linyra-detail-remote/preview")
          && refs.some((r) => r.kind === "tag" && r.name === "linyra-detail-tag");
      });
      const containing = refreshed.changes.presentation!.details[0].containing ?? [];
      assert.ok(containing.some((r) => r.kind === "local" && r.name === "linyra-detail-ref"));
      assert.ok(containing.some((r) => r.kind === "remote" && r.name === "linyra-detail-remote/preview"));
      assert.ok(!containing.some((r) => r.name === "linyra-detail-tag"), "tags do not inflate the branch count");
      // Detached at the same commit: no branch is checked out, so HEAD is listed, first.
      const branch = git("rev-parse", "--abbrev-ref", "HEAD");
      git("switch", "--detach", c.sha);
      try {
        await send({ type: "refresh" });
        const detached = await until("a detached HEAD among the containing branches", (x) => x.changes.presentation?.details[0]?.containing?.[0]?.kind === "head");
        assert.ok(!detached.changes.presentation!.details[0].containing!.some((r) => r.current), "no branch is checked out");
      } finally {
        git("switch", branch);
      }
    } finally {
      git("branch", "-D", "linyra-detail-ref");
      git("tag", "-d", "linyra-detail-tag");
      git("update-ref", "-d", "refs/remotes/linyra-detail-remote/preview");
      await send({ type: "refresh" });
    }
    assert.ok(!page.roots.some((r) => r.label === c.subject), "commit title does not occupy a file row");
    const row = page.roots.find((r) => r.label === "client.ts")!;
    const message = (value: unknown) => vscode.commands.executeCommand("linyra._itest.changesMessage", value);
    await message({ type: "copy", sha: c.sha, field: "sha" });
    assert.strictEqual(await vscode.commands.executeCommand<string>("linyra._itest.clipboard"), c.sha);
    await message({ type: "copy", sha: "f".repeat(40), field: "message" });
    assert.strictEqual(await vscode.commands.executeCommand<string>("linyra._itest.clipboard"), c.sha, "unknown commits cannot copy arbitrary data");
    await message({ type: "copy", sha: c.sha, field: "message" });
    assert.strictEqual(await vscode.commands.executeCommand<string>("linyra._itest.clipboard"), c.subject);
    await vscode.commands.executeCommand("linyra.copyRelativePath", { changesNodeId: row.id });
    assert.strictEqual(await vscode.commands.executeCommand<string>("linyra._itest.clipboard"), "client.ts");
    await vscode.commands.executeCommand("linyra.copyRelativePath", { changesNodeId: "stale-row", kind: "file", path: "forged.ts" });
    assert.strictEqual(await vscode.commands.executeCommand<string>("linyra._itest.clipboard"), "client.ts");
    await message({ type: "selection", ids: [row.id, "stale-row"] });
    assert.deepStrictEqual((await snapshot()).changes.selected, ["client.ts"]);
    await closeEditors();
    await message({ type: "open", id: row.id });
    await waitFor("the detail row's native diff", () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).some((t) => t.input instanceof vscode.TabInputTextDiff) ? true : undefined);
    await closeEditors();
  });

  it("menu parity: commit actions from the Changes root and a Compare row, Copy Path, File History from Compare, Stage/Unstage All", async () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const cp = require("child_process") as typeof import("child_process");
    const s0 = await until("six rows", (x) => x.rows.length === 6);
    const web = s0.repos.find((r) => r.name === "acme-web")!;
    const c = bySubject(s0, "fix: guard nil");
    const clip = async () => vscode.commands.executeCommand<string>("linyra._itest.clipboard");
    // The Changes view's root row (a commit): Copy Commit ID and Copy Message, as on the Log's row.
    await send({ type: "select", repoId: c.repoId, sha: c.sha });
    await until("the tree for that commit", (x) => x.changes.items.some((i) => i.includes("client.ts")));
    await vscode.commands.executeCommand("linyra.commitCopySha", { kind: "commit" });
    assert.strictEqual(await clip(), c.sha);
    await vscode.commands.executeCommand("linyra.commitCopyMessage", { kind: "commit" });
    assert.strictEqual(await clip(), "fix: guard nil response");
    // A Compare commit row passes its node: { kind, repoId, commit }.
    await vscode.commands.executeCommand("linyra._itest.setClipboard", "");
    await vscode.commands.executeCommand("linyra.commitCopySha", { kind: "commit", id: "x", repoId: c.repoId, commit: { sha: c.sha } });
    assert.strictEqual(await clip(), c.sha);
    // Copy Path and Copy Relative Path from a Changes file row.
    await vscode.commands.executeCommand("linyra.copyRelativePath", { kind: "file", path: "client.ts" });
    assert.strictEqual(await clip(), "client.ts");
    await vscode.commands.executeCommand("linyra.copyFilePath", { kind: "file", path: "client.ts" });
    assert.strictEqual(await clip(), path.join(web.root, "client.ts"));
    // File History from a Compare file row (it has a side).
    await vscode.commands.executeCommand("linyra.fileHistory", { kind: "file", id: "x", repoId: web.id, side: "left", path: "client.ts", name: "client.ts", file: { path: "client.ts", added: 1, deleted: 0 }, both: false });
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
      await vscode.commands.executeCommand("linyra.stageAll", { kind: "repo", repoId: web.id });
      await waitFor("both staged", () => (git("diff", "--cached", "--name-only").split("\n").sort().join(",") === "client.ts,extra.md" ? true : undefined));
      await until("both staged in the store", (x) => x.uncommitted.find((u) => u.repoId === web.id)?.staged.length === 2);
      await vscode.commands.executeCommand("linyra.unstageAll", { kind: "repo", repoId: web.id });
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
      await vscode.commands.executeCommand("linyra.stage", row(web.id, "docs/a.md"), [row(web.id, "docs/a.md"), row(web.id, "client.ts")]);
      await waitFor("two staged", () => (git(web.root, "diff", "--cached", "--name-only").split("\n").sort().join(",") === "client.ts,docs/a.md" ? true : undefined));
      git(web.root, "reset", "-q");
      await send({ type: "refresh" });
      await until("nothing staged in the store", (x) => work(x, web.id)?.staged.length === 0);
      // A Changes view folder on the Uncommitted side: Stage takes every file under it.
      await send({ type: "logMode", mode: "uncommitted" });
      await until("the Uncommitted side", (x) => x.logMode === "uncommitted");
      await send({ type: "selectWork", repoId: web.id });
      await until("acme-web in the Changes view", (x) => x.changes.items[0]?.startsWith("acme-web") === true);
      await vscode.commands.executeCommand("linyra.stage", { kind: "folder", path: "docs" });
      await waitFor("docs staged", () => (git(web.root, "diff", "--cached", "--name-only").split("\n").sort().join(",") === "docs/a.md,docs/b.md" ? true : undefined));
      const flatten = (nodes: ChangeRow[]): ChangeRow[] => nodes.flatMap((n) => [n, ...flatten(n.children ?? [])]);
      const docRows = (x: LogSnapshot) => flatten(x.changes.presentation?.roots ?? []).filter((n) => n.label === "a.md" || n.label === "b.md");
      const staged = await until("staged document rows in the webview", (x) => docRows(x).length === 2 && docRows(x).every((n) => n.contextValue.includes(".staged")));
      const ids = docRows(staged).map((n) => n.id);
      await vscode.commands.executeCommand("linyra._itest.changesMessage", { type: "selection", ids: [] });
      await vscode.commands.executeCommand("linyra._itest.changesMessage", { type: "selection", ids }, "editor");
      await vscode.commands.executeCommand("linyra.unstage", { changesNodeId: ids[0], changesViewId: "editor" });
      await waitFor("both webview-selected files unstaged", () => git(web.root, "diff", "--cached", "--name-only") === "" ? true : undefined);
      await until("unstaged document rows in the webview", (x) => docRows(x).length === 2 && docRows(x).every((n) => !n.contextValue.includes(".staged")));
      await vscode.commands.executeCommand("linyra._itest.changesMessage", { type: "selection", ids });
      await vscode.commands.executeCommand("linyra.stage", { changesNodeId: ids[0] });
      await waitFor("both webview-selected files staged", () => git(web.root, "diff", "--cached", "--name-only").split("\n").sort().join(",") === "docs/a.md,docs/b.md" ? true : undefined);
      await send({ type: "logMode", mode: "commits" });
      await send({ type: "refresh" });
      await until("docs staged in the store", (x) => work(x, web.id)?.staged.length === 2);
      // Discard rows of two repositories: one prompt for all of them.
      await vscode.commands.executeCommand("linyra._itest.answer", "Discard Changes");
      await vscode.commands.executeCommand("linyra.discard", row(web.id, "client.ts"), [row(web.id, "client.ts"), row(api.id, "upload.go")]);
      assert.strictEqual(await vscode.commands.executeCommand("linyra._itest.lastWarning"), "Discard changes in 2 files in 2 repositories?");
      await waitFor("both restored", () => (git(web.root, "status", "--porcelain", "--", "client.ts") === "" && git(api.root, "status", "--porcelain") === "" ? true : undefined));
      assert.strictEqual(git(web.root, "diff", "--cached", "--name-only").split("\n").sort().join(","), "docs/a.md,docs/b.md", "rows not selected are left alone");
    } finally {
      await vscode.commands.executeCommand("linyra._itest.answer", undefined);
      await send({ type: "logMode", mode: "commits" });
      for (const r of [web, api]) {
        git(r.root, "reset", "-q", "--hard");
        git(r.root, "clean", "-fdq");
      }
    }
    await send({ type: "refresh" });
  });

  it("profiles: read from linyra.profiles, switched by Show and Switch Profile…, other filters kept", async () => {
    const s0 = await until("six rows", (x) => x.rows.length === 6);
    const id = (name: string) => s0.repos.find((r) => r.name === name)!.id;
    const cfg = vscode.workspace.getConfiguration("linyra");
    try {
      await cfg.update("profiles", { backend: ["acme-api", "acme-libs", "acme-jobs"], web: ["acme-web"], bad: "acme-web" }, vscode.ConfigurationTarget.Workspace);
      let s = await until("profiles resolved", (x) => x.profiles.length === 2);
      assert.deepStrictEqual(s.profiles.map((p) => [p.name, p.ids, p.missing]), [
        ["backend", [id("acme-api"), id("acme-libs")], ["acme-jobs"]],
        ["web", [id("acme-web")], []],
      ], "a malformed profile is skipped; a missing repository is reported, not an error");
      // A filter set beforehand stays: a profile changes only the repositories.
      await send({ type: "filter", filter: { ...s.filter, author: "dana" } });
      await vscode.commands.executeCommand("linyra.profileShow", { webviewSection: "profile", profile: "backend" });
      s = await until("backend ticked", (x) => x.filter.repoIds?.join() === [id("acme-api"), id("acme-libs")].join());
      assert.strictEqual(s.filter.author, "dana", "Author kept");
      await vscode.commands.executeCommand("linyra._itest.answer", "web");
      await vscode.commands.executeCommand("linyra.profileSwitch");
      await until("web ticked", (x) => x.filter.repoIds?.join() === id("acme-web"));
      await vscode.commands.executeCommand("linyra._itest.answer", "All repositories");
      await vscode.commands.executeCommand("linyra.profileSwitch");
      await until("All again", (x) => x.filter.repoIds === null);
    } finally {
      await vscode.commands.executeCommand("linyra._itest.answer", undefined);
      await cfg.update("profiles", undefined, vscode.ConfigurationTarget.Workspace);
      await send({ type: "filter", filter: ALL });
    }
    await until("no profiles, six rows again", (x) => x.profiles.length === 0 && x.rows.length === 6);
  });

  it("profiles: save the ticks, a repository's Profiles…, update, rename (refuses a taken name), delete asks", async () => {
    const s0 = await until("six rows", (x) => x.rows.length === 6);
    const id = (name: string) => s0.repos.find((r) => r.name === name)!.id;
    const cfg = vscode.workspace.getConfiguration("linyra");
    const saved = () => cfg.inspect<Record<string, string[]>>("profiles")?.workspaceValue;
    const answer = (v: string | undefined) => vscode.commands.executeCommand("linyra._itest.answer", v);
    try {
      await send({ type: "filter", filter: { ...ALL, repoIds: [id("acme-api"), id("acme-libs")] } });
      await answer("backend");
      await vscode.commands.executeCommand("linyra.profileSave");
      await waitFor("backend saved", () => (saved()?.backend?.join() === "acme-api,acme-libs" ? true : undefined));
      await until("backend resolved", (x) => x.profiles.some((p) => p.name === "backend"));
      // A repository's Profiles…: add acme-web to backend and make a new profile with it.
      await answer(JSON.stringify(["backend", "New profile with acme-web…"]));
      await answer("web");
      await vscode.commands.executeCommand("linyra.repoProfiles", { webviewSection: "repo", repoId: id("acme-web") });
      await waitFor("memberships", () => (saved()?.backend?.join() === "acme-api,acme-libs,acme-web" && saved()?.web?.join() === "acme-web" ? true : undefined));
      // ...and take it out again: unticked = removed.
      await answer(JSON.stringify([]));
      await vscode.commands.executeCommand("linyra.repoProfiles", { webviewSection: "repo", repoId: id("acme-web") });
      await waitFor("removed", () => (saved()?.backend?.join() === "acme-api,acme-libs" && saved()?.web?.length === 0 ? true : undefined));
      // Update to Current Selection.
      await send({ type: "filter", filter: { ...ALL, repoIds: [id("acme-api")] } });
      await vscode.commands.executeCommand("linyra.profileUpdate", { webviewSection: "profile", profile: "backend" });
      await waitFor("updated", () => (saved()?.backend?.join() === "acme-api" ? true : undefined));
      // Rename to a taken name (any case) changes nothing; to a free one, renames.
      await answer("WEB");
      await vscode.commands.executeCommand("linyra.profileRename", { webviewSection: "profile", profile: "backend" });
      assert.ok(saved()?.backend && !saved()?.WEB, "a taken name is refused");
      await answer("api");
      await vscode.commands.executeCommand("linyra.profileRename", { webviewSection: "profile", profile: "backend" });
      await waitFor("renamed", () => (saved()?.api?.join() === "acme-api" && !saved()?.backend ? true : undefined));
      // Delete asks; Cancel keeps it.
      await answer("Cancel");
      await vscode.commands.executeCommand("linyra.profileDelete", { webviewSection: "profile", profile: "api" });
      assert.ok(saved()?.api, "Cancel keeps it");
      await answer("Delete");
      await vscode.commands.executeCommand("linyra.profileDelete", { webviewSection: "profile", profile: "api" });
      await waitFor("deleted", () => (saved()?.api === undefined ? true : undefined));
      assert.strictEqual(await vscode.commands.executeCommand("linyra._itest.lastWarning"), 'Delete profile "api"?');
    } finally {
      await answer(undefined);
      await cfg.update("profiles", undefined, vscode.ConfigurationTarget.Workspace);
      await send({ type: "filter", filter: ALL });
    }
  });

  it("profiles: a write never copies User-level profiles into the workspace; Profiles… with no change writes nothing", async () => {
    const s0 = await until("six rows", (x) => x.rows.length === 6);
    const id = (name: string) => s0.repos.find((r) => r.name === name)!.id;
    const cfg = vscode.workspace.getConfiguration("linyra");
    const ws = () => vscode.workspace.getConfiguration("linyra").inspect<Record<string, string[]>>("profiles")?.workspaceValue;
    const answer = (v: string | undefined) => vscode.commands.executeCommand("linyra._itest.answer", v);
    try {
      await cfg.update("profiles", { personal: ["acme-web"] }, vscode.ConfigurationTarget.Global);
      await until("the User profile is listed", (x) => x.profiles.some((p) => p.name === "personal"));
      // Accepting Profiles… unchanged writes no workspace setting at all.
      await answer(JSON.stringify(["personal"]));
      await vscode.commands.executeCommand("linyra.repoProfiles", { webviewSection: "repo", repoId: id("acme-web") });
      assert.strictEqual(ws(), undefined, "nothing changed: nothing written");
      // Saving a workspace profile writes only it.
      await send({ type: "filter", filter: { ...ALL, repoIds: [id("acme-api")] } });
      await answer("backend");
      await vscode.commands.executeCommand("linyra.profileSave");
      await waitFor("backend saved", () => (ws()?.backend ? true : undefined));
      assert.deepStrictEqual(ws(), { backend: ["acme-api"] }, "the User profile is not copied into the workspace");
      // Deleting a User-level profile from here leaves both scopes as they were.
      await answer("Delete");
      await vscode.commands.executeCommand("linyra.profileDelete", { webviewSection: "profile", profile: "personal" });
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
    await vscode.commands.executeCommand("linyra.openDiff", args(c, "upload.go"));
    const input = await diffTab();
    const editor = await waitFor("the modified side focused", () => {
      const e = vscode.window.activeTextEditor;
      return e?.document.uri.toString() === input.modified.toString() ? e : undefined;
    });
    const blameOn = (line: number, re: RegExp) => {
      editor.selection = new vscode.Selection(line, 0, line, 0);
      return waitFor(`blame on line ${line + 1}`, async () => {
        const b = await vscode.commands.executeCommand<{ line: number; text: string } | undefined>("linyra._itest.blame");
        return b && b.line === line && re.test(b.text) ? b : undefined;
      });
    };
    await blameOn(2, /^feat: add retry to uploader \(ACME-7\), rin \(.+ ago\)$/);
    await blameOn(0, /^feat: scaffold api, dana /);
    const config = vscode.workspace.getConfiguration("linyra");
    await config.update("blame", false, vscode.ConfigurationTarget.Global);
    try {
      await waitFor("blame cleared when turned off", async () => ((await vscode.commands.executeCommand("linyra._itest.blame")) === undefined ? true : undefined));
    } finally {
      await config.update("blame", undefined, vscode.ConfigurationTarget.Global);
    }
  });

  it("shows an empty before side for a root commit", async () => {
    await closeEditors();
    const c = bySubject(await snapshot(), "feat: scaffold api");
    await vscode.commands.executeCommand("linyra.openDiff", args(c, "upload.go"));
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
    const bad = "--output=/tmp/linyra-pwned";
    await vscode.commands.executeCommand("linyra.openDiff", { ...args(c, "x"), sha: bad });
    await send({ type: "openFirst", repoId: c.repoId, sha: bad });
    await send({ type: "select", repoId: c.repoId, sha: bad });
    await sleep(300);
    assert.strictEqual(tabCount(), 0);
  });

  it("File History lists one file's commits and the diff follows the selection", async () => {
    await closeEditors();
    await send({ type: "filter", filter: { ...ALL, date: "7d" } });
    const api = (await snapshot()).repos.find((r) => r.name === "acme-api")!;
    await vscode.commands.executeCommand("linyra.fileHistory", vscode.Uri.file(require("path").join(api.root, "upload.go")));
    let s = await until("upload.go history", (x) => x.history?.path === "upload.go" && x.rows.length === 2);
    assert.strictEqual(s.filter.date, "all", "file history shows all time");
    assert.deepStrictEqual(s.rows.map((r) => r.subject), ["feat: add retry to uploader (ACME-7)", "feat: scaffold api"]);
    // Opening a history shows its newest revision straight away (the Log selects row 0).
    await until("the newest revision is shown", (x) => x.changes.items[0]?.startsWith("feat: add retry") === true);
    const older = s.rows[1];
    await send({ type: "select", repoId: older.repoId, sha: older.sha });
    const input = await waitFor("the older revision's diff", () => {
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      return tab instanceof vscode.TabInputTextDiff && (tab.modified.scheme === "git" || tab.modified.scheme === "linyra") && tab.modified.query.includes(older.sha) ? tab : undefined;
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
    await vscode.commands.executeCommand("linyra.fileHistory", vscode.Uri.file(require("path").join(api.root, "upload.go")));
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
      await vscode.commands.executeCommand("linyra.fileHistory", vscode.Uri.file(require("path").join(api.root, "upload.go")));
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
      await vscode.commands.executeCommand("linyra.fileHistory", vscode.Uri.file(require("path").join(web.root, "client.ts")));
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
    await vscode.commands.executeCommand("linyra.fileHistory", vscode.Uri.file(require("path").join(api.root, "upload.go")));
    let s = await until("history", (x) => x.history !== null);
    assert.strictEqual(s.filter.date, "all");
    assert.strictEqual(s.persistedFilter?.date, "7d", "a window reload now would bring back 7 days, not all time");
    const cfg = vscode.workspace.getConfiguration("linyra");
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

  it("File History: each row's status and lines, the uncommitted row, two rows compared, blame, a re-created and a new file, Folder History", async () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const cp = require("child_process") as typeof import("child_process");
    await closeEditors();
    await send({ type: "filter", filter: ALL });
    const s0 = await until("six rows", (x) => x.rows.length === 6);
    const web = s0.repos.find((r) => r.name === "acme-web")!;
    const who = { ...process.env, GIT_AUTHOR_NAME: "dana", GIT_AUTHOR_EMAIL: "dana@example.com", GIT_COMMITTER_NAME: "dana", GIT_COMMITTER_EMAIL: "dana@example.com" };
    const git = (...a: string[]) => cp.execFileSync("git", a, { cwd: web.root, env: who }).toString().trim();
    const head = git("rev-parse", "HEAD");
    const at = (f: string) => path.join(web.root, f);
    const activeDiff = (ok: (t: vscode.TabInputTextDiff) => boolean) => waitFor("a diff", () => {
      const t = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      return t instanceof vscode.TabInputTextDiff && ok(t) ? t : undefined;
    });
    const text = async (uri: vscode.Uri) => (await vscode.workspace.openTextDocument(uri)).getText();
    try {
      // Each row: the file's status letter and its lines, from the history's own git log (--raw --numstat).
      await vscode.commands.executeCommand("linyra.fileHistory", vscode.Uri.file(at("client.ts")));
      let s = await until("client.ts history", (x) => x.history?.path === "client.ts" && x.rows.length === 2 && x.done);
      assert.deepStrictEqual(s.rows.map((r) => [r.subject, r.file]), [
        ["fix: guard nil response", { path: "client.ts", status: "M", added: 1, deleted: 1 }],
        ["feat: scaffold web", { path: "client.ts", status: "A", added: 1, deleted: 0 }],
      ]);
      assert.strictEqual(s.historyWork, null, "nothing uncommitted: no row above the commits");
      const [newer, older] = s.rows;

      // The uncommitted row comes from the uncommitted store: a save reads the work, no git log.
      await until("the newest revision is shown", (x) => x.changes.items[0]?.startsWith("fix: guard nil") === true);
      const mark = await waitFor("git to go quiet", async () => {
        const a = await snapshot();
        await sleep(1000);
        const b = await snapshot();
        return b.spawnLog.length === a.spawnLog.length ? b : undefined;
      });
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(at("client.ts")));
      const edit = new vscode.WorkspaceEdit();
      edit.insert(doc.uri, new vscode.Position(1, 0), "export const two = 2;\n");
      await vscode.workspace.applyEdit(edit);
      await doc.save();
      s = await until("the uncommitted row", (x) => x.historyWork !== null);
      assert.deepStrictEqual(s.historyWork, { path: "client.ts", status: "M", untracked: false, staged: false, partlyStaged: false, added: 1, deleted: 0 });
      if (s.stats.reloads === mark.stats.reloads) {
        assert.deepStrictEqual(s.spawnLog.slice(mark.spawnLog.length).filter((x) => x.cmd === "log"), [], "the row costs no git log");
      }
      // It opens the file from the last commit to the working tree.
      await closeEditors();
      await send({ type: "openHistoryWork" });
      const work = await activeDiff((t) => t.modified.scheme === "file");
      assert.strictEqual(await text(work.original), "export const ok = true;\n", "the left side is the last commit");
      assert.strictEqual(path.basename(work.modified.fsPath), "client.ts");

      // Two rows: the file between their revisions, not Combined Changes.
      await closeEditors();
      await send({ type: "selectMany", items: [{ repoId: newer.repoId, sha: newer.sha }, { repoId: older.repoId, sha: older.sha }], focus: { repoId: newer.repoId, sha: newer.sha } });
      const pair = await activeDiff((t) => t.original.query.includes(older.sha) && t.modified.query.includes(newer.sha));
      assert.deepStrictEqual([await text(pair.original), await text(pair.modified)], ["export {};\n", "export const ok = true;\n"], "older on the left, newer on the right");
      s = await until("the focused commit in Changes", (x) => x.changes.items[0]?.startsWith("fix: guard nil") === true);
      assert.deepStrictEqual(s.changes.combined, [], "no Combined Changes");

      // Blame at This Revision: the file at that commit, where the Log's blame draws.
      await closeEditors();
      await vscode.commands.executeCommand("linyra.historyBlame", { repoId: older.repoId, sha: older.sha });
      const blamed = await waitFor("the blame at the older revision", async () => {
        const b = await vscode.commands.executeCommand<{ uri: string; text: string } | undefined>("linyra._itest.blame");
        return b && b.uri.includes(older.sha) ? b : undefined;
      });
      assert.match(blamed.text, /feat: scaffold web/);
      await send({ type: "exitHistory" });
      await until("all commits", (x) => x.history === null && x.historyWork === null);

      // A path deleted and created again keeps its earlier history; the new file is its uncommitted row.
      git("checkout", "-q", "--", "client.ts");
      git("rm", "-q", "client.ts");
      git("commit", "-q", "-m", "chore: drop the client");
      fs.writeFileSync(at("client.ts"), "export const again = 1;\n");
      await send({ type: "refresh" });
      await until("client.ts new again", (x) => x.uncommitted.some((w) => w.repoId === web.id && w.changes.includes("client.ts")));
      // From the Commit side bar: its file row.
      await vscode.commands.executeCommand("linyra.fileHistory", { kind: "file", repoId: web.id, group: "changes", path: "client.ts" });
      s = await until("the re-created path's history", (x) => x.history?.path === "client.ts" && x.rows.length === 3 && x.done);
      assert.deepStrictEqual(s.rows.map((r) => r.file?.status), ["D", "M", "A"]);
      assert.deepStrictEqual(s.rows[0].file, { path: "client.ts", status: "D", added: 0, deleted: 1 });
      assert.deepStrictEqual(s.historyWork, { path: "client.ts", status: "A", untracked: true, staged: false, partlyStaged: false });
      // Blame on the row that deleted the file has nothing to show (its menu leaves it out).
      await closeEditors();
      await vscode.commands.executeCommand("linyra.historyBlame", { repoId: web.id, sha: s.rows[0].sha });
      await sleep(300);
      assert.strictEqual(tabCount(), 0);
      await send({ type: "exitHistory" });
      await until("all commits", (x) => x.history === null);

      // Never committed: no rows (the webview says so), only the uncommitted row.
      fs.writeFileSync(at("notes.md"), "todo\n");
      await send({ type: "refresh" });
      await until("notes.md uncommitted", (x) => x.uncommitted.some((w) => w.repoId === web.id && w.changes.includes("notes.md")));
      await vscode.commands.executeCommand("linyra.fileHistory", { kind: "file", repoId: web.id, group: "changes", path: "notes.md" });
      s = await until("notes.md history", (x) => x.history?.path === "notes.md" && x.done);
      assert.deepStrictEqual([s.rows.length, s.historyWork?.status, s.historyWork?.untracked], [0, "A", true]);
      await send({ type: "exitHistory" });
      await until("all commits", (x) => x.history === null);

      // Folder History: the Log's Path filter for a folder of one repository (from the Commit side bar's folder row).
      fs.mkdirSync(at("src"), { recursive: true });
      fs.writeFileSync(at("src/view.ts"), "export {};\n");
      git("add", "src/view.ts");
      git("commit", "-q", "-m", "feat: a view");
      await send({ type: "filter", filter: { ...ALL, date: "7d", text: "nothing matches this" } });
      await vscode.commands.executeCommand("linyra.folderHistory", { kind: "folder", repoId: web.id, path: "src" });
      s = await until("the folder's commits", (x) => x.filter.path === "src" && x.done && x.rows.length === 1);
      assert.deepStrictEqual([s.history, s.logMode, s.filter.repoIds, s.filter.date, s.filter.text], [null, "commits", [web.id], "all", ""], "no mode of its own: the Path filter, its repository, all time");
      assert.strictEqual(s.rows[0].subject, "feat: a view");
      assert.strictEqual(s.persistedFilter?.path, "src", "a filter like any other: saved for the next window");
    } finally {
      await closeEditors();
      if ((await snapshot()).history) await send({ type: "exitHistory" });
      git("reset", "-q", "--hard", head);
      git("clean", "-fdq");
      await send({ type: "filter", filter: ALL });
      await send({ type: "refresh" });
      await until("six rows again", (x) => x.rows.length === 6 && x.filter.path === undefined);
    }
  });

  it("a selected branch skips repositories without it; multiple selections form a union and persist", async () => {
    await send({ type: "filter", filter: { ...ALL, branch: "prod" } });
    let s = await until("prod in acme-api only", (x) => x.rows.length === 1 && x.branchUse?.found === 1);
    assert.deepStrictEqual(s.branchUse, { branches: ["prod"], found: 1, missing: 2 });
    assert.ok(!s.rows.some((r) => r.subject.startsWith("feat: add retry")), "acme-api shows prod, which is one commit behind");
    assert.strictEqual(s.rows[0].subject, "feat: scaffold api");
    await send({ type: "filter", filter: { ...ALL, branches: ["main", "prod"] } });
    s = await until("both branches without duplicates", (x) => x.rows.length === 6 && x.branchUse?.found === 3);
    assert.strictEqual(new Set(s.rows.map((c) => `${c.repoId}/${c.sha}`)).size, 6);
    assert.deepStrictEqual(s.persistedFilter?.branches, ["main", "prod"]);
    await send({ type: "ready" });
    s = await until("saved branch selection replayed", (x) => x.filter.branches?.length === 2 && x.rows.length === 6);
    assert.deepStrictEqual(s.filter.branches, ["main", "prod"]);
    await send({ type: "filter", filter: { ...s.filter, sort: "topo" } });
    s = await until("topological sort saved with the branches", (x) => x.filter.sort === "topo" && x.rows.length === 6);
    assert.strictEqual(s.persistedFilter?.sort, "topo");
    s.rows.forEach((row, i) => row.parents.forEach((parent) => {
      const parentIndex = s.rows.findIndex((p) => p.repoId === row.repoId && p.sha === parent);
      if (parentIndex >= 0) assert.ok(i < parentIndex, "child before parent in the merged topological page");
    }));
    assert.ok(s.rows.some((row) => row.refs?.some((ref) => ref.kind === "local" && ref.name === "main")), "row decorations carry real branch references");
    await send({ type: "filter", filter: { ...s.filter, branches: [] } });
    await until("cleared branch selection shows all", (x) => !x.branchUse && x.rows.length === 6);
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
    await vscode.commands.executeCommand("linyra.open");
    await sleep(1000);
    assert.strictEqual((await snapshot()).readyCount, before, "the webview was destroyed and re-created");
  });

  it("switching git.path takes effect at once, and a path that cannot run falls back", async function () {
    if (process.platform === "win32") this.skip(); // the wrapper is a shell script
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const os = require("os") as typeof import("os");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "linyra-gitpath-"));
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
  it("Linyra never reopens a view: a hidden Changes view stays hidden, and keeps the selection", async () => {
    const rows = (await until("six rows", (x) => x.rows.length === 6)).rows;
    const c = rows.find((r) => r.subject.startsWith("feat: add retry"))!;
    const other = rows.find((r) => r.subject.startsWith("fix: guard nil"))!;
    await send({ type: "select", repoId: c.repoId, sha: c.sha });
    await until("Changes showing the commit", (x) => x.changesVisible && x.changes.items.some((i) => i.includes("upload.go")));
    const width = (await snapshot()).layout.repoPaneWidth;
    await send({ type: "layout", repoPaneWidth: width, showChanges: false });
    await sleep(1200);
    assert.strictEqual((await snapshot()).changesVisible, false, "hidden on the first try: nothing reopens it");
    // Rule 5: it still follows the selection while hidden, and shows it when opened.
    await send({ type: "select", repoId: other.repoId, sha: other.sha });
    await sleep(800);
    let s = await snapshot();
    assert.strictEqual(s.changesVisible, false, "a selection does not bring it back");
    assert.ok(s.changes.items.some((i) => i.includes("client.ts")), "but it has the new commit's files");
    await send({ type: "layout", repoPaneWidth: width, showChanges: true });
    s = await until("shown again by the user", (x) => x.changesVisible);
    assert.ok(s.changes.items.some((i) => i.includes("client.ts")));
  });
});

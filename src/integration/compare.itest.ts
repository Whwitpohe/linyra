// Compare Branches: two branches across every ticked repository (runs after log.itest, see index.ts).
import * as assert from "assert";
import * as vscode from "vscode";
import type { Pair } from "../compareModel";
import { EXTENSION_ID, snapshot, send, sleep, ALL, waitFor, until, diffTab, closeEditors } from "./helpers";

describe("Compare Branches", () => {
  before(async () => {
    await vscode.commands.executeCommand("linyra.open");
    await until("the Log webview", (s) => s.readyCount >= 1 && s.repos.length === 3);
    // An earlier suite may have left the Log on its Uncommitted side (Show Uncommitted Changes).
    await send({ type: "logMode", mode: "commits" });
    await send({ type: "filter", filter: ALL });
  });

  const os = require("os") as typeof import("os");
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  const cp = require("child_process") as typeof import("child_process");
  const store = () => vscode.commands.executeCommand<{ pair: Pair | null; reading: boolean; rows: string[] }>("linyra._itest.compareStore");
  const pick = (p: Pair | null) => vscode.commands.executeCommand("linyra._itest.comparePick", p);
  const git = (root: string, args: string[], input?: string) => cp.execFileSync("git", args, { cwd: root, input, env: { ...process.env, ...ID } }).toString().trim();
  const ID = { GIT_AUTHOR_NAME: "dana", GIT_AUTHOR_EMAIL: "dana@example.com", GIT_COMMITTER_NAME: "dana", GIT_COMMITTER_EMAIL: "dana@example.com" };
  let n = 0;
  /** A commit on top of `parent` with these files, made without touching the working tree or the checked-out branch. */
  function commitOn(root: string, parent: string | null, files: Record<string, string>, message: string, time: number): string {
    const idx = path.join(os.tmpdir(), `linyra-itest-index-${process.pid}-${n++}`);
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
    // limit.go is new on both sides with different content: merging them would conflict there.
    assert.ok(s.rows.includes("acme-api ◀1 ▶1 =1 ⚠1"), s.rows.join(" | "));
    assert.ok(s.rows.includes("acme-web ◀1 ▶0 =0"));
    assert.ok(s.rows.includes("acme-libs identical"));
    // A branch one repository lacks.
    cp.spawnSync("git", ["update-ref", "-d", "refs/heads/prod"], { cwd: roots["acme-libs"] });
    await vscode.commands.executeCommand("linyra._itest.compareRefresh");
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
    await waitFor("acme-api back", async () => ((await store()).rows.includes("acme-api ◀1 ▶1 =1 ⚠1") ? true : undefined));
  });

  it("a name that is not a branch never reaches git", async () => {
    const before = (await snapshot()).spawnLog.length;
    await pick({ left: "-x", right: "prod" });
    await pick({ left: "a..b", right: "prod" });
    const after = await snapshot();
    assert.ok(!after.spawnLog.slice(before).some((x) => x.cmd === "rev-parse" || x.cmd === "cat-file"), "nothing resolved for a bad name");
  });

  type Repos = { open: boolean; description: string; message: string | undefined; pair: Pair | null; mode: string; roots: string[]; selected: string | undefined; accents: number[]; notes: string[] };
  type SideSnap = { open: boolean; title: string; description: string; message: string | undefined; tree: string[]; files: string[]; dimmed: string[]; conflicts: string[] };
  const repos = () => vscode.commands.executeCommand<Repos>("linyra._itest.compare");
  const sideOf = (s: "left" | "right") => vscode.commands.executeCommand<SideSnap>("linyra._itest.compareSide", s);
  const viewPick = (p: Pair) => vscode.commands.executeCommand("linyra._itest.compareView", p);
  const select = (id: string) => vscode.commands.executeCommand("linyra._itest.compareSelect", id);
  const until2 = <T>(what: string, get: () => Thenable<T>, ok: (x: T) => boolean) =>
    waitFor(what, async () => {
      const x = await get();
      return ok(x) ? x : undefined;
    });
  const tabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).length;

  it("colors each listed repository as the Log does, though Compare lists only some of them", async () => {
    // A fourth repository with neither branch: Compare leaves it out, the Log does not. With it,
    // hues assigned over only the listed repositories give acme-web another color than the Log's.
    const mobile = path.join(path.dirname(roots["acme-web"]), "acme-mobile");
    fs.mkdirSync(mobile, { recursive: true });
    git(mobile, ["init", "-q"]);
    git(mobile, ["update-ref", "HEAD", commitOn(mobile, null, { "app.json": "{}\n" }, "feat: scaffold mobile", T)]);
    const folders = (change: () => boolean) => new Promise<void>((resolve, reject) => {
      const d = vscode.workspace.onDidChangeWorkspaceFolders(() => { d.dispose(); resolve(); });
      if (!change()) { d.dispose(); reject(new Error("workspace folders not changed")); }
    });
    await folders(() => vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri: vscode.Uri.file(mobile) }));
    try {
      await send({ type: "refresh" });
      const all = (await until("four repositories", (s) => s.repos.length === 4)).repos;
      await viewPick({ left: "release-1.4", right: "prod" });
      await vscode.commands.executeCommand("linyra.compareBranches");
      const r = await until2("listed without acme-mobile", repos, (x) => x.open && x.roots.length === 2 && x.selected !== undefined);
      assert.deepStrictEqual(r.roots, ["acme-api", "acme-web"]);
      const { accentOf, assignAccents } = require("../webview/view") as typeof import("../webview/view");
      const log = assignAccents(all), listed = assignAccents(all.filter((x) => x.name !== "acme-mobile" && x.name !== "acme-libs"));
      assert.notDeepStrictEqual(["acme-api", "acme-web"].map((n) => accentOf(log, roots[n])), ["acme-api", "acme-web"].map((n) => accentOf(listed, roots[n])),
        "the fixture tells the two assignments apart");
      assert.deepStrictEqual(r.accents, ["acme-api", "acme-web"].map((n) => accentOf(log, roots[n])), "the Log's colors");
      // Beyond eight repositories the Log separates neighbors and reports the hues it shows: Compare follows.
      const { ACCENT_COUNT } = require("../webview/view") as typeof import("../webview/view");
      const moved = (accentOf(log, roots["acme-web"]) + 3) % ACCENT_COUNT;
      await send({ type: "accents", accents: { [roots["acme-web"]]: moved } });
      await until2("Compare follows the Log's reported color", repos, (x) => x.accents[1] === moved);
      await send({ type: "accents", accents: Object.fromEntries(log) });
      await until2("and back", repos, (x) => x.accents[1] === accentOf(log, roots["acme-web"]));
    } finally {
      const at = vscode.workspace.workspaceFolders?.findIndex((f) => f.uri.fsPath === vscode.Uri.file(mobile).fsPath) ?? -1;
      if (at >= 0) await folders(() => vscode.workspace.updateWorkspaceFolders(at, 1));
      await send({ type: "refresh" });
      await until("three repositories again", (s) => s.repos.length === 3);
      // Windows may still hold the folder; it is inside the temporary home, removed after the run.
      try { fs.rmSync(mobile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* removed with the home */ }
    }
  });

  it("the Linyra Compare tab: Repositories with counts; selecting one fills both sides", async () => {
    await viewPick({ left: "release-1.4", right: "prod" });
    await vscode.commands.executeCommand("linyra.compareBranches");
    // Rows come from the store as repositories answer; the selection follows a moment later (the
    // store's change event is throttled), so wait for it to settle on the first listed one.
    const r = await until2("the first listed repository selected", repos, (x) => x.open && x.roots.length === 2 && x.selected === roots["acme-api"]);
    assert.strictEqual(r.description, "release-1.4 ↔ prod");
    assert.deepStrictEqual(r.roots, ["acme-api", "acme-web"], "names only: commit counts mislead when changes travel by cherry-pick (they are in the tooltip)");
    assert.strictEqual(r.selected, roots["acme-api"], "the first listed repository is selected");
    // Like the Log's Repo List: each repository's own color, as a dot.
    const { accentOf, assignAccents } = require("../webview/view") as typeof import("../webview/view");
    const accents = assignAccents((await snapshot()).repos);
    assert.deepStrictEqual(r.accents, ["acme-api", "acme-web"].map((n) => accentOf(accents, roots[n])));
    const pkg = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON.contributes;
    const views = pkg.views as Record<string, { id: string; icon?: string; type?: string }[]>;
    assert.deepStrictEqual(pkg.viewsContainers, {
      panel: [{ id: "linyra", title: "Linyra", icon: "media/linyra.svg" }, { id: "linyra-compare", title: "Linyra Compare", icon: "media/compare.svg" }],
      activitybar: [{ id: "linyra-side", title: "Linyra", icon: "media/linyra.svg" }],
    }, "the Log and Compare in the panel, the Commit side bar on the left");
    assert.deepStrictEqual(Object.fromEntries(Object.entries(views).map(([c, vs]) => [c, vs.map((v) => [v.id, v.icon])])), {
      linyra: [["linyra.log", "$(history)"]],
      "linyra-compare": [["linyra.compare", "$(repo)"]],
      "linyra-side": [["linyra.commit", "$(git-commit)"], ["linyra.commitMessage", "$(edit)"]],
    }, "one native surface per panel container prevents accidental header collapsing; the side bar stacks the Commit tree over its message");
    assert.strictEqual(views["linyra-compare"][0].type, "webview", "the unified comparison retains repositories and both sides");
    const menus = pkg.menus["webview/context"] as { command: string; when: string }[];
    for (const c of ["linyra.repoPull", "linyra.repoShowOnly", "linyra.repoHide", "linyra.repoOpenFolder", "linyra.repoCopyPath"]) {
      assert.ok(menus.some((m) => m.command === c && m.when.includes("webviewId == 'linyra.compare'")), `${c} on a Compare repository row`);
    }
    // The page's Branch boxes and rows: a pick and a click reach the host.
    const rsend = (m: import("../compareProtocol").ReposWebview) => vscode.commands.executeCommand("linyra._itest.compareReposSend", m);
    await rsend({ type: "pick", pair: { left: "prod", right: "release-1.4" } });
    await until2("picked in the page", repos, (x) => x.description === "prod ↔ release-1.4" && x.roots.length === 2);
    await rsend({ type: "pick", pair: { left: "release-1.4", right: "prod" } });
    await until2("picked back", repos, (x) => x.description === "release-1.4 ↔ prod" && x.roots.length === 2);
    await rsend({ type: "select", repoId: roots["acme-web"] });
    await until2("row clicked", repos, (x) => x.selected === roots["acme-web"]);
    await rsend({ type: "select", repoId: roots["acme-api"] });
    // The files come first; the merge check lands on them a moment later.
    const left = await until2("left side", () => sideOf("left"), (x) => x.tree.length > 0 && x.conflicts.length > 0);
    assert.strictEqual(left.title, "release-1.4 only");
    // retry.go, cherry-picked to both: the same at both tips now, so hidden by default; limit.go still differs.
    assert.strictEqual(left.description, "acme-api · 1 file · 1 already on both (hidden)");
    assert.deepStrictEqual(left.tree, ["limit.go | +1 −0 · conflict"]);
    assert.deepStrictEqual(left.conflicts, ["limit.go"], "a merge of the two would leave limit.go conflicted");
    const right = await until2("right side", () => sideOf("right"), (x) => x.tree.length > 0 && x.conflicts.length > 0);
    assert.strictEqual(right.title, "prod only");
    assert.deepStrictEqual(right.tree, ["limit.go | +1 −0 · conflict", "timeout.go | +1 −0"]);
    // Show Files Already on Both: listed again, dimmed; Hide puts it back.
    await vscode.commands.executeCommand("linyra.compareShowSame");
    try {
      const shown = await until2("left with retry.go", () => sideOf("left"), (x) => x.tree.length === 2);
      assert.strictEqual(shown.description, "acme-api · 2 files");
      assert.deepStrictEqual(shown.tree, ["limit.go | +1 −0 · conflict", "retry.go | +1 −0 · already on both"]);
      assert.deepStrictEqual(shown.dimmed, ["retry.go"]);
      const rshown = await until2("right with retry.go", () => sideOf("right"), (x) => x.tree.length === 3);
      assert.deepStrictEqual(rshown.dimmed, ["retry.go"]);
    } finally {
      await vscode.commands.executeCommand("linyra.compareHideSame");
    }
    await until2("left hides it again", () => sideOf("left"), (x) => x.tree.length === 1);
    await vscode.commands.executeCommand("linyra.compareOpenFile", { side: "right", repoId: roots["acme-api"], path: "timeout.go" });
    const tab = await waitFor("a diff", () => {
      const t = vscode.window.tabGroups.activeTabGroup.activeTab;
      return t?.input instanceof vscode.TabInputTextDiff ? t.input : undefined;
    });
    // A click follows the branch boxes: release-1.4 on the left, prod on the right.
    assert.strictEqual((await vscode.workspace.openTextDocument(tab.original)).getText(), "", "release-1.4 does not have timeout.go");
    assert.strictEqual((await vscode.workspace.openTextDocument(tab.modified)).getText(), "package timeout\n", "prod has timeout.go");
    assert.match(vscode.window.tabGroups.activeTabGroup.activeTab!.label, /\(release-1\.4 ↔ prod\)/);
    // limit.go, changed on both sides: both halves in one diff.
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("linyra.compareOpenFile", { side: "left", repoId: roots["acme-api"], path: "limit.go" });
    const both = await waitFor("limit.go between branches", () => {
      const t = vscode.window.tabGroups.activeTabGroup.activeTab;
      return t?.input instanceof vscode.TabInputTextDiff ? t.input : undefined;
    });
    assert.strictEqual((await vscode.workspace.openTextDocument(both.original)).getText(), "package limit\n");
    assert.strictEqual((await vscode.workspace.openTextDocument(both.modified)).getText(), "package limit // prod\n");
    // Right-click → Changes since the split: merge base ↔ that side (what the merge brings).
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("linyra.compareOpenSinceSplit", { side: "right", repoId: roots["acme-api"], path: "timeout.go" });
    const since = await waitFor("since the split", () => {
      const t = vscode.window.tabGroups.activeTabGroup.activeTab;
      return t?.input instanceof vscode.TabInputTextDiff ? t.input : undefined;
    });
    assert.strictEqual((await vscode.workspace.openTextDocument(since.original)).getText(), "");
    assert.strictEqual((await vscode.workspace.openTextDocument(since.modified)).getText(), "package timeout\n");
    const items = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON.contributes.menus["view/item/context"] as { command: string; when: string }[];
    assert.ok(items.some((m) => m.command === "linyra.compareOpenSinceSplit" && m.when.includes("viewItem =~ /^compareFile/")));
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    // Another repository: both sides follow; a file of the old one no longer opens.
    await select(roots["acme-web"]);
    await until2("acme-web left", () => sideOf("left"), (x) => x.tree.join() === "billing.ts | +1 −0");
    assert.strictEqual((await sideOf("right")).message, "No changes on this side.");
    // A click from acme-api's tree, landing after the selection moved: billing.ts is acme-web's, not acme-api's.
    const before = tabs();
    await vscode.commands.executeCommand("linyra.compareOpenFile", { side: "left", repoId: roots["acme-api"], path: "billing.ts" });
    await sleep(300);
    assert.strictEqual(tabs(), before, "a file opens only from the repository whose files are shown");
  });

  it("unified comparison retains side context actions, mode switching, layout memory and forged-row guards", async () => {
    type SideWithRows = { presentation?: import("../compareProtocol").CompareSidePage; tree: string[]; open: boolean };
    const current = (side: "left" | "right") => vscode.commands.executeCommand<SideWithRows>("linyra._itest.compareSide", side);
    const rsend = (message: import("../compareProtocol").ReposWebview) => vscode.commands.executeCommand("linyra._itest.compareReposSend", message);
    await viewPick({ left: "release-1.4", right: "prod" });
    await vscode.commands.executeCommand("linyra.compareShowFiles");
    await vscode.commands.executeCommand("linyra.compareHideSame");
    await vscode.commands.executeCommand("linyra.compareLeft.focus");
    await vscode.commands.executeCommand("linyra.compareRight.focus");
    await select(roots["acme-api"]);
    const files = await until2("left tree serialized for its webview", () => current("left"), (side) => !!side.presentation?.rows.some((row) => row.label === "limit.go"));
    const row = files.presentation!.rows.find((row) => row.label === "limit.go")!;
    const context = { compareSide: "left", compareNodeId: row.id };
    await vscode.commands.executeCommand("linyra.copyRelativePath", context);
    assert.strictEqual(await vscode.commands.executeCommand<string>("linyra._itest.clipboard"), "limit.go");
    await vscode.commands.executeCommand("linyra.copyRelativePath", { compareSide: "left", compareNodeId: "forged", kind: "file", repoId: roots["acme-api"], path: "secret.txt" });
    assert.strictEqual(await vscode.commands.executeCommand<string>("linyra._itest.clipboard"), "limit.go", "the host ignores forged row fields");
    await closeEditors();
    await rsend({ type: "sideOpen", side: "left", id: row.id });
    await diffTab();
    await closeEditors();
    await vscode.commands.executeCommand("linyra.compareOpenSinceSplit", context);
    await diffTab();
    await closeEditors();
    await rsend({ type: "mode", mode: "commits" });
    const commits = await until2("commit rows serialized", () => current("left"), (side) => !!side.presentation?.rows.some((item) => item.kind === "commit"));
    const commit = commits.presentation!.rows.find((item) => item.kind === "commit")!;
    await vscode.commands.executeCommand("linyra.commitCopySha", { compareSide: "left", compareNodeId: commit.id });
    assert.ok(/^[a-f\d]{40}$/.test(await vscode.commands.executeCommand<string>("linyra._itest.clipboard")));
    await rsend({ type: "sideExpand", side: "left", id: commit.id });
    await rsend({ type: "sideExpandAll", side: "left" });
    assert.ok((await current("left")).tree.some((line) => line.startsWith("  ")), "commit expansion retains file children");
    const layout = { repositoriesWidth: 260, leftWidth: 420, leftHeight: 160, sidesHeight: 290, orientation: "stacked" as const };
    await rsend({ type: "layout", layout });
    await rsend({ type: "ready" });
    const posted = await vscode.commands.executeCommand<{ state?: { layout?: typeof layout } }>("linyra._itest.comparePosted");
    assert.deepStrictEqual(posted.state?.layout, layout);
    await rsend({ type: "layout", layout: { ...layout, orientation: "auto" } });
    await rsend({ type: "sideVisibility", side: "left", show: false });
    assert.strictEqual((await current("left")).open, false);
    assert.strictEqual((await current("right")).open, true);
    await rsend({ type: "sideVisibility", side: "left", show: true });
    await rsend({ type: "mode", mode: "files" });
    await until2("files mode restored", () => current("left"), (side) => side.tree.some((line) => line.startsWith("limit.go")));
  });

  it("Repositories says what it knows: nothing before the read, 'the same files' only once it is done, ticks followed", async () => {
    type Posted = { repos?: { empty?: string; message?: string; rows: unknown[] } };
    const posted = () => vscode.commands.executeCommand<Posted>("linyra._itest.comparePosted");
    await viewPick({ left: "release-1.4", right: "release-1.4" });
    await vscode.commands.executeCommand("linyra.compareShow");
    await until2("same names", repos, (x) => x.message?.startsWith("Pick two different") === true);
    // Not yet read: no claim.
    await vscode.commands.executeCommand("linyra._itest.compareView", { left: "release-1.4", right: "prod" });
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
    const posted = () => vscode.commands.executeCommand<Posted>("linyra._itest.comparePosted");
    const rsend = (m: import("../compareProtocol").ReposWebview) => vscode.commands.executeCommand("linyra._itest.compareReposSend", m);
    await viewPick({ left: "release-1.4", right: "prod" });
    await vscode.commands.executeCommand("linyra.compareShow");
    await until2("listed", repos, (x) => x.open && x.roots.length === 2);
    // Hide and show again: each ticked repository's branches are resolved once, not twice.
    await vscode.commands.executeCommand("workbench.action.terminal.toggleTerminal");
    await until2("hidden", repos, (x) => !x.open);
    const before = (await snapshot()).spawnLog.length;
    await vscode.commands.executeCommand("linyra.compareShow");
    await until2("read again", repos, (x) => x.open && x.roots.length === 2);
    await sleep(300);
    const log = (await snapshot()).spawnLog.slice(before);
    const ticked = (await snapshot()).repos.length;
    assert.strictEqual(log.filter((x) => x.cmd === "cat-file").length, ticked, "every name of the pair resolved in one git process per repository");
    // While the list was being read, the selection moved on its own: the sides read once, for the final one.
    assert.ok(log.filter((x) => x.cmd === "diff").length <= 3, `side reads wait for the list (${log.filter((x) => x.cmd === "diff").length} diffs)`);
    // A half pair from the page: the host keeps it and its guidance.
    await rsend({ type: "pending", pair: { left: "release-1.4", right: "" } });
    await waitFor("guidance", async () => ((await posted()).repos?.message === "Pick the branch release-1.4 goes into (▶)." ? true : undefined));
    assert.strictEqual((await sideOf("left")).tree.length, 0, "the old pair's files leave the sides");
    await rsend({ type: "pick", pair: { left: "release-1.4", right: "prod" } });
    await until2("picked", repos, (x) => x.roots.length === 2);
    const pkg = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON;
    assert.ok(!JSON.stringify(pkg.contributes.menus).includes("linyra.comparePair"));
  });

  it("the picked repository survives a panel tab switch; duplicates are always answered", async () => {
    type Posted = { dups?: { repoId: string; items: unknown[] } };
    const posted = () => vscode.commands.executeCommand<Posted>("linyra._itest.comparePosted");
    const rsend = (m: import("../compareProtocol").ReposWebview) => vscode.commands.executeCommand("linyra._itest.compareReposSend", m);
    await viewPick({ left: "release-1.4", right: "prod" });
    await vscode.commands.executeCommand("linyra.compareShow");
    await until2("listed", repos, (x) => x.open && x.roots.length === 2);
    await rsend({ type: "select", repoId: roots["acme-web"] });
    await until2("acme-web picked", repos, (x) => x.selected === roots["acme-web"]);
    await vscode.commands.executeCommand("workbench.action.terminal.toggleTerminal");
    await until2("tab hidden", repos, (x) => !x.open);
    await vscode.commands.executeCommand("linyra.compareShow");
    await until2("back, read again", repos, (x) => x.open && x.roots.length === 2);
    await until2("still acme-web, not the first row", repos, (x) => x.selected === roots["acme-web"]);
    // A repository with no result (or a read that fails): the page still gets an answer.
    await rsend({ type: "wantDups", repoId: "/nowhere" });
    assert.deepStrictEqual((await posted()).dups, { type: "dups", repoId: "/nowhere", items: [] });
  });

  it("the active file diff follows branch picks and swaps without another file click", async () => {
    const api = roots["acme-api"];
    await viewPick({ left: "release-1.4", right: "prod" });
    await vscode.commands.executeCommand("linyra.compareShow");
    await until2("listed", repos, (x) => x.open && x.roots.length === 2);
    await select(api);
    await until2("timeout.go listed", () => sideOf("right"), (x) => x.tree.some((l) => l.startsWith("timeout.go")));
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("linyra.compareOpenFile", { side: "right", repoId: api, path: "timeout.go" });
    const check = async (left: string, right: string, original: string, modified: string) => {
      const tab = await waitFor("diff matches the branch boxes", () => {
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        return input instanceof vscode.TabInputTextDiff && JSON.parse(input.original.query).ref === git(api, ["rev-parse", left]) && JSON.parse(input.modified.query).ref === git(api, ["rev-parse", right]) ? input : undefined;
      });
      assert.strictEqual((await vscode.workspace.openTextDocument(tab.original)).getText(), original);
      assert.strictEqual((await vscode.workspace.openTextDocument(tab.modified)).getText(), modified);
      assert.ok(vscode.window.tabGroups.activeTabGroup.activeTab!.label.includes(`(${left} ↔ ${right})`));
    };
    await check("release-1.4", "prod", "", "package timeout\n");
    // The same message as choosing the branches in the webview.
    await vscode.commands.executeCommand("linyra._itest.compareReposSend", { type: "pick", pair: { left: "prod", right: "release-1.4" } });
    await check("prod", "release-1.4", "package timeout\n", "");
    await vscode.commands.executeCommand("linyra.compareSwap");
    await check("release-1.4", "prod", "", "package timeout\n");
    // Choosing a different pair also updates the active file when the tips are identical.
    git(api, ["update-ref", "refs/heads/follow-same", "prod"]);
    try {
      await vscode.commands.executeCommand("linyra._itest.compareReposSend", { type: "pick", pair: { left: "prod", right: "follow-same" } });
      await check("prod", "follow-same", "package timeout\n", "package timeout\n");
    } finally {
      cp.spawnSync("git", ["update-ref", "-d", "refs/heads/follow-same"], { cwd: api });
    }
    const other = await vscode.workspace.openTextDocument({ content: "keep this editor active" });
    await vscode.window.showTextDocument(other);
    await vscode.commands.executeCommand("linyra.compareSwap");
    assert.strictEqual(vscode.window.activeTextEditor?.document.uri.toString(), other.uri.toString());
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  it("after Refresh, a file in Left or Right still opens its diff", async () => {
    await viewPick({ left: "release-1.4", right: "prod" });
    await vscode.commands.executeCommand("linyra.compareShow");
    await until2("listed", repos, (x) => x.open && x.roots.length === 2);
    await select(roots["acme-api"]);
    await until2("api right", () => sideOf("right"), (x) => x.tree.some((l) => l.startsWith("timeout.go")));
    await vscode.commands.executeCommand("linyra.compareRefresh");
    await sleep(400);
    // No snapshot in between: it would read the side again and hide the bug.
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("linyra.compareOpenFile", { side: "right", repoId: roots["acme-api"], path: "timeout.go" });
    await waitFor("a diff after Refresh", () => (vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff ? true : undefined), 3000);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  it("the Linyra Compare tab is hidden until Compare Branches is clicked, and × hides it again", async () => {
    const pkg = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON.contributes;
    for (const v of pkg.views["linyra-compare"] as { id: string; when?: string }[]) assert.strictEqual(v.when, "linyra.compareShown", `${v.id} is hidden by default`);
    assert.ok((pkg.menus["view/title"] as { command: string; when: string }[]).some((m) => m.command === "linyra.compareClose" && m.when.includes("view == linyra.compare")));
    await vscode.commands.executeCommand("linyra.compareClose");
    await until2("hidden", repos, (x) => !x.open);
    await vscode.commands.executeCommand("linyra.compareBranches");
    await until2("shown again", repos, (x) => x.open && x.roots.length === 2);
  });

  it("uncommitted work in the Commit side bar, and Show Uncommitted Changes opens the Log's Uncommitted side", async () => {
    const pkg = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON.contributes;
    assert.ok(!("when" in pkg.views["linyra-side"][0]), "the side bar is always there (VS Code's own menu hides it)");
    // The remembered Compare tab needs its context key after a reload, before any Linyra view opens.
    assert.ok((vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON.activationEvents as string[]).includes("onStartupFinished"));
    await vscode.commands.executeCommand("linyra.focusUncommitted");
    await waitFor("the Log on its Uncommitted side", async () => ((await vscode.commands.executeCommand<{ logMode: string }>("linyra._itest.snapshot")).logMode === "uncommitted" ? true : undefined));
    await vscode.commands.executeCommand("linyra._itest.send", { type: "logMode", mode: "commits" });
    await waitFor("back on Commits", async () => ((await vscode.commands.executeCommand<{ logMode: string }>("linyra._itest.snapshot")).logMode === "commits" ? true : undefined));
  });

  it("the Log toolbar's Compare toggle: click to show, click again to hide; the icon says which", async () => {
    const pkg = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON.contributes;
    const icon = (cmd: string) => (pkg.commands as { command: string; icon?: string }[]).find((c) => c.command === cmd)?.icon;
    const { renderHtml } = require("../webview/html") as typeof import("../webview/html");
    const shell = renderHtml({ cspSource: "", nonce: "test", scriptUri: "", styleUri: "" });
    assert.strictEqual((shell.match(/id="toolbar-compare"/g) ?? []).length, 1);
    // The header's Uncommitted tab is the one entry for uncommitted work.
    assert.ok(!shell.includes('id="toolbar-uncommitted"') && !shell.includes('id="layout-sideBySide"'), "no second entry for the same thing");
    assert.deepStrictEqual([icon("linyra.compareShow"), icon("linyra.compareHide")], ["$(git-compare)", "$(git-compare)"]);
    await vscode.commands.executeCommand("linyra.compareShow");
    await until2("compare shown", repos, (x) => x.open);
    await vscode.commands.executeCommand("linyra.compareHide");
    await until2("compare hidden", repos, (x) => !x.open);
    await vscode.commands.executeCommand("linyra.compareShow");
    await until2("compare shown again", repos, (x) => x.open);
  });

  it("Commits mode, swap, a new pair, and hiding the tab mid-read", async () => {
    await select(roots["acme-api"]);
    await vscode.commands.executeCommand("linyra._itest.compareMode", "commits");
    let left = await until2("commits", () => sideOf("left"), (x) => x.tree.some((l) => l.startsWith("feat: rate limit")));
    assert.strictEqual(left.description, "acme-api · 1 commit");
    assert.deepStrictEqual(left.tree.map((l) => l.replace(/ · .*$/, "")), ["feat: rate limit per client | dana", "  limit.go | +1 −0"]);
    await vscode.commands.executeCommand("linyra.compareSwap");
    left = await until2("swapped", () => sideOf("left"), (x) => x.title === "prod only" && x.tree[0]?.startsWith("hotfix") === true);
    assert.ok((await repos()).roots.includes("acme-web"));
    await vscode.commands.executeCommand("linyra._itest.compareMode", "files");
    // A new pair: the old pair's files are gone at once.
    await viewPick({ left: "prod", right: "prod" });
    const same = await until2("same", repos, (x) => x.message?.startsWith("Pick two different") === true);
    assert.strictEqual(same.message, "Pick two different branches. Both sides are prod.");
    assert.deepStrictEqual((await sideOf("left")).tree, []);
    // Hide while a read runs: nothing throws; showing it reads again.
    void viewPick({ left: "release-1.4", right: "prod" });
    await vscode.commands.executeCommand("workbench.action.closePanel");
    await until2("hidden", repos, (x) => !x.open);
    await vscode.commands.executeCommand("linyra.compareBranches");
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
      await vscode.commands.executeCommand("linyra.fetchAll");
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
    for (let i = 0; i < 4; i++) void vscode.commands.executeCommand("linyra._itest.compareRefresh");
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
    const idx = path.join(os.tmpdir(), `linyra-ren-${process.pid}.index`);
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
      await vscode.commands.executeCommand("linyra.compareOpenFile", { side: "left", repoId: api, path: "rate.go" });
      const tab = await waitFor("a diff", () => {
        const t = vscode.window.tabGroups.activeTabGroup.activeTab;
        return t?.input instanceof vscode.TabInputTextDiff ? t.input : undefined;
      });
      assert.strictEqual((await vscode.workspace.openTextDocument(tab.original)).getText(), "package limit\n");
      assert.strictEqual((await vscode.workspace.openTextDocument(tab.modified)).getText(), "package limit\n");
      assert.strictEqual(tab.original.path, "/rate.go", "the left branch has the renamed path");
      assert.strictEqual(tab.modified.path, "/limit.go", "the right branch still has the old path");
      await vscode.commands.executeCommand("linyra.compareSwap");
      const swapped = await waitFor("renamed diff follows swap", () => {
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        return input instanceof vscode.TabInputTextDiff && input.original.path === "/limit.go" && input.modified.path === "/rate.go" ? input : undefined;
      });
      assert.strictEqual((await vscode.workspace.openTextDocument(swapped.original)).getText(), "package limit\n");
      assert.strictEqual((await vscode.workspace.openTextDocument(swapped.modified)).getText(), "package limit\n");
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
    await vscode.commands.executeCommand("linyra.compareLeft.removeView");
    await until2("left hidden", () => sideOf("left"), (x) => !x.open);
    const before = (await snapshot()).spawnLog.length;
    await select(roots["acme-web"]);
    await sleep(400);
    const diffs = (await snapshot()).spawnLog.slice(before).filter((x) => x.cmd === "diff").length;
    // readFiles runs both sides' diffs and the tips' in one call: 3 spawns for one side reading, 6 if both read.
    assert.strictEqual(diffs, 3, "only the shown (right) side read its files");
    await vscode.commands.executeCommand("linyra.compareLeft.focus");
    await until2("left shown and read", () => sideOf("left"), (x) => x.open && x.tree.join() === "billing.ts | +1 −0");
  });

  it("a swap while the list is still being read reads what it lacks", async () => {
    const p = pick({ left: "release-1.4", right: "prod" });
    await vscode.commands.executeCommand("linyra._itest.compareSwap");
    await p;
    const s = await waitFor("all rows after the swap", async () => {
      const x = await store();
      return !x.reading && x.rows.length === 3 ? x : undefined;
    });
    assert.ok(s.rows.includes("acme-web ◀0 ▶1 =0"), s.rows.join(" | "));
  });

  it("a side may list several names: each repository uses the first it has, and its row says which", async () => {
    const api = roots["acme-api"];
    // Only acme-api has release-1.5 (release-1.4's tip): the others fall back to release-1.4.
    git(api, ["update-ref", "refs/heads/release-1.5", "refs/heads/release-1.4"]);
    try {
      await pick({ left: "release-1.5 release-1.4", right: "nope prod" });
      const s = await waitFor("all read", async () => {
        const x = await store();
        return !x.reading && x.rows.length === 3 ? x : undefined;
      });
      assert.deepStrictEqual([...s.rows].sort(), ["acme-api ◀1 ▶1 =1 ⚠1", "acme-libs identical", "acme-web ◀1 ▶0 =0"], "the same answers as release-1.4 ↔ prod");
      await viewPick({ left: "release-1.5 release-1.4", right: "nope prod" });
      await vscode.commands.executeCommand("linyra.compareShow");
      // The merge checks land after the rows: wait for both notes.
      const r = await until2("rows with their names", repos, (x) => x.notes.length === 2 && x.notes.every((n) => /conflicted|cleanly/.test(n)));
      assert.deepStrictEqual(r.notes, ["acme-api | release-1.5 → prod | 1 conflicted file", "acme-web | release-1.4 → prod | merges cleanly"]);
      assert.strictEqual(r.description, "release-1.5, release-1.4 ↔ nope, prod");
      await select(roots["acme-web"]);
      const left = await until2("acme-web's own name", () => sideOf("left"), (x) => x.tree.length > 0);
      assert.strictEqual(left.title, "release-1.4 only", "the side says the name this repository uses");
    } finally {
      git(api, ["update-ref", "-d", "refs/heads/release-1.5"]);
    }
  });

  it("the merge check writes nothing to the repository; Only Conflicts and Preview Merge Result show the conflict", async () => {
    const api = roots["acme-api"];
    const objects = () => git(api, ["count-objects", "-v"]).split("\n").filter((l) => /^(count|size|in-pack|packs):/.test(l)).join(", ");
    const before = objects();
    await pick({ left: "release-1.4", right: "prod" });
    await waitFor("read", async () => ((await store()).rows.includes("acme-api ◀1 ▶1 =1 ⚠1") ? true : undefined));
    assert.strictEqual(objects(), before, "merge-tree's objects went to a scratch directory, not the repository");
    await viewPick({ left: "release-1.4", right: "prod" });
    await vscode.commands.executeCommand("linyra.compareShow");
    await until2("listed", repos, (x) => x.roots.length === 2);
    await select(api);
    await until2("right side", () => sideOf("right"), (x) => x.tree.length === 2);
    await until2("left side", () => sideOf("left"), (x) => x.tree.length === 1);
    await vscode.commands.executeCommand("linyra.compareOnlyConflicts");
    try {
      const only = await until2("only the conflict", () => sideOf("right"), (x) => x.tree.length === 1);
      assert.deepStrictEqual(only.tree, ["limit.go | +1 −0 · conflict"]);
    } finally {
      await vscode.commands.executeCommand("linyra.compareAllConflicts");
    }
    await until2("every file again", () => sideOf("right"), (x) => x.tree.length === 2);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("linyra.compareMergePreview", { side: "left", repoId: api, path: "limit.go" });
    const preview = await waitFor("the merge preview", () => {
      const t = vscode.window.tabGroups.activeTabGroup.activeTab;
      return t?.input instanceof vscode.TabInputTextDiff ? t : undefined;
    });
    const input = preview.input as vscode.TabInputTextDiff;
    assert.strictEqual((await vscode.workspace.openTextDocument(input.original)).getText(), "package limit // prod\n", "▶ as it is now");
    assert.match((await vscode.workspace.openTextDocument(input.modified)).getText(), /^<<<<<<< [^\n]*\n[\s\S]*=======\n[\s\S]*>>>>>>> /m, "the merged file, with its conflict markers");
    assert.match(preview.label, /^limit\.go \(prod ↔ merged with release-1\.4\) — acme-api$/);
    assert.strictEqual(objects(), before, "nor does the preview");
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  it("All repositories: one tree; Copy as Release Notes; Cherry-Pick from a side; Merge ◀ into ▶ only where it is clean and ▶ is checked out", async () => {
    const api = roots["acme-api"], web = roots["acme-web"];
    const heads = { api: git(api, ["rev-parse", "HEAD"]), web: git(web, ["rev-parse", "HEAD"]) };
    try {
      await viewPick({ left: "release-1.4", right: "prod" });
      await vscode.commands.executeCommand("linyra.compareShow");
      await until2("listed", repos, (x) => x.roots.length === 2);
      await select("*");
      await until2("All repositories", repos, (x) => x.selected === "*");
      const all = await until2("every repository's files", () => sideOf("left"), (x) => x.tree.length === 4 && x.conflicts.length === 1);
      assert.deepStrictEqual(all.tree, ["acme-api | 1", "  limit.go | +1 −0 · conflict", "acme-web | 1", "  billing.ts | +1 −0"]);
      assert.strictEqual(all.description, "2 repositories · 2 files · 1 already on both (hidden)");
      // Several picked (Ctrl/Shift-click): the same tree, for just those.
      await select(`+${web}\n${api}`);
      const picked = await until2("two picked", repos, (x) => x.selected?.startsWith("+") === true);
      assert.strictEqual(picked.selected, `+${api}\n${web}`, "in Repo List order");
      await until2("both picked, in one tree", () => sideOf("left"), (x) => x.tree.join() === all.tree.join());
      await select("*");
      // Release notes: each repository's commits only on ◀ (the cherry-picked one is on both: left out).
      const notes = await vscode.commands.executeCommand<string>("linyra.compareReleaseNotes");
      assert.strictEqual(notes, "## acme-api (release-1.4 → prod)\n\n- feat: rate limit per client (" + git(api, ["rev-parse", "--short=7", "release-1.4~1"]) + ", dana)\n\n"
        + "## acme-web (release-1.4 → prod)\n\n- feat: billing page (" + git(web, ["rev-parse", "--short=7", "release-1.4"]) + ", dana)\n");
      assert.strictEqual(await vscode.commands.executeCommand("linyra._itest.clipboard"), notes, "copied");
      // Cherry-Pick from Commits: acme-web's billing page onto its checked-out branch.
      await select(web);
      await vscode.commands.executeCommand("linyra._itest.compareMode", "commits");
      const billing = git(web, ["rev-parse", "release-1.4"]);
      await until2("acme-web's commit", () => sideOf("left"), (x) => x.tree.some((l) => l.startsWith("feat: billing page")));
      await vscode.commands.executeCommand("linyra.compareCherryPick", { compareSide: "left", compareNodeId: `${web}/left/c:${billing}` });
      assert.strictEqual(git(web, ["log", "-1", "--format=%s"]), "feat: billing page");
      assert.strictEqual(git(web, ["rev-parse", "HEAD~1"]), heads.web, "on the checked-out branch");
      git(web, ["reset", "-q", "--hard", heads.web]);
      await vscode.commands.executeCommand("linyra._itest.compareMode", "files");
      // Merge ◀ into ▶ goes into ▶ as the boxes say, checked out or not. prod is checked out nowhere (main
      // is): acme-api would conflict, so only acme-web is offered, and its prod moves without a checkout.
      const prodWas = git(web, ["rev-parse", "refs/heads/prod"]);
      const status = git(web, ["status", "--porcelain"]);
      await vscode.commands.executeCommand("linyra._itest.answer", JSON.stringify(["acme-web"]));
      await vscode.commands.executeCommand("linyra.compareMerge");
      assert.strictEqual(git(web, ["rev-parse", "refs/heads/prod"]), git(web, ["rev-parse", "release-1.4"]), "prod was behind: fast-forwarded");
      assert.deepStrictEqual([git(api, ["rev-parse", "HEAD"]), git(web, ["rev-parse", "HEAD"]), git(web, ["status", "--porcelain"])], [heads.api, heads.web, status], "nothing checked out, the working tree untouched");
      // prod with its own commit: a merge commit, made without a checkout.
      const prodOwn = commitOn(web, prodWas, { "prod.txt": "prod\n" }, "chore: prod only", T + 90);
      git(web, ["update-ref", "refs/heads/prod", prodOwn]);
      await viewPick({ left: "release-1.4", right: "main" });
      await until2("another pair", repos, (x) => x.description === "release-1.4 ↔ main");
      await viewPick({ left: "release-1.4", right: "prod" });
      await until2("prod read again", repos, (x) => x.description === "release-1.4 ↔ prod" && x.roots.length === 2);
      await waitFor("acme-web's new prod", async () => ((await store()).rows.includes("acme-web ◀1 ▶1 =0") ? true : undefined));
      await vscode.commands.executeCommand("linyra._itest.answer", JSON.stringify(["acme-web"]));
      await vscode.commands.executeCommand("linyra.compareMerge");
      const merge = git(web, ["rev-parse", "refs/heads/prod"]);
      assert.deepStrictEqual(git(web, ["rev-list", "--parents", "-1", merge]).split(" ").slice(1), [prodOwn, git(web, ["rev-parse", "release-1.4"])], "a merge commit: prod, then release-1.4");
      assert.strictEqual(git(web, ["log", "-1", "--format=%s", merge]), "Merge branch 'release-1.4' into prod");
      assert.deepStrictEqual(git(web, ["ls-tree", "--name-only", merge]).split("\n").filter((f) => f === "billing.ts" || f === "prod.txt"), ["billing.ts", "prod.txt"]);
      assert.deepStrictEqual([git(web, ["rev-parse", "HEAD"]), git(web, ["status", "--porcelain"])], [heads.web, status], "still nothing checked out");
      git(web, ["update-ref", "refs/heads/prod", prodWas]);
      // release-1.4 into main, checked out in both and clean there: a checklist, both ticked; untick acme-api.
      await viewPick({ left: "release-1.4", right: "main" });
      await until2("release-1.4 ↔ main", repos, (x) => x.description === "release-1.4 ↔ main" && x.roots.length === 2);
      await vscode.commands.executeCommand("linyra._itest.answer", JSON.stringify(["acme-web"]));
      await vscode.commands.executeCommand("linyra.compareMerge");
      assert.deepStrictEqual([git(api, ["rev-parse", "HEAD"]), git(web, ["rev-parse", "HEAD"])], [heads.api, git(web, ["rev-parse", "release-1.4"])], "only the ticked one merged");
      // One repository's right-click: that one only, after its own prompt.
      await vscode.commands.executeCommand("linyra._itest.answer", "Merge");
      await vscode.commands.executeCommand("linyra.compareMerge", { repoId: api });
      assert.strictEqual(await vscode.commands.executeCommand("linyra._itest.lastWarning"), "Merge release-1.4 into main in acme-api?");
      assert.strictEqual(git(api, ["rev-parse", "HEAD"]), git(api, ["rev-parse", "release-1.4"]));
    } finally {
      git(api, ["reset", "-q", "--hard", heads.api]);
      git(web, ["reset", "-q", "--hard", heads.web]);
      await vscode.commands.executeCommand("linyra._itest.answer", undefined);
      await vscode.commands.executeCommand("linyra._itest.compareMode", "files");
    }
  });

  it("Release…: one form before anything runs (repositories, tag, push), then the merge, the tag on ▶ with that repository's notes", async () => {
    const api = roots["acme-api"], web = roots["acme-web"];
    const prodWas = git(web, ["rev-parse", "refs/heads/prod"]);
    type LastForm = { spec: { title: string; fields: { id: string; items?: { label: string; value: boolean; disabled?: string }[]; hint?: string }[] }; problems: Record<string, string> };
    const lastForm = () => vscode.commands.executeCommand<LastForm>("linyra._itest.lastForm");
    try {
      await viewPick({ left: "release-1.4", right: "prod" });
      await until2("listed", repos, (x) => x.description === "release-1.4 ↔ prod" && x.roots.length === 2);
      await select("*");
      // Cancelled: nothing ran, not even the merge.
      await vscode.commands.executeCommand("linyra._itest.answer", "Cancel");
      assert.strictEqual(await vscode.commands.executeCommand("linyra.release"), undefined);
      assert.strictEqual(git(web, ["rev-parse", "refs/heads/prod"]), prodWas, "cancelled before anything ran");
      const form = (await lastForm()).spec;
      assert.strictEqual(form.title, "Release release-1.4 into prod");
      // acme-api would conflict: shown, not offered. No remote in the fixture: the form says prod stays local.
      assert.deepStrictEqual(form.fields.find((f) => f.id === "repos")?.items?.map((i) => `${i.label} ${i.value} ${i.disabled ?? ""}`), ["acme-web true ", "acme-api false would conflict"]);
      assert.match(form.fields.find((f) => f.id === "push")?.hint ?? "", /stays local in: acme-web/);
      // A tag acme-web already has: refused before anything runs.
      git(web, ["tag", "ci-r1", "HEAD"]);
      await vscode.commands.executeCommand("linyra._itest.answer", JSON.stringify({ tag: "ci-r1", push: false }));
      assert.strictEqual(await vscode.commands.executeCommand("linyra.release"), undefined);
      assert.deepStrictEqual((await lastForm()).problems, { tag: "acme-web already has the tag ci-r1." });
      assert.strictEqual(git(web, ["rev-parse", "refs/heads/prod"]), prodWas, "refused: nothing merged");
      git(web, ["tag", "-d", "ci-r1"]);
      await vscode.commands.executeCommand("linyra._itest.answer", JSON.stringify({ tag: "ci-r1", push: false }));
      const r = await vscode.commands.executeCommand<{ merged: string[]; tagged: string[]; pushed: string[]; notes: string }>("linyra.release");
      assert.deepStrictEqual([r?.merged, r?.tagged, r?.pushed], [["acme-web"], ["acme-web"], []]);
      assert.match(r!.notes, /^## acme-api \(release-1\.4 → prod\)[\s\S]*## acme-web \(release-1\.4 → prod\)\n\n- feat: billing page/, "read before the merge: every repository's");
      assert.strictEqual(await vscode.commands.executeCommand("linyra._itest.clipboard"), r!.notes, "copied");
      assert.strictEqual(git(web, ["rev-parse", "refs/heads/prod"]), git(web, ["rev-parse", "release-1.4"]));
      assert.strictEqual(git(web, ["rev-parse", "ci-r1^{commit}"]), git(web, ["rev-parse", "refs/heads/prod"]), "the tag on ▶'s tip");
      assert.match(git(web, ["tag", "-l", "-n9", "ci-r1"]), /Release ci-r1[\s\S]*feat: billing page/);
      assert.strictEqual(git(api, ["tag", "-l", "ci-r1"]), "", "not merged there: not tagged");
    } finally {
      git(web, ["update-ref", "refs/heads/prod", prodWas]);
      try { git(web, ["tag", "-d", "ci-r1"]); } catch { /* not created */ }
      await vscode.commands.executeCommand("linyra._itest.answer", undefined);
    }
  });
});

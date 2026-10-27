// Startup measurement for dev/perf/run.mjs (not part of the regular suite).
import * as vscode from "vscode";
import type { LogSnapshot } from "../logView";

const snapshot = () => vscode.commands.executeCommand<LogSnapshot | undefined>("polylog._itest.snapshot");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Linyra startup", () => {
  it("measures time to first rows and the load work done", async function () {
    this.timeout(180000);
    const t0 = Date.now();
    await vscode.commands.executeCommand("polylog.open");
    let first: LogSnapshot | undefined;
    for (;;) {
      const s = await snapshot();
      if (s && s.rows.length > 0) {
        first = s;
        break;
      }
      if (Date.now() - t0 > 120000) throw new Error("no rows after 120s");
      await sleep(20);
    }
    const msFirstRows = Date.now() - t0;
    // The switch's badge: every repository's uncommitted work, read in the background after the first page.
    const tFirst = Date.now();
    let badge: LogSnapshot | undefined;
    for (;;) {
      badge = await snapshot();
      if (badge?.workKnown) break;
      if (Date.now() - tFirst > 60000) throw new Error("the badge never became known");
      await sleep(5);
    }
    const msBadgeAfterFirstRows = Date.now() - tFirst;
    const badgeStatus = badge!.spawnLog.filter((x) => x.cmd === "status").length;
    await sleep(10000); // let repository discovery and background reads settle
    const settled = (await snapshot())!;
    // Show Uncommitted Changes, with 5 of the repositories dirty.
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const dirty = settled.repos.slice(0, 5);
    for (const r of dirty) fs.writeFileSync(path.join(r.root, "UNCOMMITTED.md"), "x\n");
    // Uncommitted work is read in the background; Refresh reads every repository again.
    const known = (s: LogSnapshot | undefined) => (s ? s.uncommitted.filter((w) => w.changes.length + w.staged.length > 0).length : 0);
    const t1 = Date.now();
    void vscode.commands.executeCommand("polylog._itest.send", { type: "refresh" });
    let msFirstPinned = -1;
    for (;;) {
      const n = known(await snapshot());
      if (n > 0 && msFirstPinned < 0) msFirstPinned = Date.now() - t1;
      if (n === dirty.length) break;
      if (Date.now() - t1 > 60000) throw new Error("the uncommitted work never all appeared");
      await sleep(5);
    }
    const msAllPinned = Date.now() - t1;
    // One editor save in one dirty repository, with the rows shown: what does it cost?
    await sleep(2000);
    const before = (await snapshot())!;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(dirty[0].root, "UNCOMMITTED.md")));
    const edit = new vscode.WorkspaceEdit();
    edit.insert(doc.uri, new vscode.Position(0, 0), "more\n");
    await vscode.workspace.applyEdit(edit);
    await doc.save();
    await sleep(2500); // the save, then VS Code's Git reporting the same repository
    const after = (await snapshot())!;
    const posted = (s: LogSnapshot) => Object.values(s.posts).reduce((n, p) => n + p.bytes, 0);
    const save = {
      spawns: after.spawnLog.length - before.spawnLog.length,
      reposRead: new Set(after.spawnLog.slice(before.spawnLog.length).map((x) => x.root)).size,
      postBytes: posted(after) - posted(before),
    };
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    // Stage one file from the Uncommitted view: one repository read again, nothing else.
    const beforeStage = (await snapshot())!;
    await vscode.commands.executeCommand("polylog.stage", { repoId: dirty[0].id, group: "changes", path: "UNCOMMITTED.md" });
    const afterStage = (await snapshot())!;
    const stage = {
      spawns: afterStage.spawnLog.length - beforeStage.spawnLog.length,
      reposRead: new Set(afterStage.spawnLog.slice(beforeStage.spawnLog.length).map((x) => x.root)).size,
    };
    // All Files on the newest commit: time to its first level.
    const top = afterStage.rows[0];
    await vscode.commands.executeCommand("polylog._itest.send", { type: "select", repoId: top.repoId, sha: top.sha });
    for (let i = 0; i < 400 && !(await snapshot())!.changes.items.length; i++) await sleep(5);
    await vscode.commands.executeCommand("polylog.changes.focus");
    const tAll = Date.now();
    const headerOnly = (await snapshot())!.changes.items.length;
    await vscode.commands.executeCommand("polylog.changesShowAll");
    let msAllFiles = -1;
    for (;;) {
      const n = (await snapshot())!.changes.items.length;
      if (n > headerOnly || Date.now() - tAll > 10000) { msAllFiles = n > headerOnly ? Date.now() - tAll : -1; break; }
      await sleep(5);
    }
    await vscode.commands.executeCommand("polylog.changesShowChanged");
    const cp = require("child_process") as typeof import("child_process");
    cp.execFileSync("git", ["reset", "-q", "--", "UNCOMMITTED.md"], { cwd: dirty[0].root });
    for (const r of dirty) fs.rmSync(path.join(r.root, "UNCOMMITTED.md"));
    // Compare Branches: counts in every repository for a small and a whole-history divergence.
    const roots = settled.repos.map((r) => r.root);
    for (const root of roots) {
      const head = cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();
      const back = cp.spawnSync("git", ["rev-parse", "HEAD~3"], { cwd: root }).stdout.toString().trim() || head;
      const first = cp.execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], { cwd: root }).toString().trim().split("\n")[0];
      cp.execFileSync("git", ["update-ref", "refs/heads/perf-right", head], { cwd: root });
      cp.execFileSync("git", ["update-ref", "refs/heads/perf-left", back], { cwd: root });
      cp.execFileSync("git", ["update-ref", "refs/heads/perf-root", first], { cwd: root });
    }
    const compareRead = async (left: string) => {
      const before = (await snapshot())!.spawnLog.length;
      const t = Date.now();
      await vscode.commands.executeCommand("polylog._itest.comparePick", { left, right: "perf-right" });
      const ms = Date.now() - t;
      const log = (await snapshot())!.spawnLog.slice(before);
      return { ms, spawnsByCmd: log.reduce<Record<string, number>>((m, x) => ({ ...m, [x.cmd]: (m[x.cmd] ?? 0) + 1 }), {}) };
    };
    const small = await compareRead("perf-left");
    const long = await compareRead("perf-root");
    await vscode.commands.executeCommand("polylog._itest.comparePick", null);
    // A diff: time until both sides are read and the diff tab is active. Idle, then while Compare reads.
    const diffTime = async () => {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      const c = settled.rows.find((r) => r.parents.length === 1)!;
      const root = settled.repos.find((r) => r.id === c.repoId)!.root;
      const file = cp.execFileSync("git", ["show", "--name-only", "--format=", c.sha], { cwd: root }).toString().trim().split("\n")[0];
      const t = Date.now();
      await vscode.commands.executeCommand("polylog.openDiff", { repoId: c.repoId, sha: c.sha, parent: c.parents[0], path: file });
      for (let i = 0; i < 2000; i++) {
        const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
        if (tab?.input instanceof vscode.TabInputTextDiff) {
          await vscode.workspace.openTextDocument(tab.input.original);
          await vscode.workspace.openTextDocument(tab.input.modified);
          break;
        }
        await sleep(5);
      }
      return Date.now() - t;
    };
    const msDiffIdle = await diffTime();
    void vscode.commands.executeCommand("polylog._itest.comparePick", { left: "perf-root", right: "perf-right" });
    await sleep(20);
    const msDiffDuringCompare = await diffTime();
    await vscode.commands.executeCommand("polylog._itest.comparePick", null);
    const msDiffIdle2 = await diffTime();
    for (const root of roots) for (const b of ["perf-left", "perf-right", "perf-root"]) cp.spawnSync("git", ["update-ref", "-d", `refs/heads/${b}`], { cwd: root });
    console.log("PERF " + JSON.stringify({
      msFirstRows, reposAtFirstRows: first.repos.length, reposSettled: settled.repos.length,
      rowsSettled: settled.rows.length, stats: settled.stats, branches: settled.branches.length,
      spawnsByCmd: settled.spawnLog.reduce<Record<string, number>>((m, x) => ({ ...m, [x.cmd]: (m[x.cmd] ?? 0) + 1 }), {}),
      uncommitted: { msBadgeAfterFirstRows, badgeStatus, msAllPinned, msFirstPinned, dirty: dirty.length, save, stage }, msAllFiles,
      compare: { msCounts: small.ms, msLong: long.ms, spawnsByCmd: small.spawnsByCmd },
      diff: { msDiffIdle, msDiffDuringCompare, msDiffIdle2 },
    }));
  });
});

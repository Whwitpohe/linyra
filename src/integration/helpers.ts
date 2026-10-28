// Shared by the integration suites: the Log's test seams and waiting helpers.
import * as assert from "assert";
import * as vscode from "vscode";
import * as testFs from "fs";
import * as testPath from "path";
import * as testOs from "os";
import type { OpenDiffArgs } from "../changesTree";
import type { LogSnapshot } from "../logView";
import type { WebviewMessage } from "../protocol";
import { type Commit } from "../types";

export const EXTENSION_ID = "whwitpohe.linyra";
export const snapshot = () => vscode.commands.executeCommand<LogSnapshot>("linyra._itest.snapshot");
export const send = (m: WebviewMessage) => vscode.commands.executeCommand("linyra._itest.send", m);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const ALL = { text: "", author: "", mine: false, branch: "", repoIds: null, date: "all" as const };

/** Git/watchers can briefly retain Windows handles after a ref or remote is removed. */
export async function removeTestDirectory(target: string): Promise<void> {
  const absolute = testPath.resolve(target);
  const relative = testPath.relative(testOs.tmpdir(), absolute);
  assert.ok(relative && !relative.startsWith("..") && !testPath.isAbsolute(relative)
    && relative.split(testPath.sep)[0].startsWith("linyra-"), "cleanup must stay inside a named temporary Linyra fixture");
  await testFs.promises.rm(absolute, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

export async function waitFor<T>(what: string, probe: () => PromiseLike<T | undefined> | T | undefined, ms = 20000): Promise<T> {
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
export const until = (what: string, ok: (s: LogSnapshot) => boolean) =>
  waitFor(what, async () => {
    const s = await snapshot();
    return s && ok(s) ? s : undefined;
  });
export const diffTab = () =>
  waitFor("a diff editor", () => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    return input instanceof vscode.TabInputTextDiff && (input.modified.scheme === "git" || input.modified.scheme === "linyra") ? input : undefined;
  });
export const tabCount = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).length;
export const closeEditors = () => vscode.commands.executeCommand("workbench.action.closeAllEditors");
export const args = (c: Commit, path: string): OpenDiffArgs => ({ repoId: c.repoId, sha: c.sha, parent: c.parents[0] ?? null, path });
export const bySubject = (s: LogSnapshot, prefix: string) => s.rows.find((r) => r.subject.startsWith(prefix))!;

// Runs only in a throwaway VS Code extension-test host, never in the shipped extension.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";

const allowed = new Set([
  "linyra.open", "linyra.compareShow", "linyra.compareHide", "linyra.openDiff", "linyra.insights",
  "linyra._itest.snapshot", "linyra._itest.send", "linyra._itest.changesMessage",
  "linyra._itest.compareView", "linyra._itest.compare", "linyra._itest.compareStore", "linyra._itest.compareSelect",
  "linyra._itest.compareMode", "linyra._itest.compareReposSend", "linyra._itest.compareSide",
  "linyra._itest.expandChanges", "linyra._itest.branches",
  "workbench.action.closeAllEditors", "workbench.action.closeSidebar",
  "workbench.action.closeAuxiliaryBar", "workbench.action.positionPanelBottom",
  "workbench.action.toggleMaximizedPanel", "workbench.action.focusPanel",
  "workbench.action.openSettings", "workbench.action.closePanel",
  "notifications.clearAll",
]);

export async function run(): Promise<void> {
  const control = process.env.LINYRA_CAPTURE_CONTROL;
  if (!control || process.env.LINYRA_ITEST !== "1") throw new Error("capture needs an isolated development host");
  await vscode.extensions.getExtension("whwitpohe.linyra")!.activate();
  await vscode.commands.executeCommand("workbench.action.closeSidebar");
  await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
  await vscode.commands.executeCommand("linyra.open");
  await fs.writeFile(path.join(control, "ready.json"), JSON.stringify({ ready: true }));

  await new Promise<void>((finish) => {
    let last = 0;
    let busy = false;
    const timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const request = JSON.parse(await fs.readFile(path.join(control, "request.json"), "utf8"));
        if (request.id === last) return;
        last = request.id;
        let result: unknown;
        if (request.op === "command") {
          if (!allowed.has(request.command)) throw new Error("command is outside the recording allowlist");
          result = await vscode.commands.executeCommand(request.command, ...(request.args ?? []));
        } else if (request.op === "theme") {
          await vscode.workspace.getConfiguration().update("workbench.colorTheme", request.value, vscode.ConfigurationTarget.Global);
        } else if (request.op === "history") {
          const file = path.resolve(request.file);
          if (!vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file))) throw new Error("history file must be in the demo workspace");
          result = await vscode.commands.executeCommand("linyra.fileHistory", vscode.Uri.file(file));
        } else if (request.op === "finish") {
          clearInterval(timer);
          finish();
        } else throw new Error("unknown recording operation");
        await fs.writeFile(path.join(control, "response.json"), JSON.stringify({ id: request.id, result: result ?? null }));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          await fs.writeFile(path.join(control, "response.json"), JSON.stringify({ id: last, error: String(error) }));
        }
      } finally { busy = false; }
    }, 80);
  });
}

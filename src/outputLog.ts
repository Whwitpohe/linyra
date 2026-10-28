import * as vscode from "vscode";

let channel: vscode.LogOutputChannel | undefined;

/** Linyra's own Output channel (Output → Linyra), created the first time something is logged. */
export function outputLog(): vscode.LogOutputChannel {
  return (channel ??= vscode.window.createOutputChannel("Linyra", { log: true }));
}

export function disposeOutputLog(): void {
  channel?.dispose();
  channel = undefined;
}

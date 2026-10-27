import { randomBytes } from "crypto";
import * as vscode from "vscode";
import type { ChangesTree } from "./changesTree";
import { localize } from "./i18n";
import { renderChangesHtml } from "./webview/changes/html";

/** An independently movable editor tab reuses the same changes, diffs and actions. */
export class ChangesPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext, private readonly changes: ChangesTree) {}

  open(): void {
    if (this.panel) { this.panel.reveal(); return; }
    const out = vscode.Uri.joinPath(this.context.extensionUri, "out");
    const panel = vscode.window.createWebviewPanel("polylog.changesEditor", localize("Polylog Changes"), vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [out] });
    this.panel = panel;
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, "media", "compare.svg");
    const views = [
      this.changes.subscribe((message) => { void panel.webview.postMessage(message); }, () => !!this.panel?.visible),
      panel.webview.onDidReceiveMessage((message: unknown) => void this.changes.onMessage(message, "editor")),
      panel.onDidChangeViewState(() => this.changes.visibilityChanged()),
    ];
    const disposed = panel.onDidDispose(() => {
      if (this.panel === panel) this.panel = undefined;
      views.forEach((view) => view.dispose());
    });
    this.subscriptions.push(disposed);
    panel.webview.html = renderChangesHtml({ cspSource: panel.webview.cspSource, nonce: randomBytes(16).toString("hex"),
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(out, "changes.js")).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(out, "changes.css")).toString() });
  }

  dispose(): void {
    this.panel?.dispose();
    this.subscriptions.forEach((subscription) => subscription.dispose());
  }
}

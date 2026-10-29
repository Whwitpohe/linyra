import { randomBytes } from "crypto";
import * as vscode from "vscode";
import { checkValues, formProblems, type FormSpec, type FormValues, type FormWebview } from "./formModel";
import { renderFormHtml } from "./webview/form/html";

/** The open form of each kind: opening it again shows it, with the new fields. */
const open = new Map<string, { panel: vscode.WebviewPanel; settle: (v: FormValues | undefined) => void; show: (spec: FormSpec) => void }>();

/**
 * A review form in an editor tab: the fields, then one button. Resolves with the checked values
 * when that button is pressed (the tab closes), undefined when it is cancelled or closed.
 * `check`: the host's own last word before the tab closes (a tag taken meanwhile…): problems by field.
 */
export function openForm(extensionUri: vscode.Uri, spec: FormSpec, check?: (values: FormValues) => Promise<Record<string, string>>): Promise<FormValues | undefined> {
  const was = open.get(spec.id);
  if (was) {
    // The form asked for again: the earlier question is dropped, this one takes its tab.
    was.settle(undefined);
    was.show(spec);
    was.panel.reveal();
  }
  return new Promise((resolve) => {
    const out = vscode.Uri.joinPath(extensionUri, "out");
    const panel = was?.panel ?? vscode.window.createWebviewPanel(`linyra.form.${spec.id}`, spec.title, vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [out], retainContextWhenHidden: true });
    let current = spec;
    let settled = false;
    const disposables: vscode.Disposable[] = [];
    const settle = (v: FormValues | undefined) => {
      if (settled) return;
      settled = true;
      for (const d of disposables) d.dispose();
      resolve(v);
    };
    const show = (s: FormSpec) => {
      current = s;
      panel.title = s.title;
      void panel.webview.postMessage({ type: "spec", spec: s });
    };
    if (!was) {
      panel.webview.html = renderFormHtml({
        cspSource: panel.webview.cspSource,
        nonce: randomBytes(16).toString("hex"),
        scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(out, "form.js")).toString(),
        styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(out, "form.css")).toString(),
      });
      panel.onDidDispose(() => {
        const entry = open.get(spec.id);
        if (entry?.panel === panel) { entry.settle(undefined); open.delete(spec.id); }
      });
    }
    open.set(spec.id, { panel, settle, show });
    disposables.push(panel.webview.onDidReceiveMessage(async (m: FormWebview) => {
      if (!m || typeof m !== "object") return; // the page is not trusted
      if (m.type === "ready") show(current);
      else if (m.type === "cancel") { settle(undefined); panel.dispose(); }
      else if (m.type === "submit") {
        const values = checkValues(current, m.values);
        if (!values) { void panel.webview.postMessage({ type: "problems", problems: formProblems(current, (m.values ?? {}) as FormValues) }); return; }
        const problems = check ? await check(values) : {};
        if (Object.keys(problems).length > 0) { void panel.webview.postMessage({ type: "problems", problems }); return; }
        settle(values);
        panel.dispose();
      }
    }));
    if (was) show(spec);
  });
}

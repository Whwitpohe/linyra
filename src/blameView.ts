import * as vscode from "vscode";
import { blameArgs, blameAt, formatBlame, parseBlame, type Blame } from "./blameModel";
import type { RunGit } from "./logQuery";
import { decodeRevision, SCHEME, type RevisionRef } from "./revisionUri";
import { isSha } from "./types";

const DEFAULT_TEMPLATE = "${subject}, ${authorName} (${authorDateAgo})";

/**
 * Blame on the cursor line of a Linyra revision (a diff side, an All Files file): who last
 * changed that line, as of the commit shown. VS Code's own blame skips these documents; its
 * `git:` documents would bring its Unstage buttons onto commit diffs.
 */
export class BlameView implements vscode.Disposable {
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    after: { color: new vscode.ThemeColor("editorCodeLens.foreground"), margin: "0 0 0 3em" },
  });
  /** One read per open revision document: its content never changes. Dropped when it closes. */
  private readonly reads = new Map<string, { blame: Promise<Blame | undefined>; ctl: AbortController }>();
  private readonly disposables: vscode.Disposable[] = [];
  /** Integration runs: the last blame drawn (or undefined once cleared). */
  last: { uri: string; line: number; text: string } | undefined;

  constructor(private readonly run: RunGit, private readonly roots: () => readonly string[]) {
    this.disposables.push(
      this.decoration,
      vscode.window.onDidChangeTextEditorSelection((e) => void this.draw(e.textEditor)),
      vscode.window.onDidChangeActiveTextEditor(() => this.redraw()),
      vscode.workspace.onDidCloseTextDocument((d) => {
        const key = d.uri.toString();
        this.reads.get(key)?.ctl.abort();
        this.reads.delete(key);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("polylog.blame") || e.affectsConfiguration("git.blame.editorDecoration.template")) this.redraw();
      }),
    );
  }

  /** Only the focused editor carries a blame, like VS Code's. */
  private redraw(): void {
    const active = vscode.window.activeTextEditor;
    for (const e of vscode.window.visibleTextEditors) if (e !== active) e.setDecorations(this.decoration, []);
    if (active) void this.draw(active);
  }

  private revision(uri: vscode.Uri): RevisionRef | undefined {
    if (uri.scheme !== SCHEME) return undefined;
    try {
      const r = decodeRevision(uri.path, uri.query);
      // A commit only (not the index, not an empty side), in one of the workspace's repositories.
      if (!isSha(r.ref) || !this.roots().includes(r.root) || r.path === "" || r.path.startsWith("/") || r.path.split("/").includes("..")) return undefined;
      return r;
    } catch {
      return undefined;
    }
  }

  private read(uri: vscode.Uri, r: RevisionRef & { ref: string }): Promise<Blame | undefined> {
    const key = uri.toString();
    let hit = this.reads.get(key);
    if (!hit) {
      const ctl = new AbortController();
      // A deleted file's "after" side has nothing to blame: no blame, not an error.
      hit = { ctl, blame: this.run(r.root, blameArgs(r.ref, r.path), ctl.signal).then(parseBlame, () => undefined) };
      this.reads.set(key, hit);
    }
    return hit.blame;
  }

  private async draw(editor: vscode.TextEditor): Promise<void> {
    const r = this.revision(editor.document.uri);
    const enabled = vscode.workspace.getConfiguration("polylog").get<boolean>("blame", true);
    if (!r || !enabled || editor !== vscode.window.activeTextEditor) {
      this.clear(editor);
      return;
    }
    const blame = await this.read(editor.document.uri, r as RevisionRef & { ref: string });
    // The cursor may have moved, or another editor taken focus, while git ran.
    if (editor !== vscode.window.activeTextEditor) return;
    const line = editor.selection.active.line;
    const info = blame && blameAt(blame, line + 1);
    if (!info) {
      this.clear(editor);
      return;
    }
    const template = vscode.workspace.getConfiguration("git").get<string>("blame.editorDecoration.template", DEFAULT_TEMPLATE) || DEFAULT_TEMPLATE;
    const now = Math.floor(Date.now() / 1000);
    const text = formatBlame(template, info, now);
    const hover = new vscode.MarkdownString();
    hover.appendText(`${info.authorName} <${info.authorEmail}>, ${formatBlame("${authorDateAgo} (${authorDate})", info, now)}\n\n`);
    hover.appendText(`${info.subject}\n\n`);
    hover.appendMarkdown(`\`${info.hash.slice(0, 7)}\``);
    const at = new vscode.Range(line, Number.MAX_SAFE_INTEGER, line, Number.MAX_SAFE_INTEGER);
    editor.setDecorations(this.decoration, [{ range: at, hoverMessage: hover, renderOptions: { after: { contentText: text } } }]);
    this.last = { uri: editor.document.uri.toString(), line, text };
  }

  private clear(editor: vscode.TextEditor): void {
    editor.setDecorations(this.decoration, []);
    if (this.last?.uri === editor.document.uri.toString()) this.last = undefined;
  }

  dispose(): void {
    for (const { ctl } of this.reads.values()) ctl.abort();
    this.reads.clear();
    for (const d of this.disposables) d.dispose();
  }
}

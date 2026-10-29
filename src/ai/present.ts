// AI answers as read-only Markdown documents (linyra-ai:), rendered by VS Code's own Markdown
// preview and updated as the answer streams in, with a cancellable progress notification.
import * as vscode from "vscode";
import { localize } from "../i18n";
import { asAiError } from "./errors";

export const AI_SCHEME = "linyra-ai";
/** Answers kept for previews still open; older ones are dropped. */
const KEPT = 20;
/** The preview re-renders at most this often while an answer streams. */
const THROTTLE_MS = 80;

/** A file name for the preview's tab: the title without characters a path cannot hold. */
export const documentName = (title: string): string => `${title.replace(/[\\/:*?"<>|#%\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Linyra AI"}.md`;

interface Answer { uri: vscode.Uri; append(markdown: string): void; flush(): void }

export class AiDocuments implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly texts = new Map<string, string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  private count = 0;
  private readonly registration = vscode.workspace.registerTextDocumentContentProvider(AI_SCHEME, this);

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.texts.get(uri.toString()) ?? "";
  }

  create(title: string): Answer {
    const uri = vscode.Uri.from({ scheme: AI_SCHEME, path: `/${++this.count}/${documentName(title)}` });
    const key = uri.toString();
    this.texts.set(key, "");
    for (const old of [...this.texts.keys()].slice(0, Math.max(0, this.texts.size - KEPT))) this.texts.delete(old);
    const fire = () => {
      this.timers.delete(key);
      this.changed.fire(uri);
    };
    return {
      uri,
      append: (markdown) => {
        if (!markdown) return;
        this.texts.set(key, (this.texts.get(key) ?? "") + markdown);
        if (!this.timers.has(key)) this.timers.set(key, setTimeout(fire, THROTTLE_MS));
      },
      flush: () => {
        const t = this.timers.get(key);
        if (t !== undefined) clearTimeout(t);
        fire();
      },
    };
  }

  /**
   * Opens a preview of a new answer document and runs `run` with a writer that appends Markdown
   * to it. Cancelling the notification aborts `signal`. A failure inside `run` is written at the
   * end of the answer and shown; it is not thrown.
   */
  async present(title: string, run: (write: (markdown: string) => void, signal: AbortSignal) => Promise<void>): Promise<void> {
    const answer = this.create(title);
    try {
      await vscode.commands.executeCommand("markdown.showPreview", answer.uri);
    } catch {
      // The built-in Markdown extension is disabled: show the Markdown text itself.
      const doc = await vscode.workspace.openTextDocument(answer.uri);
      await vscode.window.showTextDocument(await vscode.languages.setTextDocumentLanguage(doc, "markdown"), { preview: true });
    }
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (_progress, token) => {
      const controller = new AbortController();
      const listener = token.onCancellationRequested(() => controller.abort());
      try {
        await run((markdown) => answer.append(markdown), controller.signal);
      } catch (error) {
        const e = asAiError(error, controller.signal);
        if (e.kind === "cancelled") answer.append(`\n\n*${localize("Cancelled.")}*\n`);
        else {
          answer.append(`\n\n> ${e.message.replace(/\n/g, "\n> ")}\n`);
          void vscode.window.showErrorMessage(e.message);
        }
      } finally {
        listener.dispose();
        answer.flush();
      }
    });
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.texts.clear();
    this.registration.dispose();
    this.changed.dispose();
  }
}

import * as vscode from "vscode";
import { aiService } from "./ai";
import { localize } from "./i18n";
import type { MessageRoutes } from "./messageRoutes";
import type { HostMessage } from "./protocol";

const AI_SEARCH_COMMAND = "linyra.ai.translateSearch";
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The search box's ✨: plain words turned into an operator query by Linyra AI, and its toggle
 * while Linyra AI is not set up. Whether it is available follows the linyra.ai settings.
 */
export class LogAiSearch {
  constructor(private readonly post: (m: HostMessage) => void) {}

  register(routes: MessageRoutes): void {
    routes.on("aiSearch", (m) => this.search(m.text)).on("aiConfigure", () => this.configure());
    // Not awaited: the first page does not wait for the command list.
    routes.onReady({ after: () => { void this.postAvailable(); } });
  }

  /** The search box's ✨ mode needs linyra.ai.translateSearch and a configured Linyra AI. */
  async available(): Promise<boolean> {
    if (!(await vscode.commands.getCommands(true)).includes(AI_SEARCH_COMMAND)) return false;
    try {
      return aiService().configured;
    } catch {
      return false;
    }
  }

  async postAvailable(): Promise<void> {
    this.post({ type: "aiSearchAvailable", available: await this.available() });
  }

  /** Plain words → an operator query; the webview puts it in the box and runs it. */
  private async search(raw: unknown): Promise<void> {
    if (typeof raw !== "string" || raw.trim() === "") return;
    const text = raw.trim().slice(0, 2000);
    if (!(await this.available())) {
      this.post({ type: "aiSearchResult", text, error: localize("Natural-language search needs Linyra AI. Set it up, then try again.") });
      return this.postAvailable();
    }
    try {
      const query = await vscode.commands.executeCommand<unknown>(AI_SEARCH_COMMAND, text);
      if (typeof query !== "string" || query.trim() === "") throw new Error(localize("Linyra AI did not return a search."));
      this.post({ type: "aiSearchResult", text, query: query.replace(/\s+/g, " ").trim().slice(0, 2000) });
    } catch (e) {
      this.post({ type: "aiSearchResult", text, error: messageOf(e) });
    }
  }

  /** The ✨ toggle while Linyra AI is not available: its own setup, or its settings without it. */
  private async configure(): Promise<void> {
    try {
      await aiService().ensureReady();
    } catch {
      const open = localize("Open Settings");
      if (await vscode.window.showInformationMessage(localize("Natural-language search needs Linyra AI. Set it up, then try again."), open) === open) {
        await vscode.commands.executeCommand("workbench.action.openSettings", "linyra.ai");
      }
    }
    await this.postAvailable();
  }
}

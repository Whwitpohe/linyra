// The Log webview's messages, each to the module that owns it. Pure: no vscode (messageRoutes.test.ts).
import type { WebviewMessage } from "./protocol";

type Of<T extends WebviewMessage["type"]> = Extract<WebviewMessage, { type: T }>;

/**
 * A feature registers its own messages (the branch sheet its sheet's, the hover card's details
 * theirs…), so logView.ts keeps the Log's own — the filter, loading, selection, File History —
 * and passes the rest on. A webview page that starts (or starts again, re-created while hidden)
 * runs each feature's ready hooks: `before` at once (what a new page cannot have, such as an open
 * sheet), `after` once it has its first page of rows (what it must be told again).
 */
export class MessageRoutes {
  private readonly routes = new Map<string, (m: WebviewMessage) => unknown>();
  private readonly hooks = { before: [] as (() => unknown)[], after: [] as (() => unknown)[] };

  on<T extends WebviewMessage["type"]>(type: T, handle: (m: Of<T>) => unknown): this {
    if (this.routes.has(type)) throw new Error(`Two handlers for the "${type}" message`);
    this.routes.set(type, handle as (m: WebviewMessage) => unknown);
    return this;
  }

  onReady(hooks: { before?: () => unknown; after?: () => unknown }): this {
    if (hooks.before) this.hooks.before.push(hooks.before);
    if (hooks.after) this.hooks.after.push(hooks.after);
    return this;
  }

  /** Runs the message's handler; false when no feature owns it (logView.ts's own, or unknown). */
  async dispatch(m: WebviewMessage): Promise<boolean> {
    const handle = this.routes.get(m.type);
    if (!handle) return false;
    await handle(m);
    return true;
  }

  /** The ready hooks of one phase, in the order they were registered. */
  async ready(phase: "before" | "after"): Promise<void> {
    for (const hook of this.hooks[phase]) await hook();
  }
}

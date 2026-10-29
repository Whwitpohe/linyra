// The host's messages to the Log's page, each to the part that owns it. Pure: no DOM (hostRoutes.test.ts).
import type { HostMessage } from "../protocol";

type Of<T extends HostMessage["type"]> = Extract<HostMessage, { type: T }>;

/**
 * A part of the page registers the messages it owns (the Repo List its branches and marks, the
 * hover card its details, the filter bar its suggestions…), so main.ts keeps the Log's own state —
 * init, pages, the selection — and passes the rest on, without drawing the Log again for them.
 */
export class HostRoutes {
  private readonly routes = new Map<string, (m: HostMessage) => void>();

  on<T extends HostMessage["type"]>(type: T, handle: (m: Of<T>) => void): this {
    if (this.routes.has(type)) throw new Error(`Two handlers for the "${type}" message`);
    this.routes.set(type, handle as (m: HostMessage) => void);
    return this;
  }

  /** Runs the message's handler; false when no part owns it (main.ts's own). */
  dispatch(m: HostMessage): boolean {
    const handle = this.routes.get(m.type);
    if (!handle) return false;
    handle(m);
    return true;
  }
}

import type { WebviewMessage } from "../protocol";
import { onAvatars, setAvatars } from "./ui/authorDisc";

/** The rows must stay put this long before the host hears whose they are: a fast scroll asks for nothing on the way. */
const SETTLE_MS = 250;
const MAX_AUTHORS = 300;

/**
 * Avatars for the Commit list. Tells the host the authors of the rows on screen (it asks only for
 * those), and puts each batch it sends into the disc registry: the rows on screen are drawn again
 * once per batch, however many avatars it held.
 */
export class AvatarFeed {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private reported = "";
  private readonly received = new Set<string>();

  constructor(
    private readonly rows: HTMLElement,
    private readonly authorAt: (index: number) => { email: string; repoId: string } | undefined,
    private readonly post: (m: WebviewMessage) => void,
    redraw: () => void,
  ) {
    // The list adds and removes rows as it scrolls and repaints: that is when the authors may change.
    new MutationObserver(() => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.report(), SETTLE_MS);
    }).observe(rows, { childList: true });
    onAvatars(redraw);
  }

  /** The host's batch. reset: the settings changed, so the avatars received before are dropped (an empty URI draws the initial). */
  receive(byEmail: Record<string, string>, reset = false): void {
    const next: Record<string, string> = {};
    if (reset) for (const email of this.received) next[email] = "";
    if (reset) this.received.clear();
    for (const [email, uri] of Object.entries(byEmail)) {
      if (typeof uri !== "string" || !uri.startsWith("data:image/")) continue;
      next[email] = uri;
      this.received.add(email);
    }
    setAvatars(next);
  }

  private report(): void {
    const authors = new Map<string, { email: string; repoId: string }>();
    for (const row of this.rows.querySelectorAll<HTMLElement>(".row[data-index]")) {
      const a = this.authorAt(Number(row.dataset.index));
      if (a?.email) authors.set(`${a.repoId}\0${a.email.toLowerCase()}`, { email: a.email, repoId: a.repoId });
      if (authors.size >= MAX_AUTHORS) break;
    }
    const key = [...authors.keys()].sort().join("\n");
    if (key === this.reported) return;
    this.reported = key;
    this.post({ type: "visibleAuthors", authors: [...authors.values()] });
  }
}

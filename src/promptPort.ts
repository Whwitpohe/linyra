// A webview's questions on the host's side (promptModel.ts): asked in it at a place, answered by
// it, checked here. Each Linyra webview that has buttons asking questions keeps one (the Log, the
// Commit side bar, Compare, Insights) and registers it with Ask under its surface's name.
import { promptAnswer, promptRect, type PromptAnchor, type PromptAnswer, type PromptCheck, type PromptRect, type PromptRequest, type PromptUpdate } from "./promptModel";
import type { PromptBox, PromptExtra, PromptSurface } from "./uncommittedActions";

/** What a port sends its webview: a question, and the check of what is being typed in one. */
export type PromptHostMessage =
  | { type: "prompt"; id: number; request: PromptRequest; at: PromptRect | string }
  | { type: "promptCheck"; id: number; check?: PromptCheck }
  /** The host writing into an open name's box while its extra (✨) works. */
  | { type: "promptUpdate"; id: number; update: PromptUpdate };

interface Open {
  req: PromptRequest;
  resolve: (a: PromptAnswer) => void;
  check?: (value: string) => PromptCheck | undefined;
  extra?: PromptExtra;
  /** What the box holds, as last typed or written (the extra reads it). */
  value: string;
  /** The extra's work while it runs: stopped when the question closes. */
  work?: AbortController;
}

export class PromptPort implements PromptSurface {
  private readonly open = new Map<number, Open>();
  private seq = 0;
  /** Test seam: the last question asked, and its id. */
  last: { id: number; request: PromptRequest; at: PromptRect | string } | undefined;

  /** `ready`: the webview is shown and has loaded (else VS Code's picker asks). */
  constructor(private readonly surface: string, private readonly post: (m: PromptHostMessage) => void, private readonly ready: () => boolean) {}

  /** The place a webview message carries (sent right after a click or a key there), as an anchor for Ask.withAnchor. */
  anchorOf(m: unknown): PromptAnchor | undefined {
    const at = promptRect((m as { at?: unknown } | undefined)?.at);
    return at && { surface: this.surface, at, since: Date.now() };
  }

  ask(req: PromptRequest, at: PromptRect | string, opts: { check?: (value: string) => PromptCheck | undefined; extra?: PromptExtra } = {}): Promise<PromptAnswer> | undefined {
    if (!this.ready()) return undefined;
    const id = ++this.seq;
    return new Promise<PromptAnswer>((resolve) => {
      // One question at a time, as VS Code's picker: a new one closes the open one (the webview does too).
      this.cancel();
      this.open.set(id, { req, resolve, check: opts.check, extra: opts.extra, value: req.kind === "input" ? req.value ?? "" : "" });
      this.last = { id, request: req, at };
      this.post({ type: "prompt", id, request: req, at });
    });
  }

  /** The webview answered (untrusted: checked against the question). A name its check refuses is not taken: the box says why. */
  answered(id: unknown, answer: unknown): void {
    const p = typeof id === "number" ? this.open.get(id) : undefined;
    if (!p) return;
    const a = promptAnswer(p.req, answer);
    const refused = a && "value" in a ? p.check?.(a.value) : undefined;
    if (refused?.blocking) { this.post({ type: "promptCheck", id: id as number, check: refused }); return; }
    this.open.delete(id as number);
    p.work?.abort();
    p.resolve(a);
  }

  /**
   * The button beside a name's box (✨) was pressed, the switch as `on`: its work runs here and
   * writes into the box through a stand-in for VS Code's InputBox (its text, busy, its message).
   * One at a time; it stops when the question closes.
   */
  async extra(id: unknown, on: unknown): Promise<void> {
    const p = typeof id === "number" ? this.open.get(id) : undefined;
    if (!p?.extra || p.work) return;
    const n = id as number, update = (u: PromptUpdate) => { if (this.open.get(n) === p) this.post({ type: "promptUpdate", id: n, update: u }); };
    let busy = false;
    let message: PromptBox["validationMessage"];
    const box: PromptBox = {
      get value() { return p.value; },
      set value(v: string) { p.value = v; update({ value: v }); },
      get busy() { return busy; },
      set busy(b: boolean) { busy = b; update({ busy: b }); },
      get validationMessage() { return message; },
      set validationMessage(m: PromptBox["validationMessage"]) { message = m; update({ message: m === undefined ? null : typeof m === "string" ? m : m.message }); },
    };
    p.work = new AbortController();
    try { await p.extra(box, on === true, p.work.signal); } finally { p.work = undefined; }
  }

  /** What is being typed in a name: its check, back to the webview. */
  typed(id: unknown, value: unknown): void {
    const p = typeof id === "number" ? this.open.get(id) : undefined;
    if (!p || typeof value !== "string") return;
    p.value = value;
    const check = p.check?.(value);
    this.post({ type: "promptCheck", id: id as number, ...(check ? { check } : {}) });
  }

  /** The webview went or loaded anew: its questions are cancelled. */
  cancel(): void {
    for (const p of this.open.values()) { p.work?.abort(); p.resolve(undefined); }
    this.open.clear();
  }
}

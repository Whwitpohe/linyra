import * as assert from "assert";
import type { PromptRequest } from "./promptModel";
import { PromptPort, type PromptHostMessage } from "./promptPort";

const pick: PromptRequest = { kind: "pick", title: "Remote to push to", items: [{ label: "origin" }, { label: "upstream" }] };
const name: PromptRequest = { kind: "input", title: "New branch", placeholder: "Branch name" };
const check = (v: string) => (v.includes(" ") ? { message: "No spaces.", blocking: true } : v.length > 20 ? { message: "Long.", blocking: false } : undefined);

async function main(): Promise<void> {
  const sent: PromptHostMessage[] = [];
  let ready = true;
  const port = new PromptPort("log", (m) => sent.push(m), () => ready);

  // Asked in the webview, at the place; answered by its id, checked against the question.
  const a = port.ask(pick, "toolbar-push")!;
  assert.deepStrictEqual(sent.at(-1), { type: "prompt", id: 1, request: pick, at: "toolbar-push" });
  port.answered(1, { index: 7 });
  port.answered(1, { index: 1 });
  assert.deepStrictEqual(await a, undefined, "an answer out of range is no answer");
  const b = port.ask(pick, { x: 1, y: 2, w: 3, h: 4 })!;
  port.answered(2, { index: 1 });
  assert.deepStrictEqual(await b, { index: 1 });
  port.answered(2, { index: 0 });
  console.log("ok - a question goes to the webview by id; its answer is checked against it, and taken once");

  // A name: what is typed is checked; a refused answer keeps it asked, a warning does not.
  const c = port.ask(name, "toolbar-update", { check })!;
  port.typed(3, "feature x");
  assert.deepStrictEqual(sent.at(-1), { type: "promptCheck", id: 3, check: { message: "No spaces.", blocking: true } });
  port.typed(3, "feature-x");
  assert.deepStrictEqual(sent.at(-1), { type: "promptCheck", id: 3 });
  let settled = false;
  void c.then(() => { settled = true; });
  port.answered(3, { value: "feature x" });
  await Promise.resolve();
  assert.strictEqual(settled, false, "refused: still asked");
  assert.deepStrictEqual(sent.at(-1), { type: "promptCheck", id: 3, check: { message: "No spaces.", blocking: true } });
  port.answered(3, { value: "feature/a-rather-long-name" });
  assert.deepStrictEqual(await c, { value: "feature/a-rather-long-name" }, "a warning does not refuse");
  console.log("ok - a name is checked as it is typed and when given; only a refusal keeps it asked");

  // One at a time; a webview that went cancels; a hidden one asks nothing (VS Code's picker does).
  const d = port.ask(pick, "toolbar-push")!;
  const e = port.ask(pick, "toolbar-push")!;
  assert.strictEqual(await d, undefined, "a new question closes the open one");
  port.cancel();
  assert.strictEqual(await e, undefined);
  ready = false;
  assert.strictEqual(port.ask(pick, "toolbar-push"), undefined);
  assert.deepStrictEqual(port.last?.id, 5);
  console.log("ok - one question at a time; cancelled when the webview goes; none while it is hidden");

  // A name's ✨: its work writes into the box (text, busy, its message), reads what was typed, and
  // stops when the question closes; the answer has the switch's state.
  ready = true;
  sent.length = 0;
  const stash: PromptRequest = { kind: "input", title: "Stash Changes in acme-web", placeholder: "Stash message", value: "WIP", toggle: { label: "Include new files", on: false, says: ["tracked", "all"] }, extra: "Write the stash message with AI" };
  let stopped: AbortSignal | undefined, sawOn: boolean | undefined, sawValue: string | undefined;
  let release!: () => void;
  const writing = new Promise<void>((r) => { release = r; });
  const f = port.ask(stash, "toolbar-update", { extra: async (box, on, signal) => {
    sawOn = on; sawValue = box.value; stopped = signal;
    box.busy = true;
    box.value = "Save the half-done upload retry";
    box.validationMessage = undefined;
    await writing;
    box.busy = false;
  } })!;
  const id = port.last!.id;
  port.typed(id, "WIP: uploader");
  const work = port.extra(id, true);
  assert.deepStrictEqual([sawOn, sawValue], [true, "WIP: uploader"], "it gets the switch and what was typed");
  assert.deepStrictEqual(sent.filter((m) => m.type === "promptUpdate").map((m) => m.type === "promptUpdate" && m.update),
    [{ busy: true }, { value: "Save the half-done upload retry" }, { message: null }]);
  void port.extra(id, true);
  assert.strictEqual(sent.filter((m) => m.type === "promptUpdate").length, 3, "one at a time: a second press while it works runs nothing");
  port.answered(id, { value: "Save the half-done upload retry", on: true });
  assert.deepStrictEqual(await f, { value: "Save the half-done upload retry", on: true });
  assert.strictEqual(stopped?.aborted, true, "the question closed: its work is stopped");
  release();
  await work;
  assert.strictEqual(sent.filter((m) => m.type === "promptUpdate").length, 3, "nothing is written into a box that is gone");
  console.log("ok - a name's ✨ writes into the box through the port, and stops when the question closes");

  // A message's place, as an anchor for this surface.
  assert.deepStrictEqual(port.anchorOf({ type: "history", at: { x: 5, y: 6, w: 7, h: 8 } })?.at, { x: 5, y: 6, w: 7, h: 8 });
  assert.strictEqual(port.anchorOf({ type: "history" }), undefined);
  assert.strictEqual(port.anchorOf({ type: "history", at: { x: 5 } }), undefined);
  console.log("ok - a message's place becomes this webview's anchor, when it has a valid one");
}
void main().catch((e) => { console.error(e); process.exitCode = 1; });

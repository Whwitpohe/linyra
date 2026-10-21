import * as assert from "assert";
import { applyGesture, keepListed, SELECTION_LIMIT, type Selection } from "./selectionModel";

const order = Array.from({ length: 10 }, (_, i) => `k${i}`);
const one = (k: string): Selection => ({ keys: [k], focus: k, anchor: k });
const click = (s: Selection, key: string, ctrl = false, shift = false) => applyGesture(s, { kind: "click", key, ctrl, shift }, order);

{
  const { next } = click(one("k1"), "k3");
  assert.deepStrictEqual(next, { keys: ["k3"], focus: "k3", anchor: "k3" });
  console.log("ok - a plain click selects one commit");
}
{
  const added = click(one("k3"), "k5", true).next;
  assert.deepStrictEqual(added, { keys: ["k3", "k5"], focus: "k5", anchor: "k5" });
  const removed = click(added, "k5", true).next;
  assert.deepStrictEqual(removed.keys, ["k3"]);
  assert.strictEqual(removed.focus, "k3");
  assert.deepStrictEqual(click(one("k3"), "k3", true).next, one("k3"));
  console.log("ok - Ctrl-click adds and removes, never the last one");
}
{
  assert.deepStrictEqual(click(one("k3"), "k6", false, true).next, { keys: ["k3", "k4", "k5", "k6"], focus: "k6", anchor: "k3" });
  assert.deepStrictEqual(click(one("k3"), "k1", false, true).next.keys, ["k1", "k2", "k3"]);
  console.log("ok - Shift-click selects from the anchor");
}
{
  const s = click(click(one("k1"), "k5", true).next, "k7", true, true).next; // anchor k5 → k5..k7, added to k1
  assert.deepStrictEqual(s.keys, ["k1", "k5", "k6", "k7"]);
  console.log("ok - Ctrl+Shift-click adds the range");
}
{
  const ext = applyGesture(one("k3"), { kind: "arrow", key: "k4", shift: true }, order).next;
  assert.deepStrictEqual(ext, { keys: ["k3", "k4"], focus: "k4", anchor: "k3" });
  assert.deepStrictEqual(applyGesture(ext, { kind: "arrow", key: "k5", shift: false }, order).next, one("k5"));
  console.log("ok - Shift+arrow extends, a plain arrow goes back to one");
}
{
  const two = click(one("k3"), "k5", true).next;
  assert.deepStrictEqual(applyGesture(two, { kind: "context", key: "k3" }, order).next, two);
  assert.deepStrictEqual(applyGesture(two, { kind: "context", key: "k8" }, order).next, one("k8"));
  console.log("ok - right-click keeps a selection it is inside, else selects that row");
}
{
  const many = Array.from({ length: 150 }, (_, i) => `m${i}`);
  const start: Selection = { keys: ["m0"], focus: "m0", anchor: "m0" };
  const r = applyGesture(start, { kind: "click", key: "m100", ctrl: false, shift: true }, many);
  assert.strictEqual(r.overLimit, true);
  assert.deepStrictEqual(r.next, start);
  const full: Selection = { keys: many.slice(0, SELECTION_LIMIT), focus: "m0", anchor: "m0" };
  const r2 = applyGesture(full, { kind: "click", key: "m120", ctrl: true, shift: false }, many);
  assert.strictEqual(r2.overLimit, true);
  assert.deepStrictEqual(r2.next, full);
  assert.strictEqual(applyGesture(start, { kind: "click", key: "m99", ctrl: false, shift: true }, many).overLimit, false);
  console.log("ok - more than 100 commits is refused");
}
{
  const s: Selection = { keys: ["k2", "k4", "k6"], focus: "k4", anchor: "k2" };
  assert.deepStrictEqual(keepListed(s, ["k2", "k6", "k9"]), { keys: ["k2", "k6"], focus: "k2", anchor: "k2" });
  assert.deepStrictEqual(keepListed(s, ["k4"]), { keys: ["k4"], focus: "k4", anchor: "k4" });
  assert.deepStrictEqual(keepListed(s, ["k9"]), { keys: [], focus: null, anchor: null });
  console.log("ok - a reload keeps the commits still listed");
}

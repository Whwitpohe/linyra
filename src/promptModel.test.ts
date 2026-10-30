import * as assert from "assert";
import { anchorOf, placePopup, promptAnswer, promptRect, type PromptRequest } from "./promptModel";

{
  assert.deepStrictEqual(promptRect({ x: 10, y: 20, w: 30, h: 22 }), { x: 10, y: 20, w: 30, h: 22 });
  assert.deepStrictEqual(promptRect({ x: 10, y: 20, w: 0, h: 0, extra: "kept out" }), { x: 10, y: 20, w: 0, h: 0 });
  for (const bad of [undefined, null, "x", { x: 1, y: 2, w: 3 }, { x: NaN, y: 2, w: 3, h: 4 }, { x: 1, y: 2, w: -3, h: 4 }, { x: "1", y: 2, w: 3, h: 4 }]) {
    assert.strictEqual(promptRect(bad), undefined, JSON.stringify(bad));
  }
  console.log("ok - a place a webview sends is four finite numbers, or nothing");
}

{
  // A right-click's point and its webview, written into the menu's context; a shortcut's element.
  assert.deepStrictEqual(anchorOf({ webviewSection: "commit", repoId: "/w/acme-web", at: [120, 340], surface: "log" }, 5), { surface: "log", at: { x: 120, y: 340, w: 0, h: 0 }, since: 5 });
  assert.deepStrictEqual(anchorOf({ surface: "log", anchor: "toolbar-update" }, 5), { surface: "log", at: "toolbar-update", since: 5 });
  for (const bad of [undefined, { repoId: "x" }, { at: [1, 2] }, { surface: "log" }, { surface: "", at: [1, 2] }, { surface: "log", at: [1] }, { surface: "log", anchor: "a b<" }]) {
    assert.strictEqual(anchorOf(bad, 5), undefined, JSON.stringify(bad));
  }
  console.log("ok - a command's argument names where to ask: a right-click's point or a shortcut's button");
}

{
  const pick: PromptRequest = { kind: "pick", title: "t", items: [{ label: "a" }, { label: "b" }], pin: "Don't ask again" };
  assert.deepStrictEqual(promptAnswer(pick, { index: 1 }), { index: 1 });
  assert.deepStrictEqual(promptAnswer(pick, { index: 0, pin: true }), { index: 0, pin: true });
  assert.deepStrictEqual(promptAnswer({ ...pick, pin: undefined }, { index: 0, pin: true }), { index: 0 }, "no pin offered: none taken");
  for (const bad of [{ index: 2 }, { index: -1 }, { index: 0.5 }, { index: "0" }, undefined, null]) assert.strictEqual(promptAnswer(pick, bad), undefined, JSON.stringify(bad));
  const many: PromptRequest = { kind: "pickMany", title: "t", items: [{ label: "a" }, { label: "b" }, { label: "c" }] };
  assert.deepStrictEqual(promptAnswer(many, { indexes: [2, 0, 2] }), { indexes: [0, 2] }, "each once, in order");
  assert.deepStrictEqual(promptAnswer(many, { indexes: [] }), { indexes: [] }, "none ticked is an answer");
  assert.strictEqual(promptAnswer(many, { indexes: [3] }), undefined);
  const input: PromptRequest = { kind: "input", title: "t", placeholder: "p" };
  assert.deepStrictEqual(promptAnswer(input, { value: "release-1.4" }), { value: "release-1.4" });
  assert.strictEqual(promptAnswer(input, { value: 3 }), undefined);
  assert.strictEqual(promptAnswer(input, { index: 0 }), undefined, "a pick's answer does not answer an input");
  assert.deepStrictEqual(promptAnswer(input, { value: "x", on: true }), { value: "x" }, "no switch asked: none taken");
  const stash: PromptRequest = { ...input, toggle: { label: "Include new files", on: false, says: ["tracked only", "every change"] } };
  assert.deepStrictEqual(promptAnswer(stash, { value: "WIP", on: true }), { value: "WIP", on: true });
  assert.deepStrictEqual(promptAnswer(stash, { value: "WIP" }), { value: "WIP", on: false }, "no state given: the switch as asked");
  assert.deepStrictEqual(promptAnswer(stash, { value: "WIP", on: "yes" }), { value: "WIP", on: false });
  console.log("ok - an answer is checked against the question it answers");
}

{
  const view = { w: 800, h: 600 };
  assert.deepStrictEqual(placePopup({ x: 100, y: 50, w: 22, h: 22 }, { w: 300, h: 120 }, view), { x: 100, y: 74, above: false }, "under the button, left edges lined up");
  assert.deepStrictEqual(placePopup({ x: 700, y: 50, w: 22, h: 22 }, { w: 300, h: 120 }, view), { x: 422, y: 74, above: false }, "near the right end: its right edge under the button's");
  assert.deepStrictEqual(placePopup({ x: 780, y: 50, w: 16, h: 22 }, { w: 300, h: 120 }, view), { x: 496, y: 74, above: false }, "past the right end even so: kept inside");
  assert.deepStrictEqual(placePopup({ x: 20, y: 50, w: 22, h: 22 }, { w: 900, h: 120 }, view), { x: 4, y: 74, above: false }, "wider than the view: from its left edge");
  assert.deepStrictEqual(placePopup({ x: 100, y: 540, w: 22, h: 22 }, { w: 300, h: 120 }, view), { x: 100, y: 418, above: true }, "no room below: above it");
  assert.deepStrictEqual(placePopup({ x: 100, y: 60, w: 0, h: 0 }, { w: 300, h: 580 }, view), { x: 100, y: 16, above: false }, "taller than the room on either side: pulled up to fit");
  console.log("ok - a popup opens under its place, inside the view, above when there is no room below");
}

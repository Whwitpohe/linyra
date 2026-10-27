import * as assert from "assert";
import { attachSplitter } from "./splitter";

class FakeSplitter extends EventTarget {
  readonly classes = new Set<string>();
  captured = false;
  classList = { add: (c: string) => this.classes.add(c), remove: (c: string) => this.classes.delete(c) };
  setPointerCapture(): void { this.captured = true; }
}
const ev = (type: string, props: Record<string, unknown> = {}) => Object.assign(new Event(type, { cancelable: true }), { button: 0, clientX: 0, pointerId: 1, key: "", ...props });

function setup() {
  const el = new FakeSplitter();
  let width = 190;
  const commits: number[] = [];
  attachSplitter(el as unknown as HTMLElement, { get: () => width, set: (w) => { width = w; }, commit: () => commits.push(width) });
  return { el, commits, width: () => width };
}

{
  const t = setup();
  t.el.dispatchEvent(ev("pointerdown", { clientX: 100 }));
  t.el.dispatchEvent(ev("pointermove", { clientX: 150 }));
  assert.strictEqual(t.width(), 240);
  t.el.dispatchEvent(ev("pointerup"));
  assert.deepStrictEqual(t.commits, [240]);
  assert.ok(!t.el.classes.has("dragging"));
  t.el.dispatchEvent(ev("pointermove", { clientX: 400 }));
  assert.strictEqual(t.width(), 240, "no resize after the drag ended");
  console.log("ok - drag resizes, pointerup saves the width once and ends the drag");
}
for (const end of ["pointercancel", "lostpointercapture"]) {
  const t = setup();
  t.el.dispatchEvent(ev("pointerdown", { clientX: 100 }));
  t.el.dispatchEvent(ev("pointermove", { clientX: 120 }));
  t.el.dispatchEvent(ev(end));
  t.el.dispatchEvent(ev("pointermove", { clientX: 400 }));
  assert.strictEqual(t.width(), 210, `${end}: a buttonless move must not keep resizing`);
  assert.ok(!t.el.classes.has("dragging"), `${end}: not stuck in dragging`);
  assert.deepStrictEqual(t.commits, [210], `${end}: the width reached is still saved`);
  console.log(`ok - ${end} ends the drag cleanly`);
}
{
  const t = setup();
  t.el.dispatchEvent(ev("pointerdown", { button: 2, clientX: 100 }));
  t.el.dispatchEvent(ev("pointermove", { clientX: 300 }));
  assert.strictEqual(t.width(), 190, "right-click does not start a drag");
  t.el.dispatchEvent(ev("pointerdown", { clientX: 100 }));
  t.el.dispatchEvent(ev("pointerdown", { clientX: 100 }));
  t.el.dispatchEvent(ev("pointermove", { clientX: 110 }));
  t.el.dispatchEvent(ev("pointerup"));
  assert.deepStrictEqual(t.commits, [200], "repeated pointerdowns do not stack listeners");
  console.log("ok - only the primary button drags; listeners never stack");
}
{
  const t = setup();
  t.el.dispatchEvent(ev("keydown", { key: "ArrowRight" }));
  t.el.dispatchEvent(ev("keydown", { key: "ArrowLeft" }));
  t.el.dispatchEvent(ev("keydown", { key: "ArrowLeft" }));
  assert.strictEqual(t.width(), 174);
  assert.deepStrictEqual(t.commits, [206, 190, 174]);
  console.log("ok - arrow keys resize in 16px steps and save");
}

{
  const el = new FakeSplitter();
  let height = 220;
  const commits: number[] = [];
  attachSplitter(el as unknown as HTMLElement, { get: () => height, set: (h) => { height = h; }, commit: () => commits.push(height) }, "y");
  el.dispatchEvent(ev("pointerdown", { clientY: 100 }));
  el.dispatchEvent(ev("pointermove", { clientX: 900, clientY: 150 }));
  assert.strictEqual(height, 270, "horizontal motion does not change a vertical split");
  el.dispatchEvent(ev("pointercancel"));
  el.dispatchEvent(ev("pointermove", { clientY: 500 }));
  assert.strictEqual(height, 270);
  el.dispatchEvent(ev("keydown", { key: "ArrowUp" }));
  el.dispatchEvent(ev("keydown", { key: "ArrowDown" }));
  el.dispatchEvent(ev("keydown", { key: "ArrowLeft" }));
  assert.deepStrictEqual(commits, [270, 254, 270]);
  console.log("ok - horizontal divider uses vertical pointer motion and Up/Down keys, including cancellation");
}

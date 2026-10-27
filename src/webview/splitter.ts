export interface SplitterWidth {
  get(): number;
  /** Apply (and clamp) a new width while dragging. */
  set(width: number): void;
  /** Save the width once the gesture is over. */
  commit(): void;
}

/**
 * The divider's drag and keyboard behavior. Every way a drag can end —
 * pointerup, pointercancel (touch/pen, the OS taking the pointer) and lost
 * capture — ends it once, so a later buttonless move can never keep resizing.
 */
export function attachSplitter(el: HTMLElement, width: SplitterWidth, axis: "x" | "y" = "x"): void {
  let drag: { startX: number; startWidth: number } | null = null;
  const end = () => {
    if (!drag) return;
    drag = null;
    el.classList.remove("dragging");
    width.commit();
  };
  el.addEventListener("pointerdown", (e) => {
    const p = e as PointerEvent;
    if (p.button !== 0) return;
    e.preventDefault();
    el.setPointerCapture(p.pointerId);
    drag = { startX: axis === "x" ? p.clientX : p.clientY, startWidth: width.get() };
    el.classList.add("dragging");
  });
  el.addEventListener("pointermove", (e) => {
    if (drag) width.set(drag.startWidth + (axis === "x" ? (e as PointerEvent).clientX : (e as PointerEvent).clientY) - drag.startX);
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) el.addEventListener(type, end);
  el.addEventListener("keydown", (e) => {
    const key = (e as KeyboardEvent).key;
    const step = key === (axis === "x" ? "ArrowLeft" : "ArrowUp") ? -16 : key === (axis === "x" ? "ArrowRight" : "ArrowDown") ? 16 : 0;
    if (!step) return;
    e.preventDefault();
    width.set(width.get() + step);
    width.commit();
  });
}

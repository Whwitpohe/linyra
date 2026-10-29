import "./menu.css";
import { h } from "../dom";

/** A menu's entry: an item (plain, or a radio or checkbox with its state), a separator, or a heading. */
export type MenuEntry =
  | { label: string; run: () => void; role?: "radio" | "check"; checked?: boolean; disabled?: boolean }
  | { separator: true }
  | { heading: string };

export interface MenuOptions {
  /** The menu's accessible name. */
  label: string;
  /** The button that opened it: aria-expanded while open, and the focus goes back to it. */
  owner?: HTMLElement;
  /** Under the anchor, its left edge (start) or its right edge (end) lined up with the anchor's. */
  align?: "start" | "end";
  /** An id for the menu element (tests and aria-controls). */
  id?: string;
}

let current: { el: HTMLElement; close: (focus: boolean) => void } | undefined;

/** Whether a menu is open (and which). */
export const openMenu = (): HTMLElement | undefined => current?.el;

/** Closes the open menu, if any. */
export const closeMenu = (focus = false): void => current?.close(focus);

/**
 * One popup menu at a time, as VS Code's own: ↑↓ Home End move, Enter or Space runs, Esc or a click
 * outside closes, and the focus goes back to the button that opened it. Under an element, or at a
 * point (a right-click). An item runs after the menu has closed, so it can move the focus itself.
 */
export function showMenu(at: HTMLElement | { x: number; y: number }, entries: readonly MenuEntry[], opts: MenuOptions): HTMLElement {
  current?.close(false);
  const el = h("div", { class: "popup-menu", role: "menu", "aria-label": opts.label, ...(opts.id ? { id: opts.id } : {}) });
  const items: HTMLButtonElement[] = [];
  for (const entry of entries) {
    if ("separator" in entry) { el.append(h("div", { class: "popup-menu-separator", role: "separator" })); continue; }
    if ("heading" in entry) { el.append(h("div", { class: "popup-menu-heading", role: "presentation" }, [entry.heading])); continue; }
    const role = entry.role === "radio" ? "menuitemradio" : entry.role === "check" ? "menuitemcheckbox" : "menuitem";
    const item = h("button", { type: "button", role, disabled: entry.disabled === true, tabindex: "-1",
      ...(entry.role ? { "aria-checked": String(entry.checked === true) } : {}) }, [entry.label]);
    item.addEventListener("click", () => { close(true); entry.run(); });
    items.push(item);
    el.append(item);
  }
  const owner = opts.owner ?? (at instanceof HTMLElement ? at : undefined);
  const enabled = () => items.filter((item) => !item.disabled);
  const move = (to: (list: HTMLButtonElement[], index: number) => number) => {
    const list = enabled();
    if (list.length === 0) return;
    list[(to(list, list.indexOf(document.activeElement as HTMLButtonElement)) + list.length) % list.length].focus();
  };
  el.addEventListener("keydown", (e) => {
    const keys: Record<string, () => void> = {
      ArrowDown: () => move((_, i) => i + 1), ArrowUp: () => move((list, i) => (i < 0 ? list.length - 1 : i - 1)),
      Home: () => move(() => 0), End: () => move((list) => list.length - 1),
      Escape: () => close(true), Tab: () => close(false),
    };
    const key = keys[e.key];
    if (!key) return;
    if (e.key !== "Tab") e.preventDefault();
    e.stopPropagation();
    key();
  });
  const outside = (e: Event) => { if (!el.contains(e.target as Node) && !(owner?.contains(e.target as Node))) close(false); };
  const away = () => close(false);
  function close(focus: boolean): void {
    if (current?.el !== el) return;
    current = undefined;
    el.remove();
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("focusin", outside);
    window.removeEventListener("resize", away);
    window.removeEventListener("blur", away);
    owner?.setAttribute("aria-expanded", "false");
    if (focus) owner?.focus();
  }
  document.body.append(el);
  current = { el, close };
  // Placed once it has a size: under the anchor (or at the point), kept inside the window.
  const box = at instanceof HTMLElement ? at.getBoundingClientRect() : { left: at.x, right: at.x, bottom: at.y, top: at.y };
  const left = at instanceof HTMLElement && opts.align === "end" ? box.right - el.offsetWidth : box.left;
  el.style.left = `${Math.max(4, Math.min(left, innerWidth - el.offsetWidth - 4))}px`;
  const below = box.bottom + 2;
  el.style.top = `${below + el.offsetHeight <= innerHeight - 4 ? below : Math.max(4, box.top - el.offsetHeight - 2)}px`;
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("focusin", outside);
  window.addEventListener("resize", away);
  window.addEventListener("blur", away);
  owner?.setAttribute("aria-expanded", "true");
  (items.find((item) => item.getAttribute("aria-checked") === "true" && !item.disabled) ?? enabled()[0])?.focus();
  return el;
}

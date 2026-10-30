// A webview's side of questions asked where the user acted (promptModel.ts): the place of the last
// click or key goes with the messages that can lead to a question, a right-click's place goes into
// the menu's context (VS Code hands it to the command), and the host's questions show here.
import { ANCHORED_MESSAGES, type PromptRect } from "../promptModel";

/** A message sent this soon after a click or a key is what the click or key did. */
const GESTURE_MS = 1000;

/** What a click is on: the button (or row, or menu item) around what was hit, not the icon inside it. */
const TARGETS = "button, [role=button], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=option], [role=tab], a, summary, .row, .repo-row";

let gesture: { el: Element; rect?: PromptRect; at: number } | undefined;

const rectOf = (el: Element): PromptRect => {
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
};

/**
 * Starts noting clicks and keys, and writes a right-click's place and this webview's name
 * (`surface`, as the host's Ask knows it) into the context of the menu VS Code opens.
 */
export function trackGestures(surface: string): void {
  // A click's place is read as it happens (a menu item is gone by the time its message goes);
  // a key's is read when a message goes, so holding ↓ in a list lays nothing out.
  window.addEventListener("pointerdown", (e) => {
    const el = (e.target as Element).closest?.(TARGETS) ?? (e.target as Element);
    gesture = { el, rect: el instanceof Element ? rectOf(el) : undefined, at: performance.now() };
  }, true);
  window.addEventListener("keydown", (e) => { gesture = { el: e.target as Element, at: performance.now() }; }, true);
  // Before VS Code's own listener (on the window, as the event bubbles): the context it reads has the place.
  window.addEventListener("contextmenu", (e) => {
    const el = (e.target as Element).closest?.<HTMLElement>("[data-vscode-context]");
    const original = el?.dataset.vscodeContext;
    if (!el || original === undefined) return;
    let context: Record<string, unknown>;
    try { context = JSON.parse(original) as Record<string, unknown>; } catch { return; }
    const placed = JSON.stringify({ ...context, at: [Math.round(e.clientX), Math.round(e.clientY)], surface });
    el.dataset.vscodeContext = placed;
    // Back as it was once VS Code has read it, unless the page has written a new one meanwhile.
    setTimeout(() => { if (el.dataset.vscodeContext === placed) el.dataset.vscodeContext = original; }, 0);
  }, true);
}

/** Where the click or key that sent this message was, when it was just now; else undefined. */
export function gesturePlace(): PromptRect | undefined {
  if (!gesture || performance.now() - gesture.at > GESTURE_MS) return undefined;
  if (gesture.rect) return gesture.rect;
  const el = gesture.el.isConnected && gesture.el !== document.body ? gesture.el : document.activeElement;
  return el && el !== document.body ? rectOf(el) : undefined;
}

/** A message, with the place of the click or key that sent it when it can lead to a question (`types`: the webview's). */
export function placed<T extends { type: string }>(m: T, types: ReadonlySet<string> = ANCHORED_MESSAGES): T {
  if (!types.has(m.type)) return m;
  const at = gesturePlace();
  return at ? { ...m, at } : m;
}

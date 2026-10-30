/**
 * A popup's ways out besides Esc, as VS Code's own menus close: a click outside it (and outside
 * what opened it), caught as the pointer goes down, before any part of the page can stop it; the
 * webview losing focus, which is all the page sees of a click anywhere else in VS Code (the editor,
 * the side bar, another panel); and the page being hidden. `open`: whether it is open now, for a
 * popup that stays in the page while closed. Returns what stops listening.
 */
export function closeOnOutside(o: { inside: () => readonly (Node | null | undefined)[]; close: () => void; open?: () => boolean }): () => void {
  const isOpen = () => o.open?.() ?? true;
  const down = (e: Event) => { if (isOpen() && !o.inside().some((n) => n?.contains(e.target as Node))) o.close(); };
  const away = () => { if (isOpen()) o.close(); };
  const hidden = () => { if (document.hidden) away(); };
  window.addEventListener("pointerdown", down, true);
  window.addEventListener("blur", away);
  document.addEventListener("visibilitychange", hidden);
  return () => {
    window.removeEventListener("pointerdown", down, true);
    window.removeEventListener("blur", away);
    document.removeEventListener("visibilitychange", hidden);
  };
}

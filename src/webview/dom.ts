type Child = Node | string | null | undefined | false;

/**
 * Element builder. Strings become text nodes, never HTML: commit subjects,
 * author names and paths are untrusted.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | undefined> = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === "style") throw new Error("set el.style properties instead; CSP forbids style attributes");
    el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

/** The dropdown arrow every picker and select in the filter bar shares (parsed once, cloned). */
const CHEVRON = (() => {
  const t = document.createElement("template");
  t.innerHTML = '<svg class="chevron" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="m4.5 6.5 3.5 3.5 3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  return t.content.firstChild as SVGElement;
})();

export function chevron(): SVGElement {
  return CHEVRON.cloneNode(true) as SVGElement;
}

export function clear(el: Element): void {
  el.replaceChildren();
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} is missing from the webview shell`);
  return el as T;
}

import { codiconElement } from "./codicons";

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

/** The dropdown arrow every picker and select in the filter bar shares. */
export function chevron(): SVGElement {
  return codiconElement("chevron-down", "chevron");
}

export function clear(el: Element): void {
  el.replaceChildren();
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} is missing from the webview shell`);
  return el as T;
}

import { fitMiddle } from "./view";

// Real text width in a given font: a canvas measures without touching layout.
const ctx = document.createElement("canvas").getContext("2d");
const cache = new Map<string, string>();

/** `name`, cut in the middle to fit `maxPx` in `font` (a CSS font shorthand). */
export function fitName(font: string, name: string, maxPx: number): string {
  if (!ctx || maxPx <= 0) return name;
  const key = `${font}|${Math.floor(maxPx)}|${name}`;
  let fitted = cache.get(key);
  if (fitted === undefined) {
    ctx.font = font;
    fitted = fitMiddle(name, (t) => ctx.measureText(t).width <= maxPx);
    if (cache.size > 2000) cache.clear();
    cache.set(key, fitted);
  }
  return fitted;
}

/** The width of "0" in `font`: CSS's ch unit, measured without touching layout. */
export function chWidth(font: string): number {
  if (!ctx) return 8;
  ctx.font = font;
  return ctx.measureText("0").width;
}

/** An element's font and horizontal padding. Read once per list, not once per row. */
export function textStyle(el: HTMLElement): { font: string; paddingX: number } {
  const s = getComputedStyle(el);
  return { font: s.font, paddingX: parseFloat(s.paddingLeft) + parseFloat(s.paddingRight) };
}

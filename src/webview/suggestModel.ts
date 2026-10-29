// Suggestions for a text box (the search box's operators and values), drawn by the webview in
// VS Code's own suggest-widget style instead of the browser's <datalist> popup. Pure: no DOM.
import type { Codicon } from "./codicons";

export interface Suggestion {
  /** What picking it puts in the box. */
  value: string;
  /** The first line, in bold. */
  label: string;
  /** The second line, in the secondary color: what an operator does, what a value means. */
  description?: string;
  /** More about a value (an author's email): matched as well as the label, and the second line when there is no description. */
  detail?: string;
  /** Dimmer, at the right of the first line: an operator's aliases, a value's kind. */
  aside?: string;
  /** At the left. */
  icon?: Codicon;
}

export interface SuggestionMatch {
  item: Suggestion;
  /** [start, end) of the query in the label, for highlighting; null when only the detail matched. */
  label: [number, number] | null;
  /** [start, end) of the query in the aside: an alias typed rather than the operator. */
  aside?: [number, number];
}

/** The help line above the rows: `text` has {0}, {1}… where each of `code` goes, drawn as code. */
export interface SuggestHint {
  text: string;
  code: readonly string[];
}

/** What the list shows for the box's text and caret: rows, a help line, or both. */
export interface SuggestionList {
  items: SuggestionMatch[];
  hint?: SuggestHint;
}

/** The hint's text and code, in order: [text, false] or [code, true]. Unknown placeholders stay text. */
export function hintParts(hint: SuggestHint): [string, boolean][] {
  const parts: [string, boolean][] = [];
  let last = 0;
  for (const m of hint.text.matchAll(/\{(\d+)\}/g)) {
    const code = hint.code[Number(m[1])];
    if (code === undefined) continue;
    const at = m.index ?? 0;
    if (at > last) parts.push([hint.text.slice(last, at), false]);
    parts.push([code, true]);
    last = at + m[0].length;
  }
  if (last < hint.text.length) parts.push([hint.text.slice(last), false]);
  return parts;
}

/**
 * The suggestions for what has been typed: a case-insensitive substring of the label or
 * the detail. Label matches come first, then detail-only ones, each in the host's order
 * (most used first). `exclude`: values already chosen.
 */
export function matchSuggestions(items: readonly Suggestion[], query: string, limit = 8, exclude: readonly string[] = []): SuggestionMatch[] {
  const q = query.trim().toLowerCase();
  const skip = new Set(exclude.map((e) => e.toLowerCase()));
  const byLabel: SuggestionMatch[] = [];
  const byDetail: SuggestionMatch[] = [];
  for (const item of items) {
    if (skip.has(item.value.toLowerCase())) continue;
    if (q === "") {
      byLabel.push({ item, label: null });
      continue;
    }
    const at = item.label.toLowerCase().indexOf(q);
    if (at >= 0) byLabel.push({ item, label: [at, at + q.length] });
    else if (item.detail?.toLowerCase().includes(q)) byDetail.push({ item, label: null });
  }
  return [...byLabel, ...byDetail].slice(0, limit);
}

export type SuggestMove = { active: number } | { pick: number } | { close: true };

/** A key in a box with its suggestions open. null: not the list's key. */
export function suggestKey(key: string, active: number, count: number): SuggestMove | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowDown": return { active: active < 0 ? 0 : (active + 1) % count };
    case "ArrowUp": return { active: active <= 0 ? count - 1 : active - 1 };
    case "Enter":
    case "Tab": return active >= 0 ? { pick: active } : null;
    case "Escape": return { close: true };
    default: return null;
  }
}

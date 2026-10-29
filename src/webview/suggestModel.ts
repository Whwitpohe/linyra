// Suggestions for a text box (the search box's operators and values), drawn by the webview in
// VS Code's own suggest-widget style instead of the browser's <datalist> popup. Pure: no DOM.

export interface Suggestion {
  /** What picking it puts in the box. */
  value: string;
  label: string;
  /** What it does, after the label (an operator's meaning). */
  description?: string;
  /** Dimmer text at the right (an email, a repo count, an operator's aliases). */
  detail?: string;
}

export interface SuggestionMatch {
  item: Suggestion;
  /** [start, end) of the query in the label, for highlighting; null when only the detail matched. */
  label: [number, number] | null;
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

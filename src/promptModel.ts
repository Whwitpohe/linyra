// Questions asked where the user acted (Ask in uncommittedActions.ts, webview/ui/prompt.ts): a
// choice or a name under the button that was clicked, or at the spot that was right-clicked, in
// place of VS Code's picker at the top of the window. Pure: shared by the host and the webviews.

/** A place in a webview, in its own CSS pixels: under it the question opens. A point is a rect of no size. */
export interface PromptRect { x: number; y: number; w: number; h: number }

/**
 * Where a question is asked: a webview (surface) and a place in it, as a rect or as the id of an
 * element there (a keyboard shortcut names its toolbar button). `since`: when it was given (ms).
 */
export interface PromptAnchor { surface: string; at: PromptRect | string; since: number }

/** A choice as VS Code's QuickPickItem words it: its label, a description beside it, a detail under it. */
export interface PromptItem { label: string; description?: string; detail?: string; picked?: boolean }

/**
 * A switch under a name's box (Stash Changes…'s Include new files): its label, its state, and the
 * line that says what the answer does in each state ([off, on]).
 */
export interface PromptToggle { label: string; on: boolean; says: [string, string] }

export type PromptRequest =
  | { kind: "pick"; title: string; items: PromptItem[]; pin?: string }
  | { kind: "pickMany"; title: string; items: PromptItem[] }
  /** `extra`: a button beside the box (✨) whose work the host does and writes into the box (promptUpdate). */
  | { kind: "input"; title: string; placeholder: string; value?: string; toggle?: PromptToggle; extra?: string };

/** An input's check, as the webview shows it under the box: its words, and whether they keep the answer from being given. */
export interface PromptCheck { message: string; blocking: boolean }

/** A pick's index (and whether its pin was clicked), a pickMany's indexes, an input's text (and its switch); undefined: cancelled. */
export type PromptAnswer = { index: number; pin?: boolean } | { indexes: number[] } | { value: string; on?: boolean } | undefined;

/** The host writing into an open name's box while its extra works: the text, busy or not, a message (null: none). */
export interface PromptUpdate { value?: string; busy?: boolean; message?: string | null }

/** Questions older than this were not what the user just did: VS Code's picker asks them. */
export const ANCHOR_TTL_MS = 30_000;

/**
 * The webview messages that can lead to a question: they alone carry the place of the click or key
 * (reading it lays the page out). Not the Repo List's or the changed files' own messages: they are
 * sent on every arrow key, and their questions come from right-click menus, which carry their place.
 */
export const ANCHORED_MESSAGES: ReadonlySet<string> = new Set(["toolbarAction", "rowAction", "branchSheet", "operation", "profileSave", "hoverAction"]);

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A rect a webview sent (untrusted): four finite numbers, a size not below zero; else undefined. */
export function promptRect(v: unknown): PromptRect | undefined {
  const r = v as Partial<PromptRect> | undefined;
  if (!r || typeof r !== "object" || !finite(r.x) || !finite(r.y) || !finite(r.w) || !finite(r.h) || r.w < 0 || r.h < 0) return undefined;
  return { x: r.x, y: r.y, w: r.w, h: r.h };
}

/**
 * The place a command's argument names: a right-click's `at: [x, y]` (the webview writes it into
 * the menu's context) or a keyboard shortcut's `anchor` (an element id), with its `surface`.
 */
export function anchorOf(arg: unknown, now: number): PromptAnchor | undefined {
  const a = arg as { at?: unknown; anchor?: unknown; surface?: unknown } | undefined;
  if (!a || typeof a !== "object" || typeof a.surface !== "string" || a.surface === "") return undefined;
  if (Array.isArray(a.at) && a.at.length === 2 && finite(a.at[0]) && finite(a.at[1])) return { surface: a.surface, at: { x: a.at[0], y: a.at[1], w: 0, h: 0 }, since: now };
  if (typeof a.anchor === "string" && /^[\w-]+$/.test(a.anchor)) return { surface: a.surface, at: a.anchor, since: now };
  return undefined;
}

/** An answer a webview sent (untrusted), checked against the question it answers. */
export function promptAnswer(req: PromptRequest, v: unknown): PromptAnswer {
  const a = v as { index?: unknown; pin?: unknown; indexes?: unknown; value?: unknown } | undefined;
  if (!a || typeof a !== "object") return undefined;
  const inRange = (i: unknown): i is number => Number.isInteger(i) && (i as number) >= 0 && (i as number) < (req.kind === "input" ? 0 : req.items.length);
  if (req.kind === "pick") return inRange(a.index) ? { index: a.index, ...(a.pin === true && req.pin ? { pin: true } : {}) } : undefined;
  if (req.kind === "pickMany") return Array.isArray(a.indexes) && a.indexes.every(inRange) ? { indexes: [...new Set(a.indexes as number[])].sort((x, y) => x - y) } : undefined;
  if (typeof a.value !== "string") return undefined;
  const on = (a as { on?: unknown }).on;
  return req.toggle ? { value: a.value, on: typeof on === "boolean" ? on : req.toggle.on } : { value: a.value };
}

/**
 * Where a popup opens for a place: under it, its left edge lined up with the place's, or its right
 * edge when the left would run it out of the view (a button at the right end); above it when there
 * is no room below. `size`: the popup's; `view`: the webview's.
 */
export function placePopup(at: PromptRect, size: { w: number; h: number }, view: { w: number; h: number }, gap = 2): { x: number; y: number; above: boolean } {
  const room = view.w - size.w - 4;
  const x = Math.max(4, at.x <= room ? at.x : Math.min(room, at.x + at.w - size.w));
  const below = at.y + at.h + gap;
  const above = below + size.h > view.h - 4 && at.y - gap - size.h >= 4;
  return { x, y: above ? at.y - gap - size.h : Math.max(4, Math.min(below, view.h - size.h - 4)), above };
}

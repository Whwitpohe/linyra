import { h } from "./dom";
import { codiconElement } from "./codicons";
import { localize } from "../i18n";
import { hintParts, suggestKey, type SuggestHint, type Suggestion, type SuggestionList, type SuggestionMatch } from "./suggestModel";

/** What a SuggestBox lists, and what picking a row does. */
export interface SuggestSource {
  /**
   * The rows and help line for the box's text and caret now (neither closes the list). force: asked
   * for with ↓ or Ctrl+Space. Return the same Suggestion objects while they hold: each one's row is
   * built once.
   */
  matches(force: boolean): SuggestionList;
  pick(item: Suggestion): void;
}

export interface SuggestOptions {
  /** The list is at least this wide, though the anchor is narrower (kept inside the window). */
  minWidth?: number;
  /** The list is at most this tall; its rows scroll inside. */
  maxHeight?: number;
}

/** Below the box, the list wants this much room before it opens above instead. */
const ROOM_BELOW = 160;
/** Between the box and the list, and between the list and the window's edges. */
const GAP = 2;
const MARGIN = 4;

interface Row {
  el: HTMLElement;
  label: HTMLElement;
  aside: HTMLElement | null;
  /** The highlight drawn now, so typing that keeps it touches nothing. */
  hit: string;
}

/**
 * A suggestion list under a text box, in VS Code's suggest-widget colors and laid out like
 * GitLens's search popup: a help line, then rows of an icon, the label in bold with its aside at
 * the right, and its description on a second line. It replaces the browser's <datalist> popup
 * (which can't be themed). The box is an ARIA combobox; the list never takes focus, so typing
 * continues while it is open. Each suggestion's row is built the first time it is listed: typing
 * filters and re-highlights rows, it does not rebuild them.
 */
export class SuggestBox {
  /** The popup: the help line above the listbox. */
  private readonly popup: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly list: HTMLElement;
  private matches: SuggestionMatch[] = [];
  /** The rows on screen, in the order of `matches`. */
  private shown: HTMLElement[] = [];
  private readonly rows = new WeakMap<Suggestion, Row>();
  private rowCount = 0;
  private hintKey = "";
  private active = -1;
  private activeRow: HTMLElement | null = null;
  private open = false;
  /** The rows were scrolled: a new set of rows starts at the top again. */
  private scrolled = false;

  constructor(
    private readonly input: HTMLInputElement,
    /** What the list lines up under (the whole search field, not just its input). */
    private readonly anchor: HTMLElement,
    private readonly source: SuggestSource,
    private readonly options: SuggestOptions = {},
  ) {
    const id = `${input.id}-suggestions`;
    this.hint = h("div", { id: `${id}-hint`, class: "suggest-hint" });
    this.hint.hidden = true;
    this.list = h("div", { id: `${id}-list`, class: "suggest-options", role: "listbox", "aria-label": localize("{0} suggestions", input.getAttribute("aria-label") ?? input.id), "aria-describedby": `${id}-hint` });
    // Both hidden until there is something in them: a help line alone has no empty list under it.
    this.list.hidden = true;
    this.popup = h("div", { id, class: "suggest" }, [this.hint, this.list]);
    this.popup.hidden = true;
    document.body.append(this.popup);
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-controls", this.list.id);
    input.setAttribute("aria-expanded", "false");
    input.addEventListener("input", () => this.show());
    input.addEventListener("blur", () => this.close());
    // Capture: the list's keys run before the box's own (Enter picks, rather than runs).
    input.addEventListener("keydown", (e) => this.onKey(e), true);
    // A press on the popup must not take focus from the box. The mouse only hovers a row, as in
    // VS Code's suggest widget: the keyboard's row stays where it is until a click picks one.
    this.popup.addEventListener("mousedown", (e) => e.preventDefault());
    this.list.addEventListener("click", (e) => {
      const row = (e.target as Element).closest<HTMLElement>(".suggest-row");
      const i = row ? this.shown.indexOf(row) : -1;
      if (i >= 0) this.pick(i);
    });
    this.list.addEventListener("scroll", () => { this.scrolled = true; }, { passive: true });
    window.addEventListener("resize", () => this.open && this.place());
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** A row is highlighted: Enter and Tab pick it. */
  get hasActive(): boolean {
    return this.open && this.active >= 0;
  }

  /**
   * The source changed (suggestions arrived from the host): refresh an open list, or open it if
   * the box asked for them while it had none to show.
   */
  refresh(): void {
    if (this.open || document.activeElement === this.input) this.show();
  }

  show(force = false): void {
    if (document.activeElement !== this.input) return this.close();
    const { items, hint } = this.source.matches(force);
    if (items.length === 0 && !hint) return this.close();
    this.matches = items;
    this.setActive(-1);
    this.renderHint(hint);
    this.render();
    // The box does not move while it is typed in: placed when the list opens and on resize.
    if (!this.open) {
      this.open = true;
      this.popup.hidden = false;
      this.input.setAttribute("aria-expanded", "true");
      this.place();
    }
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.setActive(-1);
    this.popup.hidden = true;
    this.input.setAttribute("aria-expanded", "false");
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.open) {
      if (e.key === "ArrowDown" || (e.key === " " && e.ctrlKey)) {
        e.preventDefault();
        this.show(true);
      }
      return;
    }
    const move = suggestKey(e.key, this.active, this.matches.length);
    if (!move) {
      // A help line alone still closes on Escape.
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        this.close();
      }
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    if ("active" in move) this.setActive(move.active, true);
    else if ("pick" in move) this.pick(move.pick);
    else this.close();
  }

  private pick(i: number): void {
    const m = this.matches[i];
    this.close();
    if (m) this.source.pick(m.item);
  }

  /** Only the row that was highlighted and the one that is now change. */
  private setActive(i: number, reveal = false): void {
    const row = this.shown[i] ?? null;
    this.active = row ? i : -1;
    if (row === this.activeRow) return;
    this.activeRow?.setAttribute("aria-selected", "false");
    this.activeRow = row;
    if (!row) return this.input.removeAttribute("aria-activedescendant");
    row.setAttribute("aria-selected", "true");
    this.input.setAttribute("aria-activedescendant", row.id);
    if (reveal) row.scrollIntoView({ block: "nearest" });
  }

  /** The help line, drawn again only when it says something else. */
  private renderHint(hint: SuggestHint | undefined): void {
    const key = hint ? `${hint.text}\u0000${hint.code.join("\u0000")}` : "";
    if (key === this.hintKey) return;
    this.hintKey = key;
    this.hint.hidden = !hint;
    this.hint.replaceChildren(...(hint ? hintParts(hint).map(([text, code]) => (code ? h("code", {}, [text]) : text)) : []));
  }

  private render(): void {
    const rows = this.matches.map((m) => this.row(m));
    if (rows.length === this.shown.length && rows.every((r, i) => r === this.shown[i])) return;
    this.shown = rows;
    this.list.replaceChildren(...rows);
    this.list.hidden = rows.length === 0;
    if (this.scrolled) {
      this.scrolled = false;
      this.list.scrollTop = 0;
    }
  }

  /** The match's row: built the first time its suggestion is listed, then only re-highlighted. */
  private row(m: SuggestionMatch): HTMLElement {
    let row = this.rows.get(m.item);
    if (!row) {
      row = this.build(m.item);
      this.rows.set(m.item, row);
    }
    const hit = `${m.label ?? ""}|${m.aside ?? ""}`;
    if (row.hit !== hit) {
      row.hit = hit;
      highlight(row.label, m.item.label, m.label);
      if (row.aside) highlight(row.aside, m.item.aside ?? "", m.aside ?? null);
    }
    return row.el;
  }

  private build(item: Suggestion): Row {
    const second = item.description ?? item.detail;
    const label = h("span", { class: "suggest-label" }, [item.label]);
    const aside = item.aside ? h("span", { class: "suggest-aside" }, [item.aside]) : null;
    const el = h("div", {
      class: second ? "suggest-row two-line" : "suggest-row",
      role: "option",
      id: `${this.list.id}-${this.rowCount++}`,
      "aria-selected": "false",
      // One name for a screen reader, rather than the parts run together.
      "aria-label": [item.label, second, item.aside].filter(Boolean).join(", "),
    }, [
      h("span", { class: "suggest-icon" }, [item.icon ? codiconElement(item.icon) : null]),
      h("span", { class: "suggest-text" }, [
        h("span", { class: "suggest-line" }, [label, aside]),
        second ? h("span", { class: "suggest-description" }, [second]) : null,
      ]),
    ]);
    return { el, label, aside, hit: "|" };
  }

  /**
   * Under the anchor, as wide as it (at least minWidth), kept inside the window; above it when
   * there is little room below and more above. One layout read, when the list opens.
   */
  private place(): void {
    const r = this.anchor.getBoundingClientRect();
    const s = this.popup.style;
    const width = Math.min(Math.max(r.width, this.options.minWidth ?? 240), window.innerWidth - 2 * MARGIN);
    s.width = `${width}px`;
    s.left = `${Math.max(MARGIN, Math.min(r.left, window.innerWidth - width - MARGIN))}px`;
    const below = window.innerHeight - r.bottom - GAP - MARGIN;
    const above = r.top - GAP - MARGIN;
    const up = below < ROOM_BELOW && above > below;
    this.popup.classList.toggle("above", up);
    s.top = up ? "auto" : `${r.bottom + GAP}px`;
    s.bottom = up ? `${window.innerHeight - r.top + GAP}px` : "auto";
    s.maxHeight = `${Math.max(66, Math.min(up ? above : below, this.options.maxHeight ?? Infinity))}px`;
  }
}

/** The text with its [start, end) in the highlight color. */
function highlight(el: HTMLElement, text: string, range: [number, number] | null): void {
  if (!range) return el.replaceChildren(text);
  el.replaceChildren(text.slice(0, range[0]), h("span", { class: "suggest-hit" }, [text.slice(range[0], range[1])]), text.slice(range[1]));
}

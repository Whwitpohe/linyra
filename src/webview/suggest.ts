import { clear, h } from "./dom";
import { localize } from "../i18n";
import { suggestKey, type Suggestion, type SuggestionMatch } from "./suggestModel";

/** What a SuggestBox lists, and what picking a row does. */
export interface SuggestSource {
  /** The rows for the box's text and caret now ([] closes the list). force: asked for with ↓ or Ctrl+Space. */
  matches(force: boolean): SuggestionMatch[];
  pick(item: Suggestion): void;
}

/**
 * A suggestion list under a text box, in VS Code's suggest-widget style, replacing the
 * browser's <datalist> popup (which can't be themed). The box is an ARIA combobox; the
 * list never takes focus, so typing continues while it is open.
 */
export class SuggestBox {
  private readonly list: HTMLElement;
  private matches: SuggestionMatch[] = [];
  private active = -1;
  private open = false;

  constructor(
    private readonly input: HTMLInputElement,
    /** What the list lines up under (the whole search field, not just its input). */
    private readonly anchor: HTMLElement,
    private readonly source: SuggestSource,
    private readonly options: { minWidth?: number } = {},
  ) {
    const id = `${input.id}-suggestions`;
    this.list = h("div", { id, class: "suggest", role: "listbox", "aria-label": localize("{0} suggestions", input.getAttribute("aria-label") ?? input.id) });
    this.list.hidden = true;
    document.body.append(this.list);
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-controls", id);
    input.setAttribute("aria-expanded", "false");
    input.addEventListener("input", () => this.show());
    input.addEventListener("blur", () => this.close());
    // Capture: the list's keys run before the box's own (Enter picks, rather than runs).
    input.addEventListener("keydown", (e) => this.onKey(e), true);
    // A press on the list must not take focus from the box.
    this.list.addEventListener("mousedown", (e) => e.preventDefault());
    this.list.addEventListener("click", (e) => {
      const row = (e.target as Element).closest<HTMLElement>("[data-index]");
      if (row) this.pick(Number(row.dataset.index));
    });
    this.list.addEventListener("mousemove", (e) => {
      const row = (e.target as Element).closest<HTMLElement>("[data-index]");
      if (row && Number(row.dataset.index) !== this.active) this.setActive(Number(row.dataset.index));
    });
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
    this.matches = this.source.matches(force);
    if (this.matches.length === 0) return this.close();
    this.active = -1;
    this.open = true;
    this.input.removeAttribute("aria-activedescendant");
    this.render();
    this.place();
  }

  close(): void {
    this.open = false;
    this.active = -1;
    this.list.hidden = true;
    this.input.setAttribute("aria-expanded", "false");
    this.input.removeAttribute("aria-activedescendant");
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
    if (!move) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if ("active" in move) this.setActive(move.active);
    else if ("pick" in move) this.pick(move.pick);
    else this.close();
  }

  private pick(i: number): void {
    const m = this.matches[i];
    this.close();
    if (m) this.source.pick(m.item);
  }

  private setActive(i: number): void {
    this.active = i;
    for (const row of this.list.querySelectorAll<HTMLElement>("[data-index]")) {
      row.setAttribute("aria-selected", String(Number(row.dataset.index) === i));
    }
    this.input.setAttribute("aria-activedescendant", `${this.list.id}-${i}`);
    this.list.querySelector<HTMLElement>(`[data-index="${i}"]`)?.scrollIntoView({ block: "nearest" });
  }

  private render(): void {
    clear(this.list);
    this.matches.forEach((m, i) => {
      const label = m.item.label;
      const parts = m.label
        ? [label.slice(0, m.label[0]), h("span", { class: "suggest-hit" }, [label.slice(m.label[0], m.label[1])]), label.slice(m.label[1])]
        : [label];
      this.list.append(h("div", { class: "suggest-row", role: "option", id: `${this.list.id}-${i}`, "aria-selected": "false", "data-index": String(i) }, [
        h("span", { class: "suggest-label" }, parts),
        m.item.description ? h("span", { class: "suggest-description" }, [m.item.description]) : null,
        m.item.detail ? h("span", { class: "suggest-detail" }, [m.item.detail]) : null,
      ]));
    });
    this.list.hidden = false;
    this.input.setAttribute("aria-expanded", "true");
  }

  /** Under the anchor, as wide as it (at least minWidth), kept inside the window. */
  private place(): void {
    const r = this.anchor.getBoundingClientRect();
    const width = Math.min(Math.max(r.width, this.options.minWidth ?? 240), window.innerWidth - 8);
    this.list.style.width = `${width}px`;
    this.list.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - width - 4))}px`;
    this.list.style.top = `${r.bottom + 2}px`;
    this.list.style.maxHeight = `${Math.max(66, window.innerHeight - r.bottom - 8)}px`;
  }
}

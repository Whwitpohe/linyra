import { localize } from "../../i18n";
import { closeOnOutside } from "../ui/dismiss";
import { MAX_CANDIDATES, pickerGroups, type Pair, type PickerItem } from "../../compareModel";
import { codiconElement } from "../codicons";
import { clear, h } from "../dom";

type NameItem = Extract<PickerItem, { kind: "name" }>;

/**
 * The Branch picker: a search box over Recent pairs, Default branch, Favorites, Local and Remote.
 * Each branch has a checkbox: a side may tick several, and its number says the order a repository
 * tries them (1 first); ∧ ∨ move a ticked one up or down. A Recent pair is picked at once. Ticking
 * keeps the picker open; it closes on Escape or a click outside. Filters in the page.
 */
export class BranchPicker {
  private names: { name: string; count: number }[] = [];
  private defaults: { name: string; count: number }[] = [];
  /** The names have arrived (possibly none): "Reading…" is not shown forever. */
  private loaded = false;
  private favorites: string[] = [];
  private recent: Pair[] = [];
  /** The side's ticked names, in the order a repository tries them. */
  private current: string[] = [];
  private items: PickerItem[] = [];
  private active = 0;
  private anchor: HTMLElement | undefined;

  constructor(
    private readonly root: HTMLElement,
    private readonly input: HTMLInputElement,
    private readonly list: HTMLElement,
    private readonly handlers: {
      /** A Recent pair: both sides at once. */
      pickPair(pair: Pair): void;
      /** The side's ticked names changed (ticked, unticked or moved). */
      setNames(names: string[]): void;
      favorite(name: string): void;
      /** The picker closed (Escape, a click outside, Tab). */
      closed(): void;
    },
  ) {
    input.addEventListener("input", () => {
      this.active = 0;
      this.render();
    });
    input.addEventListener("keydown", (e) => {
      const it = this.items[this.active];
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && e.altKey) {
        // Alt+↑/↓: the active ticked branch earlier or later in the order.
        e.preventDefault();
        if (it?.kind === "name" && it.order > 0) this.move(it.name, e.key === "ArrowUp" ? -1 : 1);
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        this.active = Math.max(0, Math.min(this.items.length - 1, this.active + (e.key === "ArrowDown" ? 1 : -1)));
        this.mark();
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (it) this.choose(it);
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      } else if (e.key === "Tab") {
        // Leaving the search box leaves the picker.
        this.hide();
      }
    });
    // A combobox: the search box owns the list and says which row is active.
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-controls", list.id);
    input.setAttribute("aria-autocomplete", "list");
    list.setAttribute("aria-multiselectable", "true");
    list.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the search box
    list.addEventListener("click", (e) => {
      const target = e.target as Element;
      const star = target.closest<HTMLElement>("[data-star]");
      if (star) {
        this.handlers.favorite(star.dataset.star!);
        return;
      }
      const move = target.closest<HTMLButtonElement>("[data-move]");
      if (move) {
        if (!move.disabled) this.move(move.dataset.name!, Number(move.dataset.move));
        return;
      }
      const row = target.closest<HTMLElement>("[data-i]");
      if (row) {
        this.active = Number(row.dataset.i);
        this.choose(this.items[this.active]);
      }
    });
    // A click anywhere outside it, in the page or elsewhere in VS Code, closes it (ui/dismiss.ts).
    closeOnOutside({ inside: () => [root, this.anchor], open: () => this.isOpen, close: () => this.close(false) });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  update(names: { name: string; count: number }[], favorites: string[], recent: Pair[], loaded = this.loaded, defaults = this.defaults): void {
    this.loaded = loaded;
    this.names = names;
    this.defaults = defaults;
    this.favorites = favorites;
    this.recent = recent;
    if (this.isOpen) this.render();
  }

  /** The side's names changed (from this picker or the host): the picker stays open on them. */
  setCurrent(current: string[]): void {
    this.current = current;
    if (this.isOpen) this.render();
  }

  open(anchor: HTMLElement, current: string[]): void {
    this.anchor?.setAttribute("aria-expanded", "false");
    this.anchor = anchor;
    this.current = current;
    anchor.setAttribute("aria-expanded", "true");
    this.root.hidden = false;
    this.input.value = "";
    this.active = 0;
    this.render();
    this.place(anchor);
    this.input.focus();
  }

  /** Under its box, but inside the view: a narrow or short panel never clips it. */
  private place(anchor: HTMLElement): void {
    const box = anchor.getBoundingClientRect();
    const top = box.bottom + 2;
    const width = this.root.offsetWidth;
    this.root.style.left = `${Math.max(4, Math.min(box.left, window.innerWidth - width - 4))}px`;
    this.root.style.top = `${top}px`;
    // The list scrolls inside what is left below the box.
    this.list.style.maxHeight = `${Math.max(80, window.innerHeight - top - this.input.offsetHeight - 24)}px`;
  }

  private hide(): void {
    if (!this.isOpen) return;
    this.root.hidden = true;
    this.anchor?.setAttribute("aria-expanded", "false");
    this.handlers.closed();
  }

  /** `focus`: back to its box (not when a click elsewhere closed it: that click has the focus). */
  close(focus = true): void {
    if (!this.isOpen) return;
    const anchor = this.anchor;
    this.hide();
    // Closing may have opened the other side's picker: its search box keeps the focus.
    if (focus && !this.isOpen) anchor?.focus();
  }

  /** A pair is picked at once; a branch is ticked or unticked, and the picker stays open. */
  private choose(it: PickerItem): void {
    if (it.kind === "pair") {
      this.close();
      this.handlers.pickPair(it.pair);
      return;
    }
    if (it.order > 0) this.setNames(this.current.filter((n) => n !== it.name));
    else if (this.current.length < MAX_CANDIDATES) this.setNames([...this.current, it.name]);
  }

  private move(name: string, by: number): void {
    const i = this.current.indexOf(name), j = i + by;
    if (i < 0 || j < 0 || j >= this.current.length) return;
    const next = [...this.current];
    [next[i], next[j]] = [next[j], next[i]];
    this.setNames(next);
  }

  private setNames(names: string[]): void {
    this.current = names;
    this.handlers.setNames(names);
    this.render();
  }

  private render(): void {
    const q = this.input.value;
    const groups = pickerGroups(this.names, this.favorites, this.recent, q, this.current, this.defaults);
    this.items = groups.flatMap((g) => g.items);
    this.active = Math.min(this.active, Math.max(0, this.items.length - 1));
    clear(this.list);
    if (this.items.length === 0) {
      this.list.append(h("div", { class: "picker-empty" }, [!this.loaded ? localize("Reading branch names…") : this.names.length === 0 ? localize("No branches in the ticked repositories.") : localize("No branch named \"{0}\" in any repository.", q.trim())]));
      return;
    }
    this.list.append(h("div", { class: "picker-hint", role: "presentation" }, [localize("Tick several: each repository uses the first ticked one it has (1, 2, …).")]));
    let i = 0;
    for (const g of groups) {
      this.list.append(h("div", { class: "picker-group", role: "presentation" }, [g.title]));
      for (const it of g.items) {
        this.list.append(it.kind === "pair" ? this.pairRow(it.pair, i) : this.nameRow(it, i, q));
        i++;
      }
    }
    this.mark();
  }

  private pairRow(pair: Pair, i: number): HTMLElement {
    return h("div", { class: "picker-row", role: "option", id: `pick-${i}`, "data-i": String(i) }, [
      h("span", { class: "side-mark left", "aria-hidden": "true" }, ["◀"]), h("span", { class: "branch-name" }, [pair.left.replace(/ /g, ", ")]),
      h("span", { class: "side-mark right", "aria-hidden": "true" }, ["▶"]), h("span", { class: "branch-name" }, [pair.right.replace(/ /g, ", ")]),
    ]);
  }

  private nameRow(it: NameItem, i: number, q: string): HTMLElement {
    const on = it.order > 0;
    const full = !on && this.current.length >= MAX_CANDIDATES;
    const arrow = (by: -1 | 1) => h("button", {
      class: "picker-move", type: "button", tabindex: "-1", "data-move": String(by), "data-name": it.name,
      disabled: (by < 0 ? it.order === 1 : it.order === this.current.length) ? "" : undefined,
      title: localize(by < 0 ? "Try {0} earlier (Alt+↑)" : "Try {0} later (Alt+↓)", it.name), "aria-label": localize(by < 0 ? "Try {0} earlier (Alt+↑)" : "Try {0} later (Alt+↓)", it.name),
    }, [codiconElement(by < 0 ? "chevron-up" : "chevron-down")]);
    return h("div", {
      class: `picker-row name${on ? " on" : ""}${full ? " full" : ""}`, role: "option", id: `pick-${i}`, "data-i": String(i), "aria-checked": String(on),
      title: full ? localize("At most {0} branches per side", MAX_CANDIDATES) : undefined,
    }, [
      h("span", { class: `picker-check${on ? " on" : ""}`, "aria-hidden": "true" }, on ? [codiconElement("check")] : []),
      h("span", { class: `picker-order${on ? " on" : ""}`, "aria-hidden": "true", title: on ? localize("Tried in place {0}", it.order) : undefined }, [on ? String(it.order) : "–"]),
      highlight(it.name, q),
      h("span", { class: "picker-count" }, [localize("in {0} {1}", it.count, localize(it.count === 1 ? "repository" : "repositories"))]),
      on && this.current.length > 1 ? h("span", { class: "picker-moves" }, [arrow(-1), arrow(1)]) : null,
      h("button", { class: it.favorite ? "star on" : "star", "data-star": it.name, title: it.favorite ? localize("Remove from Favorites") : localize("Add to Favorites"), "aria-label": localize("Favorite {0}", it.name), "aria-pressed": String(it.favorite), tabindex: "-1" }, ["★"]),
    ]);
  }

  private mark(): void {
    for (const el of this.list.querySelectorAll<HTMLElement>("[data-i]")) el.classList.toggle("active", Number(el.dataset.i) === this.active);
    for (const el of this.list.querySelectorAll<HTMLElement>("[data-i]")) el.setAttribute("aria-selected", String(el.classList.contains("on") || (el.dataset.i === String(this.active) && !el.classList.contains("name"))));
    const on = this.list.querySelector<HTMLElement>(`[data-i="${this.active}"]`);
    if (on) {
      this.input.setAttribute("aria-activedescendant", on.id);
      on.scrollIntoView({ block: "nearest" });
    }
  }
}

function highlight(name: string, q: string): HTMLElement {
  const i = q.trim() === "" ? -1 : name.toLowerCase().indexOf(q.trim().toLowerCase());
  if (i < 0) return h("span", { class: "branch-name" }, [name]);
  const n = q.trim().length;
  return h("span", { class: "branch-name" }, [name.slice(0, i), h("mark", {}, [name.slice(i, i + n)]), name.slice(i + n)]);
}

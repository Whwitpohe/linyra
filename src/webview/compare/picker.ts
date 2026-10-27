import { localize } from "../../i18n";
import { pickerGroups, type Pair, type PickerItem } from "../../compareModel";
import { clear, h } from "../dom";

/** The Branch picker: a search box over Recent pairs, Favorites, Local and Remote. Filters in the page. */
export class BranchPicker {
  private names: { name: string; count: number }[] = [];
  /** The names have arrived (possibly none): "Reading…" is not shown forever. */
  private loaded = false;
  private favorites: string[] = [];
  private recent: Pair[] = [];
  private items: PickerItem[] = [];
  private active = 0;
  private anchor: HTMLElement | undefined;

  constructor(
    private readonly root: HTMLElement,
    private readonly input: HTMLInputElement,
    private readonly list: HTMLElement,
    private readonly onPick: (item: PickerItem) => void,
    private readonly onFavorite: (name: string) => void,
  ) {
    input.addEventListener("input", () => {
      this.active = 0;
      this.render();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        this.active = Math.max(0, Math.min(this.items.length - 1, this.active + (e.key === "ArrowDown" ? 1 : -1)));
        this.mark();
      } else if (e.key === "Enter") {
        e.preventDefault();
        const it = this.items[this.active];
        if (it) this.choose(it);
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      } else if (e.key === "Tab") {
        // Leaving the search box leaves the picker.
        this.root.hidden = true;
        this.anchor?.setAttribute("aria-expanded", "false");
      }
    });
    // A combobox: the search box owns the list and says which row is active.
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-controls", list.id);
    input.setAttribute("aria-autocomplete", "list");
    list.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the search box
    list.addEventListener("click", (e) => {
      const star = (e.target as Element).closest<HTMLElement>("[data-star]");
      if (star) {
        this.onFavorite(star.dataset.star!);
        return;
      }
      const row = (e.target as Element).closest<HTMLElement>("[data-i]");
      if (row) this.choose(this.items[Number(row.dataset.i)]);
    });
    document.addEventListener("mousedown", (e) => {
      if (this.isOpen && !root.contains(e.target as Node) && !(this.anchor?.contains(e.target as Node) ?? false)) this.close();
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  update(names: { name: string; count: number }[], favorites: string[], recent: Pair[], loaded = this.loaded): void {
    this.loaded = loaded;
    this.names = names;
    this.favorites = favorites;
    this.recent = recent;
    if (this.isOpen) this.render();
  }

  open(anchor: HTMLElement): void {
    this.anchor?.setAttribute("aria-expanded", "false");
    this.anchor = anchor;
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

  close(): void {
    if (!this.isOpen) return;
    this.root.hidden = true;
    this.anchor?.setAttribute("aria-expanded", "false");
    this.anchor?.focus();
  }

  private choose(it: PickerItem): void {
    this.close();
    this.onPick(it);
  }

  private render(): void {
    const q = this.input.value;
    const groups = pickerGroups(this.names, this.favorites, this.recent, q);
    this.items = groups.flatMap((g) => g.items);
    clear(this.list);
    if (this.items.length === 0) {
      this.list.append(h("div", { class: "picker-empty" }, [!this.loaded ? localize("Reading branch names…") : this.names.length === 0 ? localize("No branches in the ticked repositories.") : localize("No branch named \"{0}\" in any repository.", q.trim())]));
      return;
    }
    let i = 0;
    for (const g of groups) {
      this.list.append(h("div", { class: "picker-group", role: "presentation" }, [g.title]));
      for (const it of g.items) {
        const id = `pick-${i}`;
        this.list.append(it.kind === "pair"
          ? h("div", { class: "picker-row", role: "option", id, "data-i": String(i) }, [
            h("span", { class: "side-mark left", "aria-hidden": "true" }, ["◀"]), h("span", { class: "branch-name" }, [it.pair.left]),
            h("span", { class: "side-mark right", "aria-hidden": "true" }, ["▶"]), h("span", { class: "branch-name" }, [it.pair.right]),
          ])
          : h("div", { class: "picker-row", role: "option", id, "data-i": String(i) }, [
            h("button", { class: it.favorite ? "star on" : "star", "data-star": it.name, title: it.favorite ? localize("Remove from Favorites") : localize("Add to Favorites"), "aria-label": localize("Favorite {0}", it.name), "aria-pressed": String(it.favorite), tabindex: "-1" }, ["★"]),
            highlight(it.name, q),
            h("span", { class: "picker-count" }, [localize("in {0} {1}", it.count, localize(it.count === 1 ? "repository" : "repositories"))]),
          ]));
        i++;
      }
    }
    this.mark();
  }

  private mark(): void {
    for (const el of this.list.querySelectorAll<HTMLElement>("[data-i]")) el.setAttribute("aria-selected", String(Number(el.dataset.i) === this.active));
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

import { MAX_AUTHORS, type FilterState } from "../filterModel";
import { closeOnOutside } from "./ui/dismiss";
import { localize } from "../i18n";
import type { AuthorName } from "../protocol";
import { byId, chevron, h } from "./dom";
import { PickerChips } from "./pickerChips";

/** The Author dropdown shares the branch picker's themed popup and checkbox rows. */
export class AuthorFilter {
  private readonly button = byId<HTMLButtonElement>("author");
  private readonly panel = h("div", { class: "branch-picker author-picker", id: "author-picker", role: "dialog", "aria-label": localize("Filter authors"), hidden: true });
  private readonly search = h("input", { id: "author-search", type: "search", placeholder: localize("Search authors by name or email"), "aria-label": localize("Search authors by name or email"), autocomplete: "off", spellcheck: "false" });
  private readonly list = h("div", { class: "branch-picker-list", role: "group", "aria-label": localize("Authors") });
  private readonly all = h("button", { class: "branch-picker-all", type: "button" }, [h("span", {}, [localize("All authors")])]);
  private readonly allCheck = h("input", { type: "checkbox", tabindex: "-1", "aria-hidden": "true" });
  private readonly hint = h("div", { class: "branch-picker-hint" });
  private items: readonly AuthorName[] = [];
  private selected: string[] = [];
  private mine = false;
  private loaded = false;
  private readonly chips: PickerChips;

  constructor(private readonly onChange: (authors: string[], mine: boolean) => void, private readonly onWant: () => void) {
    this.chips = new PickerChips(this.button, (name) => localize("Remove author {0}", name), (value) => {
      this.onChange(value === "\0mine" ? this.selected : this.selected.filter((name) => name !== value), value === "\0mine" ? false : this.mine);
    });
    this.all.prepend(this.allCheck);
    this.panel.append(h("div", { class: "branch-picker-search" }, [this.search]), this.all, this.list, this.hint);
    document.body.append(this.panel);
    this.button.addEventListener("click", () => this.panel.hidden ? this.open() : this.close());
    this.button.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); this.open(); }
    });
    this.all.addEventListener("click", () => { this.onChange([], false); this.search.focus(); });
    this.search.addEventListener("input", () => this.render());
    this.panel.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this.close(true); }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const inputs: HTMLElement[] = [this.search, this.all, ...this.list.querySelectorAll<HTMLInputElement>("input:not(:disabled)")];
        const current = inputs.indexOf(document.activeElement as HTMLElement);
        const next = Math.max(0, Math.min(inputs.length - 1, current + (e.key === "ArrowDown" ? 1 : -1)));
        e.preventDefault();
        inputs[next]?.focus();
      }
    });
    // A click anywhere outside it, in the page or elsewhere in VS Code, closes it (ui/dismiss.ts); so does Tab out of it.
    closeOnOutside({ inside: () => [this.panel, this.button], open: () => !this.panel.hidden, close: () => this.close() });
    document.addEventListener("focusin", (e) => {
      if (!this.panel.hidden && !this.panel.contains(e.target as Node) && !this.button.contains(e.target as Node)) this.close();
    });
    window.addEventListener("resize", () => { if (!this.panel.hidden) this.place(); });
  }

  update(filter: Pick<FilterState, "authors" | "author" | "mine">): void {
    const names = [...(filter.authors ?? []), filter.author].map((name) => name.trim()).filter(Boolean);
    this.selected = names.filter((name, i) => names.findIndex((n) => n.toLowerCase() === name.toLowerCase()) === i);
    this.mine = filter.mine;
    const labels = [...this.selected.map((value) => this.items.find((item) => item.email.toLowerCase() === value.toLowerCase())?.name ?? value), ...(this.mine ? [localize("Me")] : [])];
    const text = labels.length === 0 ? localize("All authors") : labels.length === 1 ? labels[0] : localize("{0} authors", labels.length);
    this.button.replaceChildren(h("span", { class: "branch-filter-label" }, [text]), h("span", { class: "branch-filter-arrow", "aria-hidden": "true" }, [chevron()]));
    this.button.title = labels.length ? [...this.selected, ...(this.mine ? [localize("Me")] : [])].join("\n") : localize("All authors");
    this.button.setAttribute("aria-label", localize("Filter authors: {0}", text));
    this.button.classList.toggle("filtered", labels.length > 0);
    this.chips.update([...this.selected.map((value, i) => ({ value, label: labels[i], title: value })), ...(this.mine ? [{ value: "\0mine", label: localize("Me") }] : [])]);
    this.allCheck.checked = labels.length === 0;
    this.all.setAttribute("aria-pressed", String(labels.length === 0));
    if (this.button.closest(".work")) this.close();
    if (!this.panel.hidden) this.render();
  }

  setItems(items: readonly AuthorName[]): void {
    this.loaded = true;
    this.items = items;
    this.update({ authors: this.selected, author: "", mine: this.mine });
  }

  private open(): void {
    if (this.button.closest(".work")) return;
    this.search.value = "";
    this.panel.hidden = false;
    this.button.setAttribute("aria-expanded", "true");
    this.onWant();
    this.render();
    this.search.focus();
  }

  private close(focus = false): void {
    this.panel.hidden = true;
    this.button.setAttribute("aria-expanded", "false");
    if (focus) this.button.focus();
  }

  private render(): void {
    const query = this.search.value.trim().toLowerCase();
    const chosen = new Set(this.selected.map((name) => name.toLowerCase()));
    const items = [...this.items];
    for (const name of this.selected) {
      if (!items.some((item) => item.email.toLowerCase() === name.toLowerCase())) items.unshift({ name, email: "", count: 0 });
    }
    const matches = items.filter((item) => `${item.name} ${item.email}`.toLowerCase().includes(query));
    const focused = (document.activeElement as HTMLInputElement)?.dataset.author;
    const scroll = this.list.scrollTop;
    this.list.replaceChildren(...matches.map((item) => {
      const value = item.email || item.name;
      const checkbox = h("input", { type: "checkbox", "data-author": value, "aria-label": item.email ? `${item.name} <${item.email}>` : item.name });
      checkbox.checked = chosen.has(value.toLowerCase());
      checkbox.disabled = !checkbox.checked && chosen.size >= MAX_AUTHORS;
      checkbox.addEventListener("change", () => {
        const next = checkbox.checked ? [...this.selected, value] : this.selected.filter((name) => name.toLowerCase() !== value.toLowerCase());
        this.onChange(next, this.mine);
      });
      return h("label", { class: "branch-picker-row", title: item.email ? `${item.name} <${item.email}>` : item.name }, [
        checkbox, h("span", { class: "branch-picker-name author-picker-identity" }, [
          h("span", { class: "author-picker-name" }, [item.name]),
          item.email ? h("span", { class: "author-picker-email" }, [item.email]) : null,
        ]),
        item.count ? h("span", { class: "branch-picker-count" }, [String(item.count)]) : null,
      ]);
    }));
    if (!matches.length) this.list.append(h("div", { class: "branch-picker-empty" }, [localize(this.loaded ? "No matching authors" : "Reading author names…")]));
    this.hint.textContent = chosen.size >= MAX_AUTHORS ? localize("Select up to {0} authors.", MAX_AUTHORS) : localize("Select multiple authors. Clear selection to show all.");
    if (focused) [...this.list.querySelectorAll<HTMLInputElement>("input")].find((input) => input.dataset.author === focused)?.focus();
    this.list.scrollTop = scroll;
    this.place();
  }

  private place(): void {
    const r = this.chips.bounds();
    const width = Math.min(Math.max(320, r.width), window.innerWidth - 12);
    this.panel.style.width = `${width}px`;
    this.panel.style.left = `${Math.max(6, Math.min(r.left, window.innerWidth - width - 6))}px`;
    const below = window.innerHeight - r.bottom - 8;
    const above = r.top - 8;
    const height = Math.min(390, Math.max(below, above));
    this.panel.style.maxHeight = `${Math.max(70, height)}px`;
    this.panel.style.top = `${below >= Math.min(height, 220) ? r.bottom + 3 : Math.max(4, r.top - this.panel.offsetHeight - 3)}px`;
  }
}

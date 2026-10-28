import { MAX_BRANCHES } from "../filterModel";
import { localize } from "../i18n";
import type { BranchName } from "../protocol";
import { byId, h } from "./dom";
import { PickerChips } from "./pickerChips";

/** A searchable checkbox picker. Choosing a branch keeps it open for the next choice. */
export class BranchFilter {
  private readonly button = byId<HTMLButtonElement>("branch");
  private readonly panel = h("div", { class: "branch-picker", id: "branch-picker", role: "dialog", "aria-label": localize("Filter branches"), hidden: true });
  private readonly search = h("input", { id: "branch-search", type: "search", placeholder: localize("Search branches"), "aria-label": localize("Search branches"), autocomplete: "off", spellcheck: "false" });
  private readonly list = h("div", { class: "branch-picker-list", role: "group", "aria-label": localize("Branches") });
  private readonly all = h("button", { class: "branch-picker-all", type: "button" }, [h("span", {}, [localize("All branches")])]);
  private readonly allCheck = h("input", { type: "checkbox", tabindex: "-1", "aria-hidden": "true" });
  private readonly hint = h("div", { class: "branch-picker-hint" }, [localize("Select multiple branches. Clear selection to show all.")]);
  private items: readonly BranchName[] = [];
  private selected: string[] = [];
  private loaded = false;
  private readonly chips: PickerChips;

  constructor(private readonly onChange: (branches: string[]) => void, private readonly onWant: () => void) {
    this.chips = new PickerChips(this.button, (name) => localize("Remove branch {0}", name), (name) => this.choose(this.selected.filter((branch) => branch !== name)));
    this.all.prepend(this.allCheck);
    this.panel.append(h("div", { class: "branch-picker-search" }, [this.search]), this.all, this.list, this.hint);
    document.body.append(this.panel);
    this.button.addEventListener("click", () => this.panel.hidden ? this.open() : this.close());
    this.button.addEventListener("keydown", (e) => { if (e.key === "ArrowDown") { e.preventDefault(); this.open(); } });
    this.all.addEventListener("click", () => { this.choose([]); this.search.focus(); });
    this.search.addEventListener("input", () => this.render());
    this.panel.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this.close(true); }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const inputs = [this.search, this.all, ...this.list.querySelectorAll<HTMLInputElement>('input:not(:disabled)')];
        const current = inputs.indexOf(document.activeElement as HTMLInputElement);
        const next = Math.max(0, Math.min(inputs.length - 1, current + (e.key === "ArrowDown" ? 1 : -1)));
        e.preventDefault();
        inputs[next]?.focus();
      }
    });
    document.addEventListener("pointerdown", (e) => {
      if (!this.panel.hidden && !this.panel.contains(e.target as Node) && !this.button.contains(e.target as Node)) this.close();
    });
    document.addEventListener("focusin", (e) => {
      if (!this.panel.hidden && !this.panel.contains(e.target as Node) && !this.button.contains(e.target as Node)) this.close();
    });
    document.addEventListener("visibilitychange", () => { if (document.hidden) this.close(); });
    window.addEventListener("resize", () => { if (!this.panel.hidden) this.place(); });
    this.update([]);
  }

  update(branches: readonly string[]): void {
    this.selected = [...branches];
    const text = branches.length === 0 ? localize("All branches") : branches.length === 1 ? branches[0] : localize("{0} branches", branches.length);
    this.button.replaceChildren(h("span", { class: "branch-filter-label" }, [text]), h("span", { class: "branch-filter-arrow", "aria-hidden": "true" }, ["⌄"]));
    this.button.title = branches.length ? branches.join("\n") : localize("All local and remote branches");
    this.button.setAttribute("aria-label", localize("Filter branches: {0}", text));
    this.button.classList.toggle("filtered", branches.length > 0);
    this.chips.update(branches.map((value) => ({ value, label: value })));
    this.allCheck.checked = branches.length === 0;
    this.all.setAttribute("aria-pressed", String(branches.length === 0));
    if (!this.panel.hidden) this.render();
  }

  setItems(items: readonly BranchName[]): void {
    this.loaded = true;
    this.items = items;
    if (!this.panel.hidden) this.render();
  }

  close(focus = false): void {
    this.panel.hidden = true;
    this.button.setAttribute("aria-expanded", "false");
    if (focus) this.button.focus();
  }

  private open(): void {
    if (this.button.closest(".work")) return;
    this.search.value = "";
    this.panel.hidden = false;
    this.button.setAttribute("aria-expanded", "true");
    this.onWant();
    this.render();
    this.place();
    this.search.focus();
  }

  private choose(branches: string[]): void {
    this.update(branches);
    this.onChange(branches);
  }

  private render(): void {
    const query = this.search.value.trim().toLowerCase();
    const chosen = new Set(this.selected);
    const items = [...this.items];
    for (const name of this.selected) if (!items.some((item) => item.name === name)) items.unshift({ name, count: 0 });
    const matches = items.filter((item) => item.name.toLowerCase().includes(query));
    const focused = (document.activeElement as HTMLInputElement)?.dataset.branch;
    const scroll = this.list.scrollTop;
    this.list.replaceChildren(...matches.map((item) => {
      const checkbox = h("input", { type: "checkbox", "data-branch": item.name, "aria-label": item.name });
      checkbox.checked = chosen.has(item.name);
      checkbox.disabled = !checkbox.checked && chosen.size >= MAX_BRANCHES;
      checkbox.addEventListener("change", () => {
        const next = checkbox.checked ? [...this.selected, item.name] : this.selected.filter((b) => b !== item.name);
        this.choose(next);
      });
      return h("label", { class: `branch-picker-row${checkbox.checked ? " checked" : ""}`, title: item.name }, [
        checkbox, h("span", { class: "branch-picker-name" }, [item.name]),
        item.count ? h("span", { class: "branch-picker-count" }, [item.count === 1 ? localize("1 repository") : localize("{0} repositories", item.count)]) : null,
      ]);
    }));
    if (!matches.length) this.list.append(h("div", { class: "branch-picker-empty" }, [localize(this.loaded ? "No matching branches" : "Reading branch names…")]));
    this.hint.textContent = chosen.size >= MAX_BRANCHES ? localize("Select up to {0} branches.", MAX_BRANCHES) : localize("Select multiple branches. Clear selection to show all.");
    if (focused) [...this.list.querySelectorAll<HTMLInputElement>("input")].find((input) => input.dataset.branch === focused)?.focus();
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

import type { FilterState } from "../filterModel";
import { localize } from "../i18n";
import { byId, h } from "./dom";

export class SortFilter {
  private readonly button = byId<HTMLButtonElement>("sort");
  private readonly menu = h("div", { class: "sort-menu", role: "menu", "aria-label": localize("Sort"), hidden: true });
  private readonly choices = new Map<string, HTMLButtonElement>();

  constructor(onChange: (sort: FilterState["sort"]) => void) {
    this.menu.append(h("div", { class: "sort-heading" }, [localize("Sort")]));
    for (const [value, label] of [["date", "By commit date"], ["topo", "Topological order"]]) {
      const item = h("button", { class: "sort-choice", type: "button", role: "menuitemradio", "aria-checked": "false" }, [
        h("span", { class: "sort-check", "aria-hidden": "true" }, ["✓"]), h("span", {}, [localize(label)]),
      ]);
      item.addEventListener("click", () => { onChange(value === "topo" ? "topo" : undefined); this.close(true); });
      this.choices.set(value, item);
      this.menu.append(item);
    }
    document.body.append(this.menu);
    this.button.addEventListener("click", () => {
      if (!this.menu.hidden) return this.close();
      this.menu.hidden = false;
      this.button.setAttribute("aria-expanded", "true");
      const box = this.button.getBoundingClientRect();
      this.menu.style.left = `${Math.max(4, Math.min(box.right - this.menu.offsetWidth, innerWidth - this.menu.offsetWidth - 4))}px`;
      this.menu.style.top = `${Math.max(4, Math.min(box.bottom + 3, innerHeight - this.menu.offsetHeight - 4))}px`;
      [...this.choices.values()].find((item) => item.getAttribute("aria-checked") === "true")?.focus();
    });
    this.menu.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this.close(true); }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const items = [...this.choices.values()];
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        items[(index + 1) % items.length].focus();
      }
    });
    const outside = (e: Event) => {
      if (!this.menu.hidden && !this.menu.contains(e.target as Node) && !this.button.contains(e.target as Node)) this.close();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    window.addEventListener("resize", () => this.close());
  }

  update(sort: FilterState["sort"]): void {
    for (const [key, button] of this.choices) button.setAttribute("aria-checked", String(key === (sort ?? "date")));
    this.button.title = localize("Sort: {0}", localize(sort === "topo" ? "Topological order" : "By commit date"));
    this.button.setAttribute("aria-label", this.button.title);
    const note = byId("order-note");
    note.textContent = localize(sort === "topo" ? "Incoming commits below their merge" : "Newest first by commit date");
    note.title = localize(sort === "topo" ? "Connected branch history stays together; incoming commits follow their merge, with children before parents. Separate parts are ordered by their newest commit." : "Commits in different repositories share no history, so they are merged by committer date. A rebase or a skewed clock can place a commit out of order.");
  }

  private close(focus = false): void {
    this.menu.hidden = true;
    this.button.setAttribute("aria-expanded", "false");
    if (focus) this.button.focus();
  }
}

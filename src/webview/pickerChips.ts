import { h } from "./dom";

export interface PickerSelection { value: string; label: string; title?: string }

/** Selections and their remove buttons sit beside, not inside, the dropdown button. */
export class PickerChips {
  private readonly field = h("span", { class: "picker-field" });
  private readonly chips = h("span", { class: "picker-chips", role: "list", hidden: true });
  constructor(private readonly button: HTMLButtonElement, private readonly removeLabel: (label: string) => string,
    private readonly onRemove: (value: string) => void) {
    button.before(this.field);
    this.field.append(this.chips, button);
    this.chips.addEventListener("click", (event) => {
      const target = (event.target as Element).closest<HTMLButtonElement>("[data-remove-selection]");
      if (!target || this.button.disabled) return;
      const index = [...this.chips.querySelectorAll("button")].indexOf(target);
      this.onRemove(target.dataset.removeSelection!);
      (this.chips.querySelectorAll<HTMLButtonElement>("button")[index] ?? this.button).focus();
    });
    this.chips.addEventListener("focusin", (event) => (event.target as HTMLElement).scrollIntoView({ block: "nearest", inline: "nearest" }));
  }
  update(items: readonly PickerSelection[]): void {
    this.field.classList.toggle("filtered", items.length > 0);
    this.chips.hidden = items.length === 0;
    this.chips.replaceChildren(...items.map((item) => h("span", { class: "picker-chip", role: "listitem", title: item.title ?? item.label }, [
      h("span", { class: "picker-chip-label" }, [item.label]),
      h("button", { class: "picker-chip-remove", type: "button", "data-remove-selection": item.value,
        "aria-label": this.removeLabel(item.label), title: this.removeLabel(item.label), disabled: this.button.disabled }, ["×"]),
    ])));
    const label = this.button.querySelector<HTMLElement>(".branch-filter-label");
    if (label) label.hidden = items.length > 0;
  }
  bounds(): DOMRect { return this.field.getBoundingClientRect(); }
}

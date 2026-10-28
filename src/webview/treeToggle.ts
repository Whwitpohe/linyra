import { localize } from "../i18n";
import { codicon } from "./codicons";

/** The icon and accessible name always describe the next action. */
export function updateTreeToggle(button: HTMLButtonElement, hasBranches: boolean, expanded: boolean): void {
  const action = expanded ? "collapse" : "expand";
  const label = localize(expanded ? "Collapse All" : "Expand All");
  button.disabled = !hasBranches;
  button.dataset.action = action;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-expanded", String(expanded));
  if (button.dataset.icon === action) return;
  button.dataset.icon = action;
  button.innerHTML = codicon(expanded ? "collapse-all" : "expand-all");
}

import { localize } from "../i18n";

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
  button.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4V2h9v2M5 7V5h9v7h-2M2 7h8v7H2Zm2 3.5h4' +
    (expanded ? '' : 'm-2-2.5v5') + '" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>';
}

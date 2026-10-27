import { localize } from "../i18n";
import type { ChangesLayout, ToolbarAction, ToolbarState } from "../toolbarModel";
import { byId, h } from "./dom";

const glyph = (path: string) => `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="${path}" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const icons = {
  repos: glyph("M2 3h4m3 0h5M2 7h4m3 0h5M2 11h4m3 0h5"),
  compare: glyph("M4 2v10m-2-2 2 2 2-2M12 14V4m-2 2 2-2 2 2M4 4h3m2 8h3"),
  work: glyph("M3 2h10v12H3Zm3 6 2 2 3-4"),
  fetch: glyph("M4 11a3 3 0 1 1 .4-6A4 4 0 0 1 12 5a3 3 0 0 1 1 6M8 7v7m-2-2 2 2 2-2"),
  sync: glyph("M13 5A5 5 0 0 0 3 5m0-3v3h3M3 11a5 5 0 0 0 10 0m0 3v-3h-3"),
  sideBySide: glyph("M1.5 2.5h13v11h-13Zm8 0v11"),
  stacked: glyph("M1.5 2.5h13v11h-13Zm0 6h13"),
};

export class LogToolbar {
  private state: ToolbarState = { groupByRepo: true, compareShown: false, uncommittedShown: false, fetching: false, anyBehind: false };
  private layout: ChangesLayout = "auto";
  private readonly more = byId<HTMLButtonElement>("toolbar-more");
  private readonly menu = h("div", { id: "toolbar-menu", class: "toolbar-menu", role: "menu", "aria-label": localize("Log actions"), hidden: true });

  constructor(private readonly run: (action: ToolbarAction) => void, private readonly changeLayout: (layout: ChangesLayout) => void) {
    for (const [id, action, key] of [["toolbar-repos", "toggleRepos", "repos"], ["toolbar-compare", "toggleCompare", "compare"],
      ["toolbar-uncommitted", "toggleUncommitted", "work"], ["toolbar-fetch", "fetchAll", "fetch"]] as const) {
      const button = byId<HTMLButtonElement>(id);
      button.innerHTML = icons[key];
      button.addEventListener("click", () => this.run(action));
    }
    for (const mode of ["sideBySide", "stacked"] as const) {
      const button = byId<HTMLButtonElement>(`layout-${mode}`);
      button.innerHTML = icons[mode];
      button.addEventListener("click", () => this.changeLayout(mode));
    }
    document.body.append(this.menu);
    this.more.addEventListener("click", () => this.menu.hidden ? this.open() : this.close());
    this.more.addEventListener("keydown", (e) => { if (e.key === "ArrowDown") { e.preventDefault(); this.open(); } });
    this.menu.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this.close(true); }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const buttons = [...this.menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }
    });
    const outside = (e: Event) => { if (!this.menu.hidden && !this.menu.contains(e.target as Node) && !this.more.contains(e.target as Node)) this.close(); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    window.addEventListener("resize", () => this.close());
    this.update(this.state);
  }

  update(state: ToolbarState): void {
    this.state = state;
    this.describe("toolbar-repos", localize(state.groupByRepo ? "Hide Repositories" : "Group by Repository"), state.groupByRepo);
    this.describe("toolbar-compare", localize(state.compareShown ? "Hide Compare Branches" : "Compare Branches"), state.compareShown);
    this.describe("toolbar-uncommitted", localize(state.uncommittedShown ? "Hide Uncommitted View" : "Show Uncommitted View"), state.uncommittedShown);
    this.describe("toolbar-fetch", localize(state.fetching ? "Fetching All Repositories…" : "Fetch All Repositories"));
    byId<HTMLButtonElement>("toolbar-fetch").disabled = state.fetching;
    byId("toolbar-fetch").classList.toggle("fetching", state.fetching);
    byId("toolbar-fetch").innerHTML = state.fetching ? icons.sync : icons.fetch;
    if (!this.menu.hidden) this.renderMenu();
  }

  updateLayout(layout: ChangesLayout): void {
    this.layout = layout;
    for (const mode of ["sideBySide", "stacked"] as const) byId(`layout-${mode}`).setAttribute("aria-pressed", String(mode === layout));
  }

  private describe(id: string, label: string, pressed?: boolean): void {
    const button = byId(id);
    button.title = label;
    button.setAttribute("aria-label", label);
    if (pressed !== undefined) button.setAttribute("aria-pressed", String(pressed));
  }

  private renderMenu(): void {
    const s = this.state;
    const items: [ToolbarAction, string, boolean][] = [
      ["fetchAndPullAll", localize("Fetch and Pull All"), s.fetching],
      ["pullAllBehind", localize("Pull All Repositories Behind"), !s.anyBehind || s.fetching],
      ["showBehind", localize("Show Only Repositories Behind"), !s.anyBehind],
      ["profileSwitch", localize("Switch Profile…"), false],
      ["profileSave", localize("Save Current Repositories as Profile…"), false],
      ["openChangesEditor", localize("Open Changes in Editor"), false],
    ];
    this.menu.replaceChildren(...items.map(([action, label, disabled]) => {
      const item = h("button", { type: "button", role: "menuitem", disabled }, [label]);
      item.addEventListener("click", () => { this.close(true); this.run(action); });
      return item;
    }));
    const automatic = h("button", { type: "button", role: "menuitemcheckbox", "aria-checked": String(this.layout === "auto") }, [localize("Automatic Changes Layout")]);
    automatic.addEventListener("click", () => { this.close(true); this.changeLayout("auto"); });
    this.menu.append(automatic);
  }

  private open(): void {
    this.renderMenu();
    this.menu.hidden = false;
    this.more.setAttribute("aria-expanded", "true");
    const box = this.more.getBoundingClientRect();
    this.menu.style.left = `${Math.max(4, Math.min(box.right - this.menu.offsetWidth, innerWidth - this.menu.offsetWidth - 4))}px`;
    this.menu.style.top = `${Math.max(4, Math.min(box.bottom + 3, innerHeight - this.menu.offsetHeight - 4))}px`;
    this.menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }

  private close(focus = false): void {
    this.menu.hidden = true;
    this.more.setAttribute("aria-expanded", "false");
    if (focus) this.more.focus();
  }
}

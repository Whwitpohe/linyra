import { localize } from "../i18n";
import type { ChangesLayout, ToolbarAction, ToolbarState } from "../toolbarModel";
import { byId, h } from "./dom";

const glyph = (path: string) => `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="${path}" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const icons = {
  repos: glyph("M2 3h4m3 0h5M2 7h4m3 0h5M2 11h4m3 0h5"),
  compare: glyph("M4 2v10m-2-2 2 2 2-2M12 14V4m-2 2 2-2 2 2M4 4h3m2 8h3"),
  fetch: glyph("M4 11a3 3 0 1 1 .4-6A4 4 0 0 1 12 5a3 3 0 0 1 1 6M8 7v7m-2-2 2 2 2-2"),
  sync: glyph("M13 5A5 5 0 0 0 3 5m0-3v3h3M3 11a5 5 0 0 0 10 0m0 3v-3h-3"),
  update: glyph("M8 2v8m-3-3 3 3 3-3M3 13h10"),
  push: glyph("M8 12V4m-3 3 3-3 3 3M3 14h10"),
};

/** The Log's view options (the ⋯ menu), saved by the host. */
export interface ViewOptions { highlightMine: boolean; highlightHead: boolean; hashColumn: boolean }

export class LogToolbar {
  private state: ToolbarState = { groupByRepo: true, compareShown: false, uncommittedShown: false, fetching: false, anyBehind: false };
  private layout: ChangesLayout = "auto";
  private view: ViewOptions = { highlightMine: false, highlightHead: false, hashColumn: false };
  private folds = { canCollapse: false, canExpand: false };
  private commitsShown = true;
  private readonly more = byId<HTMLButtonElement>("toolbar-more");
  private readonly menu = h("div", { id: "toolbar-menu", class: "toolbar-menu", role: "menu", "aria-label": localize("Log actions"), hidden: true });

  constructor(private readonly run: (action: ToolbarAction) => void, private readonly changeLayout: (layout: ChangesLayout) => void,
    private readonly changeView: (patch: Partial<ViewOptions> & { fold?: "collapse" | "expand" }) => void = () => undefined) {
    for (const [id, action, key] of [["toolbar-repos", "toggleRepos", "repos"], ["toolbar-compare", "toggleCompare", "compare"],
      ["toolbar-fetch", "fetchAll", "fetch"], ["toolbar-update", "updateProject", "update"], ["toolbar-push", "pushAll", "push"]] as const) {
      const button = byId<HTMLButtonElement>(id);
      button.innerHTML = icons[key];
      button.addEventListener("click", () => this.run(action));
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
    this.describe("toolbar-fetch", localize(state.fetching ? "Fetching All Repositories…" : "Fetch All Repositories"));
    byId<HTMLButtonElement>("toolbar-fetch").disabled = state.fetching;
    byId<HTMLButtonElement>("toolbar-update").disabled = state.fetching;
    byId("toolbar-fetch").classList.toggle("fetching", state.fetching);
    byId("toolbar-fetch").innerHTML = state.fetching ? icons.sync : icons.fetch;
    if (!this.menu.hidden) this.renderMenu();
  }

  /** Whether linear history can be folded or unfolded (the ⋯ menu's graph items). */
  setFolds(folds: { canCollapse: boolean; canExpand: boolean }): void {
    this.folds = folds;
    if (!this.menu.hidden) this.renderMenu();
  }

  /** The graph items apply to the Commits side only. */
  setCommitsShown(shown: boolean): void {
    this.commitsShown = shown;
  }

  updateView(view: ViewOptions): void {
    this.view = view;
    if (!this.menu.hidden) this.renderMenu();
  }

  updateLayout(layout: ChangesLayout): void {
    this.layout = layout;
    if (!this.menu.hidden) this.renderMenu();
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
      ["branchesAcross", localize("Branches Across Repositories…"), false],
      ["fetchAndPullAll", localize("Fetch and Pull All"), s.fetching],
      ["pullAllBehind", localize("Pull All Repositories Behind"), !s.anyBehind || s.fetching],
      ["showBehind", localize("Show Only Repositories Behind"), !s.anyBehind],
      ["profileSwitch", localize("Switch Profile…"), false],
      ["profileSave", localize("Save Current Repositories as Profile…"), false],
      ["toggleUncommitted", localize(s.uncommittedShown ? "Hide Uncommitted View" : "Show Uncommitted View"), false],
    ];
    this.menu.replaceChildren(...items.map(([action, label, disabled]) => {
      const item = h("button", { type: "button", role: "menuitem", disabled }, [label]);
      item.addEventListener("click", () => { this.close(true); this.run(action); });
      return item;
    }));
    // Where the changed files sit: one choice of three (they were two toolbar buttons and a menu item).
    this.menu.append(h("div", { class: "toolbar-menu-separator", role: "separator" }));
    for (const [layout, label] of [["auto", localize("Automatic Changes Layout")], ["sideBySide", localize("Side-by-side Layout")], ["stacked", localize("Stacked Layout")]] as const) {
      const item = h("button", { type: "button", role: "menuitemradio", "aria-checked": String(this.layout === layout) }, [label]);
      item.addEventListener("click", () => { this.close(true); this.changeLayout(layout); });
      this.menu.append(item);
    }
    this.menu.append(h("div", { class: "toolbar-menu-separator", role: "separator" }));
    const options = [["highlightMine", localize("Highlight My Commits")], ["highlightHead", localize("Highlight Current Branch")], ["hashColumn", localize("Show Hash Column")]] as const;
    for (const [key, label] of options) {
      const item = h("button", { type: "button", role: "menuitemcheckbox", "aria-checked": String(this.view[key]) }, [label]);
      item.addEventListener("click", () => { this.close(true); this.changeView({ [key]: !this.view[key] }); });
      this.menu.append(item);
    }
    for (const [fold, label, enabled] of [["collapse", localize("Collapse Linear Branches"), this.folds.canCollapse], ["expand", localize("Expand Linear Branches"), this.folds.canExpand]] as const) {
      const item = h("button", { type: "button", role: "menuitem", disabled: !enabled || !this.commitsShown }, [label]);
      item.addEventListener("click", () => { this.close(true); this.changeView({ fold }); });
      this.menu.append(item);
    }
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

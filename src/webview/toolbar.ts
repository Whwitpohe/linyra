import { localize } from "../i18n";
import type { ChangesLayout, ToolbarAction, ToolbarState } from "../toolbarModel";
import { codicon } from "./codicons";
import { byId, h } from "./dom";

/** VS Code's own icons for the same actions its Source Control and Git use. */
const icons = {
  repos: codicon("layout-sidebar-left"),
  compare: codicon("git-compare"),
  fetch: codicon("cloud-download"),
  sync: codicon("sync"),
  update: codicon("repo-pull"),
  push: codicon("repo-push"),
};

/** The Log's view options (the ⋯ menu), saved by the host. */
export interface ViewOptions { highlightMine: boolean; highlightHead: boolean; hashColumn: boolean }

export class LogToolbar {
  private state: ToolbarState = { groupByRepo: true, compareShown: false, fetching: false, anyBehind: false };
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

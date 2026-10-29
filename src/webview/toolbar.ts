import { localize } from "../i18n";
import type { ChangesMode } from "../changeStats";
import type { ChangesLayout, ToolbarAction, ToolbarState } from "../toolbarModel";
import { codicon } from "./codicons";
import { byId } from "./dom";
import { DEFAULT_COLUMNS, type ColumnPrefs } from "./logColumns";
import { closeMenu, openMenu, showMenu, type MenuEntry } from "./ui/menu";

/** VS Code's own icons for the same actions its Source Control and Git use. */
const icons = {
  repos: codicon("layout-sidebar-left"),
  compare: codicon("git-compare"),
  fetch: codicon("cloud-download"),
  sync: codicon("sync"),
  update: codicon("repo-pull"),
  push: codicon("repo-push"),
  ai: codicon("sparkle"),
};

/** The Log's view options (the ⋯ menu and the column header), saved by the host. */
export interface ViewOptions { highlightMine: boolean; highlightHead: boolean; hashColumn: boolean; changesColumn: ChangesMode; columns: ColumnPrefs }

/**
 * The Log header's actions and its ⋯ menu: work across repositories, profiles, AI, where the
 * changed files sit, and what the rows highlight. Each column's own options are on the column
 * header (columnHeader.ts), not here.
 */
export class LogToolbar {
  private state: ToolbarState = { groupByRepo: true, compareShown: false, fetching: false, anyBehind: false };
  private layout: ChangesLayout = "auto";
  private view: ViewOptions = { highlightMine: false, highlightHead: false, hashColumn: false, changesColumn: "bar", columns: DEFAULT_COLUMNS };
  private readonly more = byId<HTMLButtonElement>("toolbar-more");

  constructor(private readonly run: (action: ToolbarAction) => void, private readonly changeLayout: (layout: ChangesLayout) => void,
    private readonly changeView: (patch: Partial<ViewOptions>) => void = () => undefined) {
    for (const [id, action, key] of [["toolbar-repos", "toggleRepos", "repos"], ["toolbar-compare", "toggleCompare", "compare"],
      ["toolbar-fetch", "fetchAll", "fetch"], ["toolbar-update", "updateProject", "update"], ["toolbar-push", "pushAll", "push"], ["toolbar-ai", "aiAsk", "ai"]] as const) {
      const button = byId<HTMLButtonElement>(id);
      button.innerHTML = icons[key];
      button.addEventListener("click", () => this.run(action));
    }
    this.more.addEventListener("click", () => (openMenu()?.id === "toolbar-menu" ? this.reopen(false) : this.open()));
    this.more.addEventListener("keydown", (e) => { if (e.key === "ArrowDown") { e.preventDefault(); this.open(); } });
    this.update(this.state);
  }

  update(state: ToolbarState): void {
    this.state = state;
    // It shows and hides the Repo List (it groups no commits): named for what it does.
    this.describe("toolbar-repos", localize(state.groupByRepo ? "Hide Repo List" : "Show Repo List"), state.groupByRepo);
    this.describe("toolbar-compare", localize(state.compareShown ? "Hide Compare Branches" : "Compare Branches"), state.compareShown);
    this.describe("toolbar-fetch", localize(state.fetching ? "Fetching All Repositories…" : "Fetch All Repositories"));
    byId<HTMLButtonElement>("toolbar-fetch").disabled = state.fetching;
    byId<HTMLButtonElement>("toolbar-update").disabled = state.fetching;
    byId("toolbar-fetch").classList.toggle("fetching", state.fetching);
    byId("toolbar-fetch").innerHTML = state.fetching ? icons.sync : icons.fetch;
    // Ask AI…: only while AI is on (linyra.ai.enabled); Configure AI… stays in the ⋯ menu.
    byId("toolbar-ai").hidden = !state.ai;
    this.reopen(true);
  }

  updateView(view: ViewOptions): void {
    this.view = view;
    this.reopen(true);
  }

  updateLayout(layout: ChangesLayout): void {
    this.layout = layout;
    this.reopen(true);
  }

  private describe(id: string, label: string, pressed?: boolean): void {
    const button = byId(id);
    button.title = label;
    button.setAttribute("aria-label", label);
    if (pressed !== undefined) button.setAttribute("aria-pressed", String(pressed));
  }

  /** keep: the open ⋯ menu shows the state now (a fetch that ended); else it closes. Closed: nothing. */
  private reopen(keep: boolean): void {
    if (openMenu()?.id !== "toolbar-menu") return;
    if (keep) this.open(); else closeMenu(true);
  }

  private entries(): MenuEntry[] {
    const s = this.state, v = this.view;
    const action = (a: ToolbarAction, label: string, disabled = false): MenuEntry => ({ label: localize(label), disabled, run: () => this.run(a) });
    return [
      action("branchesAcross", "Branches Across Repositories…"),
      action("tagAcross", "Tag Across Repositories…"),
      action("runAcross", "Run Git Command Across Repositories…"),
      action("release", "Release…"),
      ...(s.anyOperation ? [action("abortAll", "Abort in All Repositories…")] : []),
      action("fetchAndPullAll", "Fetch and Pull All", s.fetching),
      action("pullAllBehind", "Pull All Repositories Behind", !s.anyBehind || s.fetching),
      action("showBehind", "Show Only Repositories Behind", !s.anyBehind),
      action("profileSwitch", "Switch Profile…"),
      action("profileSave", "Save Current Repositories as Profile…"),
      // AI: configure a provider, switch the model or thinking level, remove a profile.
      { separator: true },
      action("aiConfigure", "Configure AI…"),
      action("aiSwitch", "Switch AI Model…"),
      action("aiRemove", "Remove AI Profile…"),
      // Where the changed files sit: one choice of three.
      { separator: true },
      ...([["auto", "Automatic Changes Layout"], ["sideBySide", "Side-by-side Layout"], ["stacked", "Stacked Layout"]] as const).map(([layout, label]): MenuEntry =>
        ({ label: localize(label), role: "radio", checked: this.layout === layout, run: () => this.changeLayout(layout) })),
      // What the rows highlight (the columns' own options are on the column header).
      { separator: true },
      { label: localize("Highlight My Commits"), role: "check", checked: v.highlightMine, run: () => this.changeView({ highlightMine: !v.highlightMine }) },
      { label: localize("Highlight Current Branch"), role: "check", checked: v.highlightHead, run: () => this.changeView({ highlightHead: !v.highlightHead }) },
    ];
  }

  private open(): void {
    showMenu(this.more, this.entries(), { label: localize("Log actions"), owner: this.more, align: "end", id: "toolbar-menu" });
  }
}

import * as vscode from "vscode";
import { isChangesMode } from "./changeStats";
import type { MessageRoutes } from "./messageRoutes";
import type { Layout, WebviewMessage } from "./protocol";
import type { ChangesLayout } from "./toolbarModel";

export const HIDE_REPOS_KEY = "linyra.hideRepos";
const PANE_WIDTH_KEY = "linyra.repoPaneWidth";
const HIGHLIGHT_MINE_KEY = "linyra.highlightMine";
const HIGHLIGHT_HEAD_KEY = "linyra.highlightHead";
const HASH_COLUMN_KEY = "linyra.hashColumn";
const CHANGES_COLUMN_KEY = "linyra.changesColumn";
const COLUMNS_KEY = "linyra.logColumns";
const DEFAULT_PANE_WIDTH = 190;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * The Log's layout and view options, kept in globalState (the same for every workspace): the
 * panes' sizes, where the changed files sit, what the rows highlight, and the columns (the column
 * header). Saved as the webview reports them; read back into every init.
 */
export class LogLayoutStore {
  constructor(private readonly state: vscode.Memento, private readonly hooks: {
    /** Highlight Current Branch turned on or off (logView reads, or clears, the commits off HEAD). */
    highlightHead(on: boolean): void;
    /** An option the webview's other parts draw from init changed: init again. */
    changed(): void;
    /** The changed files' pane may have shown or hidden. */
    visibilityChanged(): void;
  }) {}

  register(routes: MessageRoutes): void {
    routes.on("layout", (m) => this.save(m));
  }

  layout(): Layout {
    const width = this.state.get<number>(PANE_WIDTH_KEY, DEFAULT_PANE_WIDTH);
    return {
      repoPaneWidth: finite(width) ? width : DEFAULT_PANE_WIDTH,
      groupByRepo: !this.state.get<boolean>(HIDE_REPOS_KEY, false),
      changesPaneWidth: this.state.get<number>("linyra.changesPaneWidth", 360),
      changesPaneHeight: this.state.get<number>("linyra.changesPaneHeight", 240),
      showChanges: this.state.get<boolean>("linyra.showChanges", true),
      changesLayout: this.state.get<ChangesLayout>("linyra.changesLayout", "auto"),
      highlightMine: this.state.get<boolean>(HIGHLIGHT_MINE_KEY, false),
      highlightHead: this.state.get<boolean>(HIGHLIGHT_HEAD_KEY, false),
      hashColumn: this.state.get<boolean>(HASH_COLUMN_KEY, false),
      changesColumn: ((v) => (isChangesMode(v) ? v : "bar"))(this.state.get<unknown>(CHANGES_COLUMN_KEY)),
      columns: this.state.get<Layout["columns"]>(COLUMNS_KEY),
    };
  }

  /** The Repo List shown or hidden (its toolbar toggle, Show Repositories). */
  async setReposHidden(hidden: boolean): Promise<void> {
    await this.state.update(HIDE_REPOS_KEY, hidden);
  }

  reposHidden(): boolean {
    return this.state.get<boolean>(HIDE_REPOS_KEY, false);
  }

  private async save(m: Extract<WebviewMessage, { type: "layout" }>): Promise<void> {
    const s = this.state;
    if (finite(m.repoPaneWidth)) await s.update(PANE_WIDTH_KEY, Math.round(m.repoPaneWidth));
    if (finite(m.changesPaneWidth)) await s.update("linyra.changesPaneWidth", Math.max(180, Math.min(1600, Math.round(m.changesPaneWidth))));
    if (finite(m.changesPaneHeight)) await s.update("linyra.changesPaneHeight", Math.max(96, Math.min(1200, Math.round(m.changesPaneHeight))));
    if (typeof m.showChanges === "boolean") await s.update("linyra.showChanges", m.showChanges);
    if (m.changesLayout === "auto" || m.changesLayout === "sideBySide" || m.changesLayout === "stacked") await s.update("linyra.changesLayout", m.changesLayout);
    if (typeof m.highlightMine === "boolean") await s.update(HIGHLIGHT_MINE_KEY, m.highlightMine);
    if (typeof m.hashColumn === "boolean") await s.update(HASH_COLUMN_KEY, m.hashColumn);
    if (isChangesMode(m.changesColumn)) await s.update(CHANGES_COLUMN_KEY, m.changesColumn);
    // The column header's own state: the webview applied it already, so nothing is sent back.
    if (m.columns && typeof m.columns === "object" && !Array.isArray(m.columns)) await s.update(COLUMNS_KEY, m.columns);
    if (typeof m.highlightHead === "boolean") {
      await s.update(HIGHLIGHT_HEAD_KEY, m.highlightHead);
      this.hooks.highlightHead(m.highlightHead);
    }
    if (typeof m.showChanges === "boolean" || typeof m.highlightMine === "boolean" || typeof m.highlightHead === "boolean" || typeof m.hashColumn === "boolean" || isChangesMode(m.changesColumn)) this.hooks.changed();
    this.hooks.visibilityChanged();
  }
}

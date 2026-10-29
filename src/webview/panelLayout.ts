import type { Layout, WebviewMessage } from "../protocol";
import type { ChangesLayout } from "../toolbarModel";
import { byId } from "./dom";
import { PaneWidth } from "./repoPaneModel";
import { attachSplitter } from "./splitter";

/**
 * Where the panel's parts sit: the Repo List's width, and the changed files beside the Log or
 * under it (or hidden), each divider dragged or moved with ←/→, saved by the host when the
 * gesture ends. Automatic puts the files under the Log when it would keep less than 520px.
 */
export class PanelLayout {
  changesWidth = 360;
  changesHeight = 240;
  showChanges = true;
  mode: ChangesLayout = "auto";
  private readonly app = byId("app");
  private readonly splitter = byId("splitter");
  private readonly paneWidth = new PaneWidth();
  private readonly workspace = byId("workspace");
  private readonly changesPane = byId("changes-pane");
  private readonly changesSplitter = byId("changes-splitter");
  private readonly changesVerticalSplitter = byId("changes-splitter-vertical");
  private readonly changesToggle = byId<HTMLButtonElement>("toggle-changes");

  constructor(private readonly host: { post(m: WebviewMessage): void; changed(mode: ChangesLayout): void }) {
    this.changesToggle.addEventListener("click", () => { this.showChanges = !this.showChanges; this.apply(); this.save(); });
    attachSplitter(this.changesSplitter, {
      get: () => this.changesSplitter.getBoundingClientRect().left,
      set: (left) => { this.changesWidth = Math.max(180, Math.min(this.workspace.clientWidth - left - 5, this.workspace.clientWidth - 320)); this.apply(); },
      commit: () => this.save(),
    });
    attachSplitter(this.changesVerticalSplitter, {
      get: () => this.changesVerticalSplitter.getBoundingClientRect().top,
      set: (top) => { this.changesHeight = Math.max(96, Math.min(this.workspace.clientHeight - top - 5, this.workspace.clientHeight - 160)); this.apply(); },
      commit: () => this.save(),
    }, "y");
    // The panel's width (a drag of VS Code's panel resizes this window too) decides Automatic.
    new ResizeObserver(() => this.apply()).observe(this.workspace);
    // Drag (or ←/→) the Repo List's divider; the width is saved by the host when the gesture ends.
    // A wider Repo List leaves the Log less room: Automatic decides again.
    attachSplitter(this.splitter, { get: () => this.paneWidth.shown, set: (w) => { this.setPaneWidth(w); this.apply(); }, commit: () => this.host.post({ type: "layout", repoPaneWidth: this.paneWidth.shown }) });
    window.addEventListener("resize", () => this.showPaneWidth(this.paneWidth.fit(window.innerWidth)));
  }

  /** The host's saved layout (init). */
  restore(layout: Layout): void {
    this.setPaneWidth(layout.repoPaneWidth);
    this.changesWidth = layout.changesPaneWidth ?? this.changesWidth;
    this.changesHeight = layout.changesPaneHeight ?? this.changesHeight;
    this.showChanges = layout.showChanges ?? true;
    this.mode = layout.changesLayout ?? "auto";
    this.apply();
  }

  /** Automatic, Side by Side or Stacked (the ⋯ menu). */
  setMode(mode: ChangesLayout): void {
    this.mode = mode;
    this.apply();
    this.save();
  }

  apply(): void {
    const ws = this.workspace;
    // Automatic: side by side only while the Log keeps room for its subjects (520px beside the Repo
    // List and the files); the space the Log would keep decides, not the whole panel's width.
    const repoList = byId("repo-pane").offsetWidth;
    const sideLog = ws.clientWidth - Math.max(180, Math.min(this.changesWidth, ws.clientWidth - 320)) - 5 - (repoList ? repoList + 5 : 0);
    const stacked = this.mode === "stacked" || (this.mode === "auto" && this.showChanges && sideLog < 520) || ws.clientWidth < 505;
    const size = stacked ? Math.max(96, Math.min(this.changesHeight, ws.clientHeight - 160)) : Math.max(180, Math.min(this.changesWidth, ws.clientWidth - 320));
    ws.classList.toggle("stacked", stacked);
    ws.classList.toggle("no-changes", !this.showChanges);
    ws.style.setProperty("--changes-size", `${size}px`);
    this.changesPane.hidden = !this.showChanges;
    this.changesSplitter.hidden = !this.showChanges || stacked;
    this.changesVerticalSplitter.hidden = !this.showChanges || !stacked;
    // Its icon says what it shows (the changed files), not where they sit: beside the Repo List's
    // toggle, two mirrored layout icons read as one control.
    this.changesToggle.setAttribute("aria-pressed", String(this.showChanges));
    this.changesSplitter.setAttribute("aria-valuenow", String(size));
    this.changesVerticalSplitter.setAttribute("aria-valuenow", String(size));
    this.host.changed(this.mode);
  }

  private save(): void {
    this.host.post({ type: "layout", repoPaneWidth: this.paneWidth.shown, changesPaneWidth: this.changesWidth, changesPaneHeight: this.changesHeight, showChanges: this.showChanges, changesLayout: this.mode });
  }

  private setPaneWidth(width: number): void {
    this.showPaneWidth(this.paneWidth.set(width, window.innerWidth));
  }

  private showPaneWidth(width: number): void {
    this.app.style.setProperty("--repo-pane-width", `${width}px`);
    this.splitter.setAttribute("aria-valuenow", String(width));
  }
}

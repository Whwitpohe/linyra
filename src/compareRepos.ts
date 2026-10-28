import { localize } from "./i18n";
import { randomBytes } from "crypto";
import * as vscode from "vscode";
import { COMMIT_PAGE, pairDuplicates, pushRecent, repoCounts, summaryLabel, tabTitle, validPair, type Pair } from "./compareModel";
import type { CRepoRow, CompareLayout, ReposHost, ReposWebview } from "./compareProtocol";
import { FAVORITES, MODE, modeOf, PAIR, plural, RECENT, resultOf, SHOWN, hideSameOf, type CompareMode, type Deps, type CompareSide } from "./compareView";
import { outputLog } from "./outputLog";
import { isAbortError } from "./pool";
import { renderReposHtml } from "./webview/compare/html";
import { accentOf } from "./webview/view";

/**
 * Repositories, in the Linyra Compare tab: the two Branch boxes (◀ left ▾ ⇄ ▶ right ▾) with
 * their searchable Branch picker, Files | Commits, Refresh, then the ticked repositories whose
 * files differ, in their Repo List colors. Selecting one fills the Left and Right views.
 * A webview: it needs the Branch boxes; the side views stay native trees (the file icon theme).
 */
export class CompareRepos implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = "linyra.compare";
  private view: vscode.WebviewView | undefined;
  /** Compare with…: the left branch, waiting for the right one (never read). */
  private pending: Pair | null = null;
  /** The user picked a repository: the selection stops following the first listed one. */
  private chosen = false;
  private wantPicker: "left" | "right" | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly touched = new Set<string>();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private sides: { left: CompareSide; right: CompareSide } | undefined;

  constructor(private readonly deps: Deps) {
    this.disposables.push(
      deps.store.onDidChange(() => this.changed()),
      deps.log.onDidChangeRefs((id) => this.refsMoved(id)),
      // Each repository keeps the color it has in the Log, also when the Log separates neighbors.
      deps.log.onDidChangeAccents(() => this.changed()),
    );
    void this.setContext();
    // The Linyra Compare tab is hidden until Compare Branches is clicked (remembered per workspace).
    void vscode.commands.executeCommand("setContext", "linyra.compareShown", this.state.get<boolean>(SHOWN, false));
  }

  private get state(): vscode.Memento {
    return this.deps.context.workspaceState;
  }
  get mode(): CompareMode {
    return modeOf(this.deps.context);
  }

  attachSides(sides: { left: CompareSide; right: CompareSide }): void {
    this.sides = sides;
    for (const side of ["left", "right"] as const) sides[side].attach((message) => this.post(message),
      () => this.view?.visible === true && this.sideShown(side));
  }

  private sideShown(side: "left" | "right"): boolean { return !this.state.get<boolean>(`linyra.compare.${side}Hidden`, false); }

  async setSideShown(side: "left" | "right", show: boolean, focus = false): Promise<void> {
    await this.state.update(`linyra.compare.${side}Hidden`, !show);
    if (focus) await this.show();
    this.postState();
    this.sides?.[side].visibilityChanged();
    if (focus) this.post({ type: "focusSide", side });
  }

  private layout(): CompareLayout {
    const saved = this.state.get<Partial<CompareLayout>>("linyra.compare.layout", {});
    const size = (value: unknown, fallback: number, max: number, min = 120) => typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : fallback;
    return { repositoriesWidth: size(saved.repositoriesWidth, 240, 1000, 160), leftWidth: size(saved.leftWidth, 480, 1600, 100), leftHeight: size(saved.leftHeight, 180, 1200, 80), sidesHeight: size(saved.sidesHeight, 280, 1200),
      orientation: saved.orientation === "sideBySide" || saved.orientation === "stacked" ? saved.orientation : "auto" };
  }

  toolbarChanged(): void { this.postState(); }

  resolveWebviewView(view: vscode.WebviewView): void {
    const out = vscode.Uri.joinPath(this.deps.context.extensionUri, "out");
    view.webview.options = { enableScripts: true, localResourceRoots: [out] };
    view.webview.html = renderReposHtml({
      cspSource: view.webview.cspSource,
      nonce: randomBytes(16).toString("hex"),
      scriptUri: view.webview.asWebviewUri(vscode.Uri.joinPath(out, "compare.js")).toString(),
      styleUri: view.webview.asWebviewUri(vscode.Uri.joinPath(out, "compare.css")).toString(),
    });
    view.webview.onDidReceiveMessage((m: ReposWebview) => void this.onMessage(m));
    // Hidden or collapsed: its reads stop. Shown again: the remembered pair is read again (nothing is kept).
    view.onDidChangeVisibility(() => {
      if (view.visible) void this.start(); else this.stop();
      this.sides?.left.visibilityChanged();
      this.sides?.right.visibilityChanged();
    });
    view.onDidDispose(() => {
      if (this.view !== view) return;
      this.view = undefined;
      this.stop();
    });
    this.view = view;
  }

  /** The last message of each type posted to the page (integration test seam). */
  readonly posted: Partial<Record<ReposHost["type"], ReposHost>> = {};

  private post(m: ReposHost): void {
    this.posted[m.type] = m;
    void this.view?.webview.postMessage(m);
  }

  /** Shows the Linyra Compare tab and focuses Repositories (the user asked). */
  private async show(): Promise<void> {
    if (!this.state.get<boolean>(SHOWN, false)) {
      await this.state.update(SHOWN, true);
      await vscode.commands.executeCommand("setContext", "linyra.compareShown", true);
    }
    await vscode.commands.executeCommand(`${CompareRepos.viewType}.focus`);
    this.deps.log.toolbarChanged();
  }

  /** Hides the Linyra Compare tab until Compare Branches is clicked again. */
  async close(): Promise<void> {
    await this.state.update(SHOWN, false);
    await vscode.commands.executeCommand("setContext", "linyra.compareShown", false);
    this.deps.log.toolbarChanged();
  }

  /** The repository the user picked, kept while the tab is hidden: it is picked again when listed. */
  private remembered: string | undefined;

  private stop(): void {
    if (this.chosen && this.deps.selection.repoId) this.remembered = this.deps.selection.repoId;
    this.deps.selection.set(undefined);
    void this.deps.store.setPair(null);
  }

  private starting: Promise<void> | undefined;

  /** Visibility and the page's "ready" both start it: one read, not two. */
  private start(): Promise<void> {
    this.starting ??= this.doStart().finally(() => (this.starting = undefined));
    return this.starting;
  }

  private async doStart(): Promise<void> {
    // At startup the Log's first page comes first (3 s at most when the Log is hidden).
    await Promise.race([this.deps.log.firstPage, new Promise((r) => setTimeout(r, 3000))]);
    if (this.deps.store.pair || !this.view?.visible) return;
    const saved = this.state.get<Pair>(PAIR);
    if (!this.pending && saved && validPair(saved)) await this.setPair(saved, true);
    else this.changed();
  }

  /** ⇄ Compare Branches…: shows the tab; with no pair yet, opens the Branch picker. */
  async open(): Promise<void> {
    await this.show();
    if (!this.deps.store.pair && !this.state.get<Pair>(PAIR)) this.openPicker("left");
  }

  /** Pick Branches… (Command Palette): the Branch picker on the left box. */
  async pick(): Promise<void> {
    await this.show();
    this.openPicker("left");
  }

  /** Compare with…: the Log's Branch box name on the left; the picker opens on the right. */
  async compareWith(left: string): Promise<void> {
    if (!validPair({ left, right: "x" })) return this.pick();
    await this.beginPending({ left, right: "" });
    await this.show();
    this.postState();
    this.openPicker("right");
  }

  async comparePair(pair: Pair, repoId: string): Promise<void> {
    await this.show();
    this.wantPicker = undefined;
    await this.setPair(pair);
    this.select(repoId);
  }

  /** One side known, the other not: the old comparison leaves the sides; the guidance says what to pick. */
  private async beginPending(p: Pair): Promise<void> {
    this.pending = p;
    this.deps.selection.set(undefined);
    await this.deps.store.setPair(null);
    this.postState();
    this.changed();
  }

  private openPicker(side: "left" | "right"): void {
    // A page not ready yet asks for it on "ready".
    this.wantPicker = side;
    if (this.view) this.post({ type: "openPicker", side });
  }

  async setPair(p: Pair, resume = false): Promise<void> {
    if (!validPair(p)) return;
    this.pending = null;
    // A new pair is a new comparison: what was picked under the old one is forgotten.
    if (!resume) this.remembered = undefined;
    await this.state.update(PAIR, p);
    if (p.left !== p.right) await this.state.update(RECENT, pushRecent(this.state.get<Pair[]>(RECENT, []), p));
    // The old pair's files leave the sides at once.
    this.chosen = false;
    this.deps.selection.set(undefined);
    this.postState();
    await this.deps.store.setPair(p);
    if (this.deps.store.pair?.left === p.left && this.deps.store.pair.right === p.right) await this.deps.selection.syncFile(this.deps);
  }

  async swap(): Promise<void> {
    if (!this.deps.store.pair) return;
    this.deps.store.swap();
    await this.state.update(PAIR, this.deps.store.pair);
    this.postState();
    this.changed();
    this.deps.selection.touch();
    await this.deps.selection.syncFile(this.deps);
  }

  async setMode(mode: CompareMode): Promise<void> {
    await this.state.update(MODE, mode);
    await this.setContext();
    this.postState();
    this.deps.selection.touch();
  }

  async refresh(): Promise<void> {
    await this.deps.store.refresh();
    this.deps.selection.touch();
  }

  /** Selects a repository (a click on its row, or the test seam). */
  select(repoId: string): void {
    if (!resultOf(this.deps.store, repoId)) return;
    this.chosen = true;
    this.deps.selection.set(repoId);
    this.changed();
  }

  private refsMoved(id: string | undefined): void {
    if (id === undefined) {
      this.touched.clear();
      void this.deps.store.refresh();
      return;
    }
    this.touched.add(id);
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      const ids = [...this.touched];
      this.touched.clear();
      for (const x of ids) void this.deps.store.refresh(x);
    }, 400);
  }

  private async setContext(): Promise<void> {
    await vscode.commands.executeCommand("setContext", "linyra.compareMode", this.mode);
  }

  private pairShown(): Pair | null {
    return this.pending ?? this.deps.store.pair ?? this.state.get<Pair>(PAIR) ?? null;
  }

  private message(): string | undefined {
    const pair = this.pairShown();
    if (!pair || !pair.left) return localize("Pick the branch to merge from (◀) and the branch it goes into (▶).");
    if (!pair.right) return localize("Pick the branch {0} goes into (▶).", pair.left);
    if (pair.left === pair.right) return localize("Pick two different branches. Both sides are {0}.", pair.left);
    if (this.deps.log.tickedRepos().length === 0) return localize("No repositories are ticked in the Repo List.");
    return undefined;
  }

  private postState(): void {
    const pair = this.pairShown();
    if (this.view) this.view.description = tabTitle(pair);
    this.post({ type: "state", pair, mode: this.mode, recent: this.state.get<Pair[]>(RECENT, []), favorites: this.state.get<string[]>(FAVORITES, []), message: this.message(),
      hideSame: hideSameOf(this.deps.context), showLeft: this.sideShown("left"), showRight: this.sideShown("right"), layout: this.layout() });
    void this.setContext();
  }

  private listed() {
    return this.deps.store.results().filter((x) => x.result.kind !== "identical" && x.result.kind !== "missing");
  }

  private summary(): string {
    const ticked = this.deps.log.tickedRepos().length;
    const results = this.deps.store.results();
    return this.deps.store.reading ? localize("Reading {0}… {1}", plural(ticked, "repository", "repositories"), results.length > 0 ? summaryLabel(results.map((x) => x.result), ticked) : "").trim()
      : summaryLabel(results.map((x) => x.result), ticked);
  }

  private rows(): CRepoRow[] {
    const listed = this.listed();
    // The Log's colors: hues assigned over only the listed repositories would differ from it.
    const accents = this.deps.log.accents();
    return listed.map(({ repo, result }): CRepoRow => ({
      repoId: repo.id, name: repo.name, accent: accentOf(accents, repo.id), status: result.kind === "differs" ? "differs" : result.kind === "nobase" ? "nobase" : "error",
      left: result.kind === "differs" ? result.left : 0, right: result.kind === "differs" ? result.right : 0, same: result.kind === "differs" ? result.sameLeft : 0,
      reason: result.kind === "error" ? result.reason : undefined, behind: this.deps.log.upstream.isBehind(repo.id),
    }));
  }

  private changed(): void {
    const pair = this.deps.store.pair;
    const listed = this.listed();
    // Until the user picks one, the selection is the first listed repository (repositories answer
    // in any order). A side whose repository's branches moved reads again on its own (its key changed).
    // Shown again: the repository the user had picked, once it is listed.
    if (!this.chosen && this.remembered && listed.some((x) => x.repo.id === this.remembered)) {
      this.chosen = true;
      this.deps.selection.set(this.remembered);
      this.remembered = undefined;
    }
    const sel = this.deps.selection.repoId;
    if (pair && pair.left !== pair.right && (!this.chosen || !sel || !listed.some((x) => x.repo.id === sel))) {
      if (sel && !listed.some((x) => x.repo.id === sel)) this.chosen = false;
      this.deps.selection.set(listed[0]?.repo.id, true);
    }
    if (this.view) this.view.description = tabTitle(this.pairShown());
    const rows = this.rows();
    const results = this.deps.store.results();
    const shown = this.pairShown();
    // "The same files" only once this pair's read is done and found identical repositories.
    const done = pair !== null && shown !== null && pair.left === shown.left && pair.right === shown.right && !this.deps.store.reading;
    const empty = rows.length > 0 ? undefined
      : !done ? (pair ? localize("Reading…") : undefined)
      : results.some((x) => x.result.kind === "identical") ? localize("{0} and {1} have the same files in every repository.", pair.left, pair.right)
      : results.length > 0 ? localize("None of the ticked repositories has both {0} and {1}.", pair.left, pair.right) : undefined;
    this.post({
      type: "repos", reading: this.deps.store.reading, summary: pair && pair.left !== pair.right ? this.summary() : "", rows,
      missing: results.filter((x) => x.result.kind === "missing").map((x) => x.repo.name), selected: this.deps.selection.repoId,
      message: this.message(), empty, pairKey: pair ? `${pair.left}\0${pair.right}` : "",
    });
    void this.setContext();
  }

  async onMessage(m: ReposWebview): Promise<void> {
    try {
      switch (m?.type) {
        case "sideReady":
          this.sides?.left.visibilityChanged();
          this.sides?.right.visibilityChanged();
          return;
        case "sideOpen": case "sideExpand":
          if ((m.side === "left" || m.side === "right") && typeof m.id === "string") {
            if (m.type === "sideOpen") await this.sides?.[m.side].openNode(m.id);
            else await this.sides?.[m.side].expandNode(m.id);
          }
          return;
        case "sideExpandAll":
          if (m.side === "left" || m.side === "right") await this.sides?.[m.side].expandAll();
          return;
        case "sideVisibility":
          if ((m.side === "left" || m.side === "right") && typeof m.show === "boolean") await this.setSideShown(m.side, m.show);
          return;
        case "hideSame":
          if (typeof m.hide === "boolean") await vscode.commands.executeCommand(m.hide ? "linyra.compareHideSame" : "linyra.compareShowSame");
          return;
        case "layout": {
          const layout = m.layout;
          if (!layout || (layout.orientation !== "auto" && layout.orientation !== "sideBySide" && layout.orientation !== "stacked")) return;
          if (![layout.repositoriesWidth, layout.leftWidth, layout.leftHeight, layout.sidesHeight].every((value) => typeof value === "number" && Number.isFinite(value))) return;
          await this.state.update("linyra.compare.layout", layout);
          return;
        }
        case "ready":
          this.postState();
          this.changed();
          // Pick Branches… asked before the page was ready: open the picker now, not after the read.
          if (this.wantPicker) this.post({ type: "openPicker", side: this.wantPicker });
          await this.start();
          return;
        case "pick":
          if (validPair(m.pair)) await this.setPair(m.pair);
          return;
        case "pending": {
          const p = m.pair as Partial<Pair> | undefined;
          const ok = (n: unknown) => n === "" || validPair({ left: n, right: "x" });
          if (p && typeof p.left === "string" && typeof p.right === "string" && ok(p.left) && ok(p.right) && (p.left === "") !== (p.right === "")) await this.beginPending({ left: p.left, right: p.right });
          return;
        }
        case "swap":
          return this.swap();
        case "mode":
          if (m.mode === "files" || m.mode === "commits") await this.setMode(m.mode);
          return;
        case "refresh":
          return this.refresh();
        case "select":
          if (typeof m.repoId === "string") this.select(m.repoId);
          return;
        case "favorite": {
          if (typeof m.name !== "string") return;
          const favs = new Set(this.state.get<string[]>(FAVORITES, []));
          if (favs.has(m.name)) favs.delete(m.name);
          else favs.add(m.name);
          await this.state.update(FAVORITES, [...favs]);
          this.postState();
          return;
        }
        case "wantBranches": {
          this.wantPicker = undefined;
          const names = await this.deps.store.readBranches();
          this.post({ type: "branches", names, remotes: this.deps.store.remoteNames });
          return;
        }
        case "wantDups": {
          if (typeof m.repoId !== "string") return;
          const repoId = m.repoId;
          // Always answered (an empty list if the read fails or is aborted): the page never waits forever.
          let items: ReturnType<typeof pairDuplicates> = [];
          if (resultOf(this.deps.store, repoId)) {
            try {
              // Every commit of each side (only + on both): the list matches the = count git reports.
              const c = resultOf(this.deps.store, repoId)!.result;
              const [nl, nr] = c.kind === "differs" ? [c.left + c.sameLeft, c.right + c.sameRight] : [COMMIT_PAGE, COMMIT_PAGE];
              const [l, r] = await Promise.all([this.deps.store.readCommits(repoId, "left", Math.max(1, nl)), this.deps.store.readCommits(repoId, "right", Math.max(1, nr))]);
              items = pairDuplicates(l.filter((c) => c.mark === "="), r.filter((c) => c.mark === "="));
            } catch {
              items = [];
            }
          }
          this.post({ type: "dups", repoId, items });
          return;
        }
      }
    } catch (e) {
      if (!isAbortError(e)) outputLog().error(localize("Linyra: Compare"), e instanceof Error ? e : String(e));
    }
  }

  async snapshot(): Promise<{ open: boolean; description: string; message: string | undefined; pair: Pair | null; mode: CompareMode; roots: string[]; selected: string | undefined; accents: number[] }> {
    const rows = this.rows();
    const results = new Map(this.deps.store.results().map((x) => [x.repo.id, x.result]));
    const pair = this.deps.store.pair;
    return {
      open: this.view?.visible === true, description: tabTitle(this.pairShown()),
      message: this.message() ?? (pair && pair.left !== pair.right ? this.summary() : undefined), pair, mode: this.mode,
      // What a row shows: its name, or why it cannot be compared.
      roots: rows.map((r) => (r.status === "differs" ? r.name : `${r.name} | ${repoCounts(results.get(r.repoId)!)}`)), selected: this.deps.selection.repoId, accents: rows.map((r) => r.accent),
    };
  }

  dispose(): void {
    clearTimeout(this.refreshTimer);
    for (const d of this.disposables) d.dispose();
  }
}

import { localize } from "./i18n";
import { randomBytes } from "crypto";
import * as vscode from "vscode";
import { copyText } from "./clipboard";
import { candidates, COMMIT_PAGE, conflictNote, isGroupSelection, manyRepos, MANY_PREFIX, mergeSkips, selectionIds, pairDuplicates, pushRecent, releaseNotes, repoCounts, sideLabel, summaryLabel, tabTitle, validPair, type MergeSkip, type Pair } from "./compareModel";
import { COMPARE_PROMPT_MESSAGES, type CRepoRow, type CompareLayout, type ReposHost, type ReposWebview } from "./compareProtocol";
import { PromptPort } from "./promptPort";
import type { CompareStore } from "./compareStore";
import { ALL_REPOS, differing, FAVORITES, groupOf, MODE, modeOf, ONLY_CONFLICTS as ONLY_CONFLICTS_KEY, onlyConflictsOf, PAIR, plural, RECENT, resultOf, SHOWN, hideSameOf, short, shortSide, type CompareMode, type Deps, type CompareSide } from "./compareView";
import { outputLog } from "./outputLog";
import { isAbortError, runPool } from "./pool";
import type { Repo } from "./types";
import { gitMessage, type Ask } from "./uncommittedActions";
import type { MultiResult } from "./multiRepo";
import { checkValue, listValue, textValue } from "./formModel";
import { parseUpstream, releasePushArgs, releaseReport, releaseSpec, releaseTagArgs, tagMessage } from "./releaseModel";
import { sameFolder } from "./folders";

/** What Compare needs beyond the side views' deps: the merge across repositories (Branches Across Repositories' machinery). */
export interface ReposDeps extends Deps {
  ask: Ask;
  /** Runs each plan's merge, with progress, the repositories' refresh and one report; `skipped` joins the report. */
  mergeEach(title: string, plans: { repo: Repo; merge: () => Promise<unknown> }[], skipped: { name: string; reason: string; failed?: boolean }[], opts?: { quiet?: boolean }): Promise<MultiResult | undefined>;
  /** `git merge` of a ref into the repository's checked-out branch. */
  mergeRef(repo: Repo, ref: string): Promise<unknown>;
}
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

  constructor(private readonly deps: ReposDeps) {
    this.disposables.push(
      deps.store.onDidChange(() => this.changed()),
      deps.log.onDidChangeRefs((id) => this.refsMoved(id)),
      // Each repository keeps the color it has in the Log, also when the Log separates neighbors.
      deps.log.onDidChangeAccents(() => this.changed()),
      // Merge ◀ into ▶…'s checklist is asked in the tab, under its button (promptPort.ts).
      deps.ask.addSurface("compare", this.prompts),
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
      this.viewReady = false;
      this.prompts.cancel();
      this.stop();
    });
    this.view = view;
  }

  /** Merge ◀ into ▶…'s checklist, asked in the tab under its button (Ask's "compare" surface). */
  readonly prompts = new PromptPort("compare", (m) => this.post(m), () => this.view?.visible === true && this.viewReady);
  private viewReady = false;

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

  /**
   * Selects a repository (a click on its row, or the test seam); All repositories when two or more
   * differ; or several picked together (Ctrl/Shift-click), in Repo List order. Picked ones that do
   * not differ are dropped: one left is that one alone.
   */
  select(repoId: string): void {
    if (repoId.startsWith(MANY_PREFIX)) {
      const picked = new Set(selectionIds(repoId) as string[]);
      const ids = differing(this.deps.store).map((x) => x.repo.id).filter((id) => picked.has(id));
      if (ids.length === 0) return;
      repoId = manyRepos(ids);
    }
    if (repoId === ALL_REPOS ? differing(this.deps.store).length < 2 : !repoId.startsWith(MANY_PREFIX) && !resultOf(this.deps.store, repoId)) return;
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
    if (!pair.right) return localize("Pick the branch {0} goes into (▶).", sideLabel(pair.left));
    if (pair.left === pair.right) return localize("Pick two different branches. Both sides are {0}.", sideLabel(pair.left));
    if (this.deps.log.tickedRepos().length === 0) return localize("No repositories are ticked in the Repo List.");
    return undefined;
  }

  private postState(): void {
    const pair = this.pairShown();
    if (this.view) this.view.description = tabTitle(pair);
    this.post({ type: "state", pair, mode: this.mode, recent: this.state.get<Pair[]>(RECENT, []), favorites: this.state.get<string[]>(FAVORITES, []), message: this.message(),
      hideSame: hideSameOf(this.deps.context), onlyConflicts: onlyConflictsOf(this.deps.context), showLeft: this.sideShown("left"), showRight: this.sideShown("right"), layout: this.layout() });
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
    // A side with several names: each row says which ones this repository uses.
    const pair = this.deps.store.pair;
    const several = !!pair && (candidates(pair.left).length > 1 || candidates(pair.right).length > 1);
    return listed.map(({ repo, result }): CRepoRow => ({
      repoId: repo.id, name: repo.name, accent: accentOf(accents, repo.id), status: result.kind === "differs" ? "differs" : result.kind === "nobase" ? "nobase" : "error",
      left: result.kind === "differs" ? result.left : 0, right: result.kind === "differs" ? result.right : 0, same: result.kind === "differs" ? result.sameLeft : 0,
      reason: result.kind === "error" ? result.reason : undefined, behind: this.deps.log.upstream.isBehind(repo.id),
      conflicts: result.kind === "differs" ? (result.conflicts === undefined ? undefined : result.conflicts ? result.conflicts.length : null) : null,
      ...(several && result.kind === "differs" ? { names: `${short(result.leftName)} → ${short(result.rightName)}` } : {}),
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
    // All repositories stays chosen while two or more differ.
    const valid = (id: string) => (isGroupSelection(id) ? groupOf(this.deps.store, id).length >= (id === ALL_REPOS ? 2 : 1) : listed.some((x) => x.repo.id === id));
    if (pair && pair.left !== pair.right && (!this.chosen || !sel || !valid(sel))) {
      if (sel && !valid(sel)) this.chosen = false;
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
      : results.some((x) => x.result.kind === "identical") ? localize("{0} and {1} have the same files in every repository.", sideLabel(pair.left), sideLabel(pair.right))
      : results.length > 0 ? localize("None of the ticked repositories has both {0} and {1}.", sideLabel(pair.left), sideLabel(pair.right)) : undefined;
    this.post({
      type: "repos", reading: this.deps.store.reading, summary: pair && pair.left !== pair.right ? this.summary() : "", rows,
      missing: results.filter((x) => x.result.kind === "missing").map((x) => x.repo.name), selected: this.deps.selection.repoId,
      message: this.message(), empty, pairKey: pair ? `${pair.left}\0${pair.right}` : "",
    });
    void this.setContext();
  }

  async onMessage(m: ReposWebview): Promise<void> {
    // Sent right after a click or a key there: its question is asked at that place (Ask.withAnchor).
    await this.deps.ask.withAnchor(m && COMPARE_PROMPT_MESSAGES.has(m.type) ? this.prompts.anchorOf(m) : undefined, () => this.handle(m));
  }

  private async handle(m: ReposWebview): Promise<void> {
    try {
      switch (m?.type) {
        case "promptAnswer": this.prompts.answered(m.id, m.answer); return;
        case "promptInput": this.prompts.typed(m.id, m.value); return;
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
        case "onlyConflicts":
          if (typeof m.on === "boolean") await this.setOnlyConflicts(m.on);
          return;
        case "sideSelect":
          if ((m.side === "left" || m.side === "right") && Array.isArray(m.ids)) this.sides?.[m.side].select(m.ids);
          return;
        case "merge":
          await this.mergeIntoRight();
          return;
        case "releaseNotes":
          await this.copyReleaseNotes();
          return;
        case "layout": {
          const layout = m.layout;
          if (!layout || (layout.orientation !== "auto" && layout.orientation !== "sideBySide" && layout.orientation !== "stacked")) return;
          if (![layout.repositoriesWidth, layout.leftWidth, layout.leftHeight, layout.sidesHeight].every((value) => typeof value === "number" && Number.isFinite(value))) return;
          await this.state.update("linyra.compare.layout", layout);
          return;
        }
        case "ready":
          this.prompts.cancel();
          this.viewReady = true;
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
          this.post({ type: "branches", names, remotes: this.deps.store.remoteNames, defaults: this.deps.store.defaultBranches });
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

  /** Only Conflicts: Files mode lists only the files a merge would leave conflicted. */
  async setOnlyConflicts(on: boolean): Promise<void> {
    await this.deps.context.globalState.update(ONLY_CONFLICTS_KEY, on);
    this.postState();
    this.sides?.left.hideSameChanged();
    this.sides?.right.hideSameChanged();
  }

  /**
   * Merge ◀ into ▶…: into ▶ itself, as the branch boxes say, whatever is checked out. ▶ checked out
   * here: `git merge` (the working tree follows). ▶ not checked out: the merge is made without a
   * checkout (CompareStore.mergeInPlace), and the working tree is not touched. Only where the
   * merge is clean. From the toolbar, a checklist of those repositories, all ticked: untick one
   * to leave it out. From a repository's right-click, that one only, after one prompt. Why the
   * others are left out is said once per reason, never once per repository.
   */
  async mergeIntoRight(only?: string): Promise<MultiResult | undefined> {
    const pair = this.deps.store.pair;
    if (!pair) return;
    // The repositories picked together (or All), when the merge comes from the toolbar or from a
    // right-click inside that selection; else one right-clicked repository, or every one.
    // A checked-out branch is merged with git merge: a conflict would stop it halfway, so the checks finish first.
    await this.deps.store.conflictsChecked();
    const sel = this.deps.selection.repoId;
    const group = sel !== undefined && isGroupSelection(sel) ? groupOf(this.deps.store, sel) : undefined;
    const single = !!only && only !== ALL_REPOS && !group?.some((x) => x.repo.id === only);
    const targets = single ? differing(this.deps.store).filter((x) => x.repo.id === only) : group ?? differing(this.deps.store);
    if (targets.length === 0) return undefined;
    const { plans, skipped } = await this.mergePlans(targets);
    const title = localize("Merge {0} into {1}", shortSide(pair.left), shortSide(pair.right));
    // Left out, grouped by why: one line, the names on request (never one line per repository).
    const left = mergeSkips(skipped);
    if (plans.length === 0) {
      this.nothingToMerge(left);
      return undefined;
    }
    const how = (p: MergePlan) => mergeHow(p);
    let chosen = plans;
    if (single) {
      const p = plans[0];
      if (!(await this.deps.ask.warning(localize("Merge {0} into {1} in {2}?", short(p.from), short(p.into), p.repo.name), `${short(p.into)} ${how(p)}`, localize("Merge")))) return undefined;
    } else {
      // A checklist, as Push… has: every repository that can merge, ticked; untick one to leave it out.
      const picked = await this.deps.ask.pickMany(plans.map((p) => ({ label: p.repo.name, description: `${short(p.from)} → ${short(p.into)}`, detail: `${short(p.into)} ${how(p)}`, picked: true })),
        skipped.length > 0 ? localize("Untick a repository to leave it out. Not offered: {0}", left.summary) : localize("Untick a repository to leave it out"));
      if (!picked?.length) return undefined;
      chosen = picked.map((i) => plans[i]);
    }
    // The report names each left-out repository once, with a short why.
    return this.deps.mergeEach(title, chosen, skipped.map((s) => ({ name: s.name, reason: skipReason(s) })));
  }

  /**
   * Where Merge ◀ into ▶ can run, and why not elsewhere: only where the merge is clean, ▶ is a local
   * branch still where the comparison saw it, and not checked out in another worktree. ▶ checked out
   * here: `git merge`; not checked out: the merge is made without a checkout.
   */
  private async mergePlans(targets: readonly { repo: Repo; result: Differs }[]): Promise<{ plans: MergePlan[]; skipped: MergeSkip[] }> {
    const plans: MergePlan[] = [];
    const skipped: MergeSkip[] = [];
    await runPool(targets, 8, async ({ repo, result }) => {
      if (result.conflicts && result.conflicts.length > 0) { skipped.push({ name: repo.name, why: "conflict", files: result.conflicts.length }); return; }
      const into = result.rightName;
      // ▶ as a local branch: where it is, the worktree that has it checked out (if one does), its upstream.
      const out = await this.deps.log.countedRun(repo.root, ["for-each-ref", "--format=%(objectname)%00%(worktreepath)%00%(upstream:remotename)%00%(upstream:remoteref)", `refs/heads/${into}`], new AbortController().signal).catch(() => "");
      const [sha = "", worktree = "", remote = "", remoteRef = ""] = out.trim().split("\0");
      if (!sha) { skipped.push({ name: repo.name, why: "remote", into: short(into) }); return; }
      if (sha !== result.rightSha) { skipped.push({ name: repo.name, why: "moved", into }); return; }
      // Git names the worktree by its real path; the repository's root may reach it by another.
      const here = worktree !== "" && await sameFolder(worktree, repo.root);
      if (worktree !== "" && !here) { skipped.push({ name: repo.name, why: "worktree", into }); return; }
      const from = { name: result.leftName, sha: result.leftSha };
      plans.push({ repo, from: result.leftName, into, checkedOut: here, commits: result.left, upstream: parseUpstream(`${remote}\0${remoteRef}`),
        merge: here ? () => this.deps.mergeRef(repo, result.leftName) : () => this.deps.store.mergeInPlace(repo, from, { name: into, sha }) });
    }, new AbortController().signal);
    const order = (name: string) => targets.findIndex((x) => x.repo.name === name);
    plans.sort((a, b) => order(a.repo.name) - order(b.repo.name));
    skipped.sort((a, b) => order(a.name) - order(b.name));
    return { plans, skipped };
  }

  private nothingToMerge(left: { summary: string; detail: string }): void {
    const details = localize("Details");
    void vscode.window.showInformationMessage(localize("Nothing to merge. {0}.", left.summary), details).then((pick) => {
      if (pick === details) void vscode.window.showInformationMessage(localize("Why nothing was merged"), { modal: true, detail: left.detail });
    });
  }

  /** Each listed repository's commits only on ◀ (the same change on both left out): the release notes' sections. */
  private async noteSections(group = true) {
    // The repositories picked together (or All); else every one.
    const sel = this.deps.selection.repoId;
    const targets = (group && sel !== undefined && isGroupSelection(sel) ? groupOf(this.deps.store, sel) : differing(this.deps.store)).filter((x) => x.result.left > 0);
    const settled = await runPool(targets, 8, ({ repo, result }) => this.deps.store.readCommits(repo.id, "left", result.left + result.sameLeft + 1), new AbortController().signal);
    return targets.map(({ repo, result }, i) => ({ repo: repo.name, from: short(result.leftName), into: short(result.rightName),
      commits: settled[i].status === "fulfilled" ? (settled[i] as PromiseFulfilledResult<Awaited<ReturnType<CompareStore["readCommits"]>>>).value.filter((c) => c.mark === "+") : [] }));
  }

  /** Copy as Release Notes: every listed repository's commits only on ◀, as Markdown. */
  async copyReleaseNotes(): Promise<string | undefined> {
    const sections = await this.noteSections();
    if (sections.length === 0) {
      void vscode.window.showInformationMessage(localize("No commit is only on {0}.", this.deps.store.pair ? shortSide(this.deps.store.pair.left) : "◀"));
      return undefined;
    }
    const text = releaseNotes(sections);
    await copyText(text);
    const n = sections.reduce((sum, s) => sum + s.commits.length, 0);
    vscode.window.setStatusBarMessage(localize("Copied release notes: {0} in {1}.", plural(n, "commit"), plural(sections.filter((s) => s.commits.length > 0).length, "repository", "repositories")), 8000);
    return text;
  }

  /**
   * ⋯ → Release…: ◀ released into ▶ across the compared repositories. One form first, before
   * anything runs: the repositories it can merge into (ticked), a tag on ▶ (optional), push or
   * not, and the release notes (◀'s own commits, read before the merge). Release: the merges, the
   * tag where it merged (that repository's notes as its message), the push of ▶ and the tag to ▶'s
   * upstream, the notes copied and shown, and one report. Cancel: nothing happened.
   */
  async release(): Promise<{ merged: string[]; tagged: string[]; pushed: string[]; notes: string } | undefined> {
    const pair = this.deps.store.pair;
    if (!pair) {
      void vscode.window.showInformationMessage(localize("Release…: pick in Compare what to release (◀) and where it goes (▶), then run Release… again."));
      await this.pick();
      return undefined;
    }
    await this.deps.store.conflictsChecked();
    const sections = await this.noteSections(false);
    if (sections.every((s) => s.commits.length === 0)) {
      void vscode.window.showInformationMessage(localize("Nothing to release: no commit is only on {0}.", shortSide(pair.left)));
      return undefined;
    }
    const notes = releaseNotes(sections);
    const { plans, skipped } = await this.mergePlans(differing(this.deps.store));
    if (plans.length === 0) {
      this.nothingToMerge(mergeSkips(skipped));
      return undefined;
    }
    const run = (r: Repo, args: string[]) => this.deps.log.countedRun(r.root, args, new AbortController().signal, { env: { GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" } });
    const from = shortSide(pair.left), into = shortSide(pair.right);
    const spec = releaseSpec({ from, into, notes, push: this.state.get<boolean>(RELEASE_PUSH, true),
      rows: plans.map((p) => ({ id: p.repo.id, name: p.repo.name, from: short(p.from), into: short(p.into), commits: p.commits, how: mergeHow(p), noUpstream: !p.upstream })),
      left: skipped.map((s) => ({ name: s.name, reason: skipReason(s) })) });
    const values = await this.deps.ask.form(spec, async (v): Promise<Record<string, string>> => {
      // A tag already there would stop that repository's tag: said before anything runs.
      const tag = textValue(v, "tag");
      if (!tag) return {};
      const ids = new Set(listValue(v, "repos"));
      const have = (await runPool(plans.filter((p) => ids.has(p.repo.id)), 4, async (p) => ((await run(p.repo, ["tag", "--list", "--", tag])).trim() ? p.repo.name : ""), new AbortController().signal))
        .flatMap((s) => (s.status === "fulfilled" && s.value ? [s.value] : []));
      return have.length > 0 ? { tag: localize("{0} already has the tag {1}.", have.join(", "), tag) } : {};
    });
    if (!values) return undefined;
    const tag = textValue(values, "tag"), push = checkValue(values, "push");
    await this.state.update(RELEASE_PUSH, push);
    const ids = new Set(listValue(values, "repos"));
    // The form may have stayed open a while: planned again, as the repositories are now (a checkout
    // meanwhile turns a git merge into a merge without a checkout). One that can no longer merge is named.
    const now = await this.mergePlans(differing(this.deps.store).filter((x) => ids.has(x.repo.id)));
    const chosen = now.plans;
    const title = localize("Release {0} into {1}", from, into);
    const merge = await this.deps.mergeEach(title, chosen, now.skipped.map((s) => ({ name: s.name, reason: localize("changed since the form opened: {0}", skipReason(s)), failed: true })), { quiet: true });
    if (!merge) return undefined;
    const merged = chosen.filter((p) => merge.done.includes(p.repo.name));
    const failures = merge.skipped.map((s) => `${s.name} (${localize("merge")}: ${s.reason})`);
    const tagged: MergePlan[] = [];
    if (tag) {
      for (const p of merged) {
        const section = sections.find((s) => s.repo === p.repo.name);
        try { await run(p.repo, releaseTagArgs(tag, tagMessage(tag, section?.commits ?? []), p.into)); tagged.push(p); }
        catch (e) { failures.push(`${p.repo.name} (${localize("tag")}: ${gitMessage(e)})`); }
      }
    }
    const pushed: string[] = [];
    if (push) {
      await runPool(merged, 4, async (p) => {
        const up = p.upstream;
        if (!up) { failures.push(`${p.repo.name} (${localize("{0} has no upstream", p.into)})`); return; }
        try { await run(p.repo, releasePushArgs(up.remote, p.into, up.ref, tagged.includes(p) ? tag : undefined)); pushed.push(p.repo.name); }
        catch (e) { failures.push(`${p.repo.name} (${localize("push")}: ${gitMessage(e)})`); }
      }, new AbortController().signal);
    }
    const report = releaseReport({ title, merged: merge.done, stopped: merge.stopped.map((s) => s.name), tag, tagged: tagged.map((p) => p.repo.name), pushed, failures });
    if (report.level === "info") void vscode.window.showInformationMessage(report.text);
    else void vscode.window.showWarningMessage(report.text);
    // Nothing merged: nothing was released, so no notes to copy.
    if (merge.done.length === 0) return undefined;
    return { merged: merge.done, tagged: tagged.map((p) => p.repo.name), pushed, notes: await this.finish(notes) };
  }

  /** The release notes on the clipboard, and open beside as Markdown. */
  private async finish(notes: string): Promise<string> {
    await copyText(notes);
    if (process.env.LINYRA_ITEST !== "1") {
      const doc = await vscode.workspace.openTextDocument({ language: "markdown", content: notes });
      await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
    }
    vscode.window.setStatusBarMessage(localize("Release notes copied."), 8000);
    return notes;
  }

  async snapshot(): Promise<{ open: boolean; description: string; message: string | undefined; pair: Pair | null; mode: CompareMode; roots: string[]; selected: string | undefined; accents: number[]; notes: string[] }> {
    const rows = this.rows();
    const results = new Map(this.deps.store.results().map((x) => [x.repo.id, x.result]));
    const pair = this.deps.store.pair;
    return {
      open: this.view?.visible === true, description: tabTitle(this.pairShown()),
      message: this.message() ?? (pair && pair.left !== pair.right ? this.summary() : undefined), pair, mode: this.mode,
      // What a row shows: its name, or why it cannot be compared.
      roots: rows.map((r) => (r.status === "differs" ? r.name : `${r.name} | ${repoCounts(results.get(r.repoId)!)}`)), selected: this.deps.selection.repoId, accents: rows.map((r) => r.accent),
      notes: rows.map((r) => [r.name, r.names, conflictNote(results.get(r.repoId)!)].filter(Boolean).join(" | ")),
    };
  }

  dispose(): void {
    clearTimeout(this.refreshTimer);
    for (const d of this.disposables) d.dispose();
  }
}

type Differs = ReturnType<typeof differing>[number]["result"];
/** Release… pushes unless it was last told not to. */
const RELEASE_PUSH = "linyra.release.push";

/** One repository's Merge ◀ into ▶, as planned before anything runs. */
interface MergePlan { repo: Repo; from: string; into: string; checkedOut: boolean; commits: number; upstream: { remote: string; ref: string } | undefined; merge: () => Promise<unknown> }

/** Where ▶ is not checked out, the merge is made without a checkout: said on each row. */
function mergeHow(p: MergePlan): string {
  return p.checkedOut ? localize("checked out: git merge") : localize("not checked out: your working tree is not touched");
}

function skipReason(s: MergeSkip): string {
  return s.why === "conflict" ? localize("would conflict") : s.why === "remote" ? localize("not a local branch")
    : s.why === "worktree" ? localize("checked out in another worktree") : localize("moved since the comparison");
}


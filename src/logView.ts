import { localize } from "./i18n";
import { randomBytes } from "crypto";
import * as path from "path";
import * as vscode from "vscode";
import { combinedTitle, firstOpenable, type CombinedOpen, type CombinedState } from "./changesModel";
import { readCombined } from "./combinedRead";
import type { ChangesSnapshot, ChangesTree, OpenDiffArgs } from "./changesTree";
import { diffSides, parseShow, showArgs } from "./commitDetail";
import { readReferences } from "./commitReferences";
import { debounce } from "./debounce";
import { toolbarCommand, type ToolbarState, type ChangesLayout } from "./toolbarModel";
import { DEFAULT_FILTER, hashQuery, normalizePath, pathspecOf, sameExceptText, sanitizeFilter, selectRepos, selectedBranches, type FilterState } from "./filterModel";
import { fetchPage, type BranchUse, type QueryState, type RunGit } from "./logQuery";
import { isAbortError, runPool } from "./pool";
import type { AuthorName, BranchName, CommitRef, HostMessage, Layout, WebviewMessage, WorkRow } from "./protocol";
import { distinctPaths, editedLabel, meter, previewLabel, tags, totals } from "./uncommittedModel";
import type { RepoDiscovery } from "./repoDiscovery";
import { decodeRevision, encodeRevision, SCHEME, workingFile, type RevisionRef } from "./revisionUri";
import { commitWebUrl } from "./remoteUrl";
import { addExclusion, authorSuggestions, branchSuggestions, undoExclusion } from "./repos";
import { readSettings } from "./settings";
import { commitKey, isSha, UNCOMMITTED, type Commit, type FileChange, type Repo, type RepoFailure } from "./types";
import { aheadBehindArgs, behindRepos, FETCH_ENV, fetchArgs, fetchProgress, fetchSummary, parseAheadBehind, pullArgs, pullPlan, pullReason, pullSummary, type AheadBehind } from "./upstream";
import type { UncommittedStore } from "./uncommittedStore";
import { openWorkDiff, type Ask } from "./uncommittedView";
import { activeProfiles, deleteProfile, nameProblem, profileFilter, profileNames, readProfiles, renameProfile, repoKey, resolveProfiles, saveProfile, setMembership, type Profiles, type ResolvedProfile } from "./profileModel";
import { renderHtml } from "./webview/html";
import { SELECTION_LIMIT } from "./webview/selectionModel";
import type { BranchController } from "./branchController";
import { assignAccents, accentOf } from "./webview/view";

const FILTER_KEY = "polylog.filter";
/** globalState: true when the user turned Group by Repository off. */
export const HIDE_REPOS_KEY = "polylog.hideRepos";
/** globalState: the Repositories pane width the user dragged to. */
const PANE_WIDTH_KEY = "polylog.repoPaneWidth";
const DEFAULT_PANE_WIDTH = 190;
/** For a git run that must finish once started (a merge rewriting the working tree). */
const NEVER_ABORT = new AbortController().signal;
/** Context key: Fetch All is running (the toolbar shows a spinning sync instead of the cloud). */
const FETCHING_KEY = "polylog.fetching";
/** Fetch All's answer; summary is the status-bar line shown when every fetch succeeded. */
export interface FetchResult { fetched: number; failed: string[]; summary?: string }
/** Pull All Behind's answer: the repositories pulled, and those left as they were (and why). */
export interface PullResult { pulled: string[]; skipped: { name: string; reason: string }[] }
/** Fetch All: network-bound, so fewer at once than the log reads; and a fetch that hangs stops. */
const FETCH_CONCURRENCY = 8;
const FETCH_TIMEOUT_MS = 60_000;
/** Without it, typing a six-character term launches 408 child processes. */
const SEARCH_DEBOUNCE_MS = 250;

export interface LogDeps {
  discovery: RepoDiscovery;
  run: RunGit;
  changes: ChangesTree;
  /** Each ticked repository's uncommitted work (the Log keeps its scope in step). */
  uncommitted: UncommittedStore;
  /** VS Code's prompts (shared with the Uncommitted view; the integration suite answers them). */
  ask: Ask;
  toolbarFlags?: () => Pick<ToolbarState, "compareShown" | "uncommittedShown">;
}

export interface LogSnapshot {
  repos: Repo[];
  profiles: ResolvedProfile[];
  filter: FilterState;
  rows: Commit[];
  failures: RepoFailure[];
  done: boolean;
  /** How many times the webview (re)loaded; hiding and showing the panel must not reload it. */
  readyCount: number;
  /** Each repository's user.email, in repo order (test seam). */
  me: string[];
  history: { repoId: string; path: string } | null;
  /** The store's uncommitted work, by repository (test seam). */
  uncommitted: { repoId: string; staged: string[]; changes: string[] }[];
  /** How many times the store reported a change (test seam). */
  uncommittedChanges: number;
  /** The Log's switch. */
  logMode: "commits" | "uncommitted";
  /** The Uncommitted side's rows as "name | preview | tags" (test seam). */
  workRows: string[];
  workTotals: { files: number; repos: number; added: number; deleted: number };
  workKnown: boolean;
  /** What a window reload would restore. */
  persistedFilter: FilterState | undefined;
  branches: BranchName[];
  authors: AuthorName[];
  branchUse: BranchUse | undefined;
  changes: ChangesSnapshot;
  /** The native Changes view is expanded and on screen (test seam). */
  changesVisible: boolean;
  layout: Layout;
  stats: { msToFirstRows: number | null; reloads: number; discoveries: number; spawns: number; discoveryMs: number; fetchMs: number; msToResolve: number; msToReady: number };
  /** Each git process started: in which repository, and which subcommand (the last 2,000). */
  spawnLog: { root: string; cmd: string }[];
  /** Each repository's distance from its upstream (only those with one). */
  sync: Record<string, AheadBehind>;
  /** Fetch All is running. */
  fetching: boolean;
  toolbar: ToolbarState;
  /** Repositories VS Code's Git reports changes for (the others are always read again). */
  reported: string[];
  /** Messages posted to the webview, by type, and their total size in bytes (integration runs only). */
  posts: Record<string, { count: number; bytes: number }>;
}

/** Posts are measured only in integration runs: sizing a 1 MB page costs milliseconds. */
const MEASURE_POSTS = process.env.POLYLOG_ITEST === "1";

const nowSec = () => Math.floor(Date.now() / 1000);

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const toUri = (r: RevisionRef) => vscode.Uri.from({ scheme: SCHEME, ...encodeRevision(r) });

/** The Log view in the Polylog panel. Registered with retainContextWhenHidden (extension.ts). */
export class LogView implements vscode.WebviewViewProvider, vscode.Disposable {
  branchSidebar: BranchController | undefined;
  static readonly id = "polylog.log";

  private webviewView: vscode.WebviewView | undefined;
  private repos: Repo[] = [];
  private filter: FilterState;
  private rows: Commit[] = [];
  private failures: RepoFailure[] = [];
  private done = true;
  private queryState: QueryState | null = null;
  private query = new AbortController();
  private detail = new AbortController();
  private loadingMore = false;
  private readyCount = 0;
  /** repo id → that repo's user.email, for the "Me" filter. Read in the background. */
  private meByRepo = new Map<string, string>();
  /** File history mode: one file of one repository. */
  private history: { repoId: string; path: string } | null = null;
  /** The history diff currently open (its modified-side URI), replaced on each step. */
  private historyTab: string | undefined;
  /** History steps swap tabs one at a time, and a step already overtaken is skipped. */
  private historySteps: Promise<void> = Promise.resolve();
  private historyStep = 0;
  /** What File History set aside (range, search, author); closing it gives them back. */
  private beforeHistory: Pick<FilterState, "date" | "from" | "to" | "text" | "author" | "mine" | "authors"> | null = null;
  /** Branch names across the workspace, for the Branch box's suggestions. Read in the background. */
  private branches: BranchName[] = [];
  /** Recent authors across the workspace, for the Author box's suggestions. Read in the background. */
  private authors: AuthorName[] = [];
  private branchUse: BranchUse | undefined;
  /** The repo set the background reads last ran for. */
  private backgroundFor: string | undefined;
  /** Enter arrived before the selected commit's files: open the first one when they land. */
  private openWhenLoaded: string | null = null;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly reloadSoon = debounce(() => void this.reload(), SEARCH_DEBOUNCE_MS);
  // The git extension opens repositories in bursts at startup; coalesce them.
  private readonly reposChangedSoon = debounce(() => void this.refreshRepos(), SEARCH_DEBOUNCE_MS);

  /** Startup and load cost, for the perf harness and the integration suite. */
  private readonly stats = { createdAt: Date.now(), firstRowsAt: 0, reloads: 0, discoveries: 0, spawns: 0, discoveryMs: 0, fetchMs: 0, resolvedAt: 0, readyAt: 0 };
  private readonly spawnLog: { root: string; cmd: string }[] = [];
  private readonly posts: Record<string, { count: number; bytes: number }> = {};
  private readonly run: RunGit;
  private referenceEpoch = 0;
  private firstLoad: Promise<void> | undefined;

  constructor(private readonly context: vscode.ExtensionContext, private readonly deps: LogDeps) {
    this.run = (cwd, args, signal, opts) => {
      this.stats.spawns++;
      this.spawnLog.push({ root: cwd, cmd: args[0] ?? "" });
      // Production keeps a bounded trace. The full integration suite needs a stable
      // cursor into every test spawn; truncating its prefix makes later read-count
      // assertions incorrectly see an empty slice.
      if (process.env.POLYLOG_ITEST !== "1" && this.spawnLog.length > 2000) this.spawnLog.splice(0, this.spawnLog.length - 2000);
      return deps.run(cwd, args, signal, opts);
    };
    this.filter = sanitizeFilter(context.workspaceState.get(FILTER_KEY) ?? DEFAULT_FILTER);
    this.syncRepoFiltered();
    this.disposables.push(
      deps.discovery.onDidChange(() => this.reposChangedSoon()),
      this.onDidChangeRefs((id) => this.refreshCurrentReferences(id)),
      // The switch's badge and rows, and the Changes view while on the Uncommitted side.
      deps.uncommitted.onDidChange(() => {
        this.postUncommitted();
        this.showWorkTree();
      }),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.stats.resolvedAt = Date.now();
    // Start git while the webview's page is still loading; "ready" replays the result.
    this.firstLoad ??= (async () => {
      await this.loadRepos();
      await this.reload();
    })();
    this.webviewView = view;
    this.deps.changes.attach((message) => this.post({ type: "changesView", message }), () => !!this.webviewView?.visible && this.layout().showChanges !== false);
    const out = vscode.Uri.joinPath(this.context.extensionUri, "out");
    view.webview.options = { enableScripts: true, localResourceRoots: [out] };
    view.webview.html = renderHtml({
      cspSource: view.webview.cspSource,
      nonce: randomBytes(16).toString("hex"),
      scriptUri: view.webview.asWebviewUri(vscode.Uri.joinPath(out, "webview.js")).toString(),
      styleUri: view.webview.asWebviewUri(vscode.Uri.joinPath(out, "webview.css")).toString(),
    });
    for (const d of this.viewDisposables) d.dispose();
    this.viewDisposables = [
      view.onDidChangeVisibility(() => this.deps.changes.visibilityChanged()),
      view.webview.onDidReceiveMessage((m: WebviewMessage) => void this.onMessage(m)),
      view.onDidDispose(() => {
        if (this.webviewView === view) this.webviewView = undefined;
      }),
    ];
  }


  async onMessage(m: WebviewMessage): Promise<void> {
    if (!m || typeof m !== "object") return; // webview input is untrusted
    switch (m.type) {
      case "branchSidebar": await this.branchSidebar?.handle(m); return;
      case "ready":
        this.branchSidebar?.ready();
        this.readyCount++;
        if (!this.stats.readyAt) this.stats.readyAt = Date.now();
        // The first load started when the view was created; wait for it, then
        // replay. (Also sent when a hidden webview is re-created.)
        if (this.firstLoad) await this.firstLoad;
        else await this.loadRepos();
        // A new webview starts on Commits: the host follows it rather than disagree.
        this.setLogMode("commits");
        this.postInit(true);
        // A re-created webview lost the suggestions it had: send them again (only then).
        if (this.branches.length > 0 || this.authors.length > 0) this.post({ type: "suggestions", branches: this.branches, authors: this.authors });
        if (this.sync.size > 0) this.postSync();
        this.postUncommitted();
        if (this.queryState === null) await this.reload();
        else this.post({ type: "page", rows: this.rows, append: false, failures: this.failures, done: this.done, now: nowSec(), branchUse: this.branchUse });
        return;
      case "filter": {
        let next = sanitizeFilter(m.filter);
        const leaveForHash = !!this.history && !!hashQuery(next.text);
        if (leaveForHash) {
          this.leaveHistory();
          next = { ...this.filter, text: next.text };
        }
        const textOnly = sameExceptText(next, this.filter);
        this.filter = next;
        if (leaveForHash) this.postInit(true);
        this.persistFilter();
        this.query.abort(); // kill superseded spawns now, not after the debounce
        if (textOnly) {
          this.reloadSoon();
        } else {
          this.reloadSoon.cancel();
          await this.reload();
        }
        return;
      }
      case "refresh":
        void this.branchSidebar?.refresh();
        this.reloadSoon.cancel();
        await this.refreshRepos(true);
        return;
      case "loadMore":
        await this.loadMore();
        return;
      case "select":
        await this.showDetail(m.repoId, m.sha);
        return;
      case "selectMany":
        await this.selectMany(m.items, m.focus);
        return;
      case "openFirst":
        await this.openFirst(m.repoId, m.sha);
        return;
      case "logMode":
        if (m.mode === "commits" || m.mode === "uncommitted") this.setLogMode(m.mode);
        return;
      case "selectWork":
        if (typeof m.repoId === "string" && this.deps.uncommitted.get(m.repoId)) {
          this.workRepo = m.repoId;
          this.showWorkTree();
        }
        return;
      case "exitHistory":
        await this.setHistory(null);
        return;
      case "wantSuggestions":
        if (m.kind === "authors" || m.kind === "branches") await this.loadSuggestions(m.kind);
        return;
      case "toolbarAction": {
        const command = toolbarCommand(m.action, this.toolbarState());
        if (command) await vscode.commands.executeCommand(command);
        this.toolbarChanged();
        return;
      }
      case "changesView":
        await this.deps.changes.onMessage(m.message);
        return;
      case "layout":
        if (typeof m.repoPaneWidth === "number" && Number.isFinite(m.repoPaneWidth)) await this.context.globalState.update(PANE_WIDTH_KEY, Math.round(m.repoPaneWidth));
        if (typeof m.changesPaneWidth === "number" && Number.isFinite(m.changesPaneWidth)) await this.context.globalState.update("polylog.changesPaneWidth", Math.max(180, Math.min(1600, Math.round(m.changesPaneWidth))));
        if (typeof m.changesPaneHeight === "number" && Number.isFinite(m.changesPaneHeight)) await this.context.globalState.update("polylog.changesPaneHeight", Math.max(96, Math.min(1200, Math.round(m.changesPaneHeight))));
        if (typeof m.showChanges === "boolean") await this.context.globalState.update("polylog.showChanges", m.showChanges);
        if (m.changesLayout === "auto" || m.changesLayout === "sideBySide" || m.changesLayout === "stacked") await this.context.globalState.update("polylog.changesLayout", m.changesLayout);
        if (typeof m.showChanges === "boolean") this.postInit();
        this.deps.changes.visibilityChanged();
        return;
      case "profileSave":
        await this.profileSave();
        return;
      case "openSettings":
        await vscode.commands.executeCommand("workbench.action.openSettings", "scan depth");
        return;
    }
  }

  private settings() {
    const config = vscode.workspace.getConfiguration("polylog");
    return readSettings((key) => config.get(key));
  }

  private layout(): Layout {
    const width = this.context.globalState.get<number>(PANE_WIDTH_KEY, DEFAULT_PANE_WIDTH);
    return {
      repoPaneWidth: typeof width === "number" && Number.isFinite(width) ? width : DEFAULT_PANE_WIDTH,
      groupByRepo: !this.context.globalState.get<boolean>(HIDE_REPOS_KEY, false),
      changesPaneWidth: this.context.globalState.get<number>("polylog.changesPaneWidth", 360),
      changesPaneHeight: this.context.globalState.get<number>("polylog.changesPaneHeight", 240),
      showChanges: this.context.globalState.get<boolean>("polylog.showChanges", true),
      changesLayout: this.context.globalState.get<ChangesLayout>("polylog.changesLayout", "auto"),
    };
  }

  private toolbarState(): ToolbarState {
    const flags = this.deps.toolbarFlags?.();
    return { groupByRepo: this.layout().groupByRepo, compareShown: flags?.compareShown ?? false,
      uncommittedShown: flags?.uncommittedShown ?? false, fetching: this.fetching !== undefined,
      anyBehind: [...this.sync.values()].some((state) => state.behind > 0) };
  }

  toolbarChanged(): void {
    this.post({ type: "toolbar", state: this.toolbarState() });
  }

  async showChanges(show: boolean, focus = false): Promise<void> {
    await this.context.globalState.update("polylog.showChanges", show);
    this.postInit();
    this.deps.changes.visibilityChanged();
    if (show && focus) {
      await vscode.commands.executeCommand(`${LogView.id}.focus`);
      this.post({ type: "focusChanges" });
    }
  }

  /** forceMode: the host changed the switch (File History, a new webview); otherwise the page's choice stands. */
  private postInit(forceMode = false): void {
    this.toolbarChanged();
    const repo = this.history && this.repos.find((r) => r.id === this.history!.repoId);
    const history = this.history && repo ? { repoName: repo.name, path: this.history.path } : null;
    this.post({ type: "init", repos: this.repos, filter: this.filter, hasMe: this.meByRepo.size > 0, layout: this.layout(), history, profiles: this.resolvedProfiles(), ...(forceMode ? { logMode: this.logMode } : {}) });
  }

  /**
   * "Polylog: File History" from the Explorer, an editor, a diff or the Changes
   * tree. Accepts a file: URI, a polylog: revision URI, a Changes file node, or
   * nothing (the active editor).
   */
  async fileHistory(arg?: unknown): Promise<void> {
    if (this.repos.length === 0) await this.loadRepos();
    let target: { repoId: string; path: string } | undefined;
    const fromTree = this.treeFile(arg);
    if (fromTree) {
      target = { repoId: fromTree.repo.id, path: fromTree.path };
    } else {
      const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
      if (uri?.scheme === SCHEME) {
        let rev: RevisionRef | undefined;
        try {
          rev = decodeRevision(uri.path, uri.query);
        } catch {
          rev = undefined; // a malformed URI: nothing to show
        }
        const repo = rev && this.repos.find((r) => r.root === rev!.root);
        if (repo && rev) target = { repoId: repo.id, path: rev.path };
      } else if (uri?.scheme === "file") {
        target = this.locate(uri.fsPath);
      }
    }
    if (!target) {
      void vscode.window.showInformationMessage(localize("Polylog: this file is not in a repository of this workspace."));
      return;
    }
    await vscode.commands.executeCommand(`${LogView.id}.focus`);
    await this.setHistory(target);
  }

  /**
   * "Open File" on a Polylog diff, or on a file in the Changes tree: the file as it is
   * in the workspace now, at the line the diff's cursor was on.
   */
  async openWorkingFile(arg?: unknown): Promise<void> {
    if (this.repos.length === 0) await this.loadRepos();
    const roots = this.repos.map((r) => r.root);
    let file: string | undefined;
    let line: number | undefined;
    const fromTree = this.treeFile(arg);
    if (fromTree) {
      file = workingFile({ root: fromTree.repo.root, ref: null, path: fromTree.path }, roots);
    } else {
      const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
      if (uri?.scheme === SCHEME) {
        try {
          file = workingFile(decodeRevision(uri.path, uri.query), roots);
        } catch {
          file = undefined;
        }
        const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString());
        line = editor?.selection.active.line;
      }
    }
    if (!file) {
      void vscode.window.showInformationMessage(localize("Polylog: this file is not in a repository of this workspace."));
      return;
    }
    const target = vscode.Uri.file(file);
    try {
      await vscode.workspace.fs.stat(target);
    } catch {
      void vscode.window.showInformationMessage(localize("Polylog: {0} no longer exists in the workspace.", path.basename(file)));
      return;
    }
    const at = line === undefined ? undefined : new vscode.Range(line, 0, line, 0);
    await vscode.window.showTextDocument(target, { preview: false, selection: at });
  }

  /**
   * A file node from the Changes tree (its right-click passes the node): which repository it
   * belongs to, and its path, if it really is a file of what the tree shows. In Review
   * Uncommitted the tree spans several repositories, so the node's own owner decides.
   */
  private treeFile(arg: unknown): { repo: Repo; path: string } | undefined {
    // A row of the Uncommitted view: its repository and group say where the file is.
    const u = arg as { kind?: unknown; repoId?: unknown; group?: unknown; path?: unknown } | undefined;
    if (u && typeof u === "object" && u.kind === "file" && typeof u.repoId === "string" && (u.group === "staged" || u.group === "changes") && typeof u.path === "string") {
      const work = this.deps.uncommitted.get(u.repoId);
      const repo = this.repos.find((r) => r.id === u.repoId);
      const listed = work && [...work.staged, ...work.changes].some((f) => f.path === u.path);
      return repo && listed ? { repo, path: u.path } : undefined;
    }
    const node = arg as { kind?: unknown; path?: unknown; owner?: { repoId?: unknown } } | undefined;
    const current = this.deps.changes.current();
    if (!node || typeof node !== "object" || node.kind !== "file" || typeof node.path !== "string" || !current) return undefined;
    const repoId = typeof node.owner?.repoId === "string" ? node.owner.repoId : current.commit.repoId;
    const repo = this.repos.find((r) => r.id === repoId);
    return repo && repoId === current.commit.repoId && current.files.some((f) => f.path === node.path) ? { repo, path: node.path } : undefined;
  }

  /** The workspace repository containing a file (innermost first), and its repo-relative path. */
  private locate(fsPath: string): { repoId: string; path: string } | undefined {
    const inside = this.innermost(fsPath);
    return inside && inside.rel !== "" ? { repoId: inside.r.id, path: inside.rel.split(path.sep).join("/") } : undefined;
  }

  /** The innermost workspace repository at or above a path ("" when it is the root itself). */
  private innermost(fsPath: string): { r: Repo; rel: string } | undefined {
    return this.repos
      .map((r) => ({ r, rel: path.relative(r.root, fsPath) }))
      .filter((x) => x.rel !== ".." && !x.rel.startsWith(`..${path.sep}`) && !path.isAbsolute(x.rel))
      .sort((a, b) => a.rel.length - b.rel.length)[0];
  }

  /** Save the filter; while File History forces all time, save the range the user will come back to. */
  private persistFilter(): void {
    this.syncRepoFiltered();
    const saved = this.history && this.beforeHistory ? { ...this.filter, ...this.beforeHistory } : this.filter;
    void this.context.workspaceState.update(FILTER_KEY, saved);
  }

  /** The right-click menu offers Show All Repositories only while some are unticked. */
  private repoFiltered: boolean | undefined;
  private syncRepoFiltered(): void {
    const on = this.filter.repoIds !== null;
    if (on === this.repoFiltered) return;
    this.repoFiltered = on;
    void vscode.commands.executeCommand("setContext", "polylog.repoFiltered", on);
  }

  /** Leave File History without reloading: restore the date range. */
  private leaveHistory(): void {
    if (this.beforeHistory) this.filter = { ...this.filter, ...this.beforeHistory };
    this.beforeHistory = null;
    this.history = null;
    // The next File History is a new session: its first step must not close this one's diff.
    this.historyTab = undefined;
    this.persistFilter();
  }

  /**
   * File history shows every commit of the file: all time, no search, no author. Closing
   * it restores what the user had before (even if they changed it while in history).
   */
  private async setHistory(history: { repoId: string; path: string } | null): Promise<void> {
    if (history && !this.history) {
      const { date, from, to, text, author, mine, authors } = this.filter;
      this.beforeHistory = { date, from, to, text, author, mine, authors };
      this.filter = { ...this.filter, date: "all", from: undefined, to: undefined, text: "", author: "", mine: false, authors: undefined };
      this.history = history;
    } else if (!history) {
      this.leaveHistory();
    } else {
      this.history = history;
    }
    // File History is a list of commits: the switch goes back to Commits to show it.
    if (history) this.setLogMode("commits");
    this.persistFilter();
    this.postInit(history !== null);
    await this.reload();
  }

  /**
   * The git binary changed (git.path, or VS Code's Git extension reported its own). Kill
   * git processes still running on the old binary, and read everything again: the page,
   * the selected commit, and the background reads (Me, branch suggestions).
   */
  async gitChanged(): Promise<void> {
    this.query.abort();
    this.detail.abort();
    this.reloadSoon.cancel();
    this.backgroundFor = undefined;
    this.meFor = undefined;
    void this.deps.uncommitted.readAll(true);
    this.fetchCtl.abort();
    this.fetchCtl = new AbortController();
    await this.reload();
    const current = this.deps.changes.current();
    if (current) await this.showDetail(current.commit.repoId, current.commit.sha);
  }

  /** Group by Repository: show or hide the Repositories pane (Log title-bar toggle). */
  async setGroupByRepo(on: boolean): Promise<void> {
    await this.context.globalState.update(HIDE_REPOS_KEY, !on);
    await vscode.commands.executeCommand("setContext", HIDE_REPOS_KEY, !on);
    // Hiding the pane must not leave a repo filter the user can no longer see.
    const clearing = !on && this.filter.repoIds !== null;
    if (clearing) {
      this.filter = { ...this.filter, repoIds: null };
      this.persistFilter();
    }
    this.postInit();
    if (clearing) await this.reload();
  }

  private async loadRepos(): Promise<void> {
    this.stats.discoveries++;
    const t = Date.now();
    this.repos = await this.deps.discovery.list(this.settings());
    this.stats.discoveryMs = Date.now() - t;
  }

  /**
   * "Me" emails and branch suggestions are background reads: they start after
   * the first page is on screen (so they never compete with it) and run once
   * per set of repositories.
   */
  private firstPageShown!: () => void;
  /** Resolves once the first page is on screen: background reads (Compare too) wait for it. */
  readonly firstPage = new Promise<void>((resolve) => (this.firstPageShown = resolve));

  private startBackgroundReads(): void {
    this.firstPageShown();
    const key = this.repos.map((r) => r.id).join("\0");
    if (key === this.backgroundFor) return;
    this.backgroundFor = key;
    void this.loadMe();
    void this.readSync();
    // Uncommitted work: once, after the first page (the switch's badge), then kept current by events.
    void this.deps.uncommitted.readAll();
    // Suggestions are read when their box is first focused (wantSuggestions), not here:
    // at startup they would cost 2 git processes per repository for boxes rarely opened.
    this.suggestionsFor.clear();
    // A box focused before the repositories were known asked for nothing useful: ask again.
    for (const kind of this.suggestionsWanted) void this.loadSuggestions(kind);
  }

  /** Kinds of suggestion a box has asked for this session. */
  private readonly suggestionsWanted = new Set<"authors" | "branches">();

  /** The repo set each kind of suggestion was last read for. */
  private readonly suggestionsFor = new Map<"authors" | "branches", string>();

  private async loadSuggestions(kind: "authors" | "branches"): Promise<void> {
    this.suggestionsWanted.add(kind);
    if (this.repos.length === 0) return; // nothing to read yet; asked again once repos arrive
    const key = this.repos.map((r) => r.id).join("\0");
    if (this.suggestionsFor.get(kind) === key) return;
    this.suggestionsFor.set(kind, key);
    await (kind === "authors" ? this.loadAuthors() : this.loadBranches());
  }

  /** People who committed recently, for the Author box's suggestions: 300 commits per repo. */
  private async loadAuthors(): Promise<void> {
    const repos = [...this.repos];
    const settled = await runPool(repos, this.settings().maxConcurrency,
      (r, signal) => this.run(r.root, ["log", "--no-merges", "--max-count=300", "--format=%aN%x1f%aE"], signal), this.background.signal);
    this.authors = authorSuggestions(settled.map((s) => (s.status === "fulfilled" ? s.value : "")));
    this.post({ type: "suggestions", authors: this.authors });
  }

  /** Branch names across repositories (local and remote-tracking), most shared first. */
  private async loadBranches(): Promise<void> {
    const repos = [...this.repos];
    const settled = await runPool(repos, this.settings().maxConcurrency,
      (r, signal) => this.run(r.root, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"], signal), this.background.signal);
    const lists = settled.map((s) => s.status === "fulfilled"
      ? s.value.split("\n").map((l) => l.trim().replace(/^refs\/(heads|remotes)\//, "")).filter(Boolean)
      : []);
    this.branches = branchSuggestions(lists);
    this.post({ type: "suggestions", branches: this.branches });
  }

  /** The repo set meByRepo was read for (reset when git itself changes). */
  private meFor: string | undefined;

  /** Each repo's user.email, in the background so it never delays the first paint. */
  private async loadMe(): Promise<void> {
    if (this.meFor === this.repos.map((r) => r.id).join("\0")) return; // read before the page (Me was on)
    if (!(await this.readMe())) return;
    this.postInit();
    if (this.filter.mine) await this.reload();
  }

  /** Reads each repo's user.email; true when they changed. */
  private async readMe(): Promise<boolean> {
    const repos = [...this.repos];
    this.meFor = repos.map((r) => r.id).join("\0");
    const settled = await runPool(repos, this.settings().maxConcurrency,
      (r, signal) => this.run(r.root, ["config", "user.email"], signal), this.background.signal);
    const me = new Map<string, string>();
    settled.forEach((s, i) => {
      if (s.status === "fulfilled" && s.value.trim()) me.set(repos[i].id, s.value.trim());
    });
    const changed = [...me].join() !== [...this.meByRepo].join();
    this.meByRepo = me;
    return changed;
  }

  /** Repositories may have changed (vscode.git settled, a repo opened/closed): reload only if they did. */
  private async refreshRepos(force = false): Promise<void> {
    const before = this.repos.map((r) => r.id).join("\0");
    await this.loadRepos();
    let changed = this.repos.map((r) => r.id).join("\0") !== before;
    // File History's repository left the list (excluded, closed): end it, or the Log is stuck with no exit.
    if (this.history && !this.repos.some((r) => r.id === this.history!.repoId)) {
      this.leaveHistory();
      changed = true;
    }
    this.postInit();
    if (force || changed || this.queryState === null) await this.reload();
    // Refresh also re-reads how far each repo is from its upstream (a fetch may have moved it).
    if (force) {
      void this.readSync();
      void this.deps.uncommitted.readAll(true);
    }
  }

  /** polylog.excludeRepos or scanDepth changed in Settings: list the repositories again. */
  async reposSettingChanged(): Promise<void> {
    await this.refreshRepos();
  }

  /** Each repository's distance from its upstream, for the Repositories pane's ↓/↑ badge. */
  private sync = new Map<string, AheadBehind>();
  /** Background reads (Me, ↓/↑, suggestions): stopped when Polylog is. */
  private readonly background = new AbortController();
  /** The current webview's listeners: a re-created webview drops the old one's. */
  private viewDisposables: vscode.Disposable[] = [];

  private readonly scopeChanged = new vscode.EventEmitter<void>();
  /** The ticked repositories changed (the Compare tab reads what it lacks). */
  readonly onDidChangeScope = this.scopeChanged.event;
  private readonly refsChanged = new vscode.EventEmitter<string | undefined>();
  /** Branches moved: in one repository (its id), or in every one (undefined, after Fetch All). */
  readonly onDidChangeRefs = this.refsChanged.event;

  /** The repositories ticked in the Repo List, in its order. */
  tickedRepos(): Repo[] {
    return selectRepos(this.filter, this.repos);
  }

  /** The Branch box's name ("" when empty): Compare with… starts from it. */
  get branchBox(): string {
    const branches = selectedBranches(this.filter);
    return branches.length === 1 ? branches[0] : "";
  }

  /**
   * Reads ahead/behind for these repositories (every one by default): one git rev-list each,
   * from local refs. Posted only when a count changed.
   */
  private async readSync(only?: ReadonlySet<string>): Promise<void> {
    const repos = only ? this.repos.filter((r) => only.has(r.id)) : [...this.repos];
    const settled = await runPool(repos, this.settings().maxConcurrency, (r, signal) => this.run(r.root, aheadBehindArgs(), signal), this.background.signal);
    const next = new Map(only ? this.sync : []);
    settled.forEach((s, i) => {
      const ab = s.status === "fulfilled" ? parseAheadBehind(s.value) : null;
      if (ab && (ab.ahead > 0 || ab.behind > 0)) next.set(repos[i].id, ab);
      else next.delete(repos[i].id);
    });
    for (const id of next.keys()) if (!this.repos.some((r) => r.id === id)) next.delete(id);
    const key = (m: Map<string, AheadBehind>) => JSON.stringify([...m].sort());
    if (key(next) === key(this.sync)) return;
    this.sync = next;
    this.postSync();
    void vscode.commands.executeCommand("setContext", "polylog.anyBehind", behindRepos([...next.keys()], Object.fromEntries(next)).length > 0);
  }

  private fetching: Promise<FetchResult> | undefined;

  /**
   * Fetch All (the Log's toolbar): git fetch in every repository, a few at a time, then read how
   * far each is from its upstream again. The only thing Polylog changes in a repository, and only
   * when asked. Never prompts (GIT_TERMINAL_PROMPT=0); a fetch that hangs stops after a minute.
   */
  fetchAll(): Promise<FetchResult> {
    if (!this.fetching) {
      // The toolbar's cloud turns into a spinning sync until it is done.
      void vscode.commands.executeCommand("setContext", FETCHING_KEY, true);
      this.fetching = this.runFetchAll().finally(() => {
        this.fetching = undefined;
        this.toolbarChanged();
        void vscode.commands.executeCommand("setContext", FETCHING_KEY, false);
        this.refsChanged.fire(undefined);
      });
    }
    this.toolbarChanged();
    return this.fetching;
  }

  private async runFetchAll(): Promise<FetchResult> {
    if (this.repos.length === 0) await this.loadRepos();
    const repos = [...this.repos];
    const prune = vscode.workspace.getConfiguration("git").get<boolean>("pruneOnFetch", false) === true;
    // Network work, not disk: fewer at once than the log reads.
    const limit = Math.min(this.settings().maxConcurrency, FETCH_CONCURRENCY);
    const outer = this.fetchCtl.signal;
    // A minute or so over SSH for many repositories: the Log's progress line, and a count in the status bar.
    const settled = await vscode.window.withProgress({ location: { viewId: LogView.id }, title: localize("Fetching") }, () =>
      vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Polylog" }, (progress) => {
        let done = 0;
        progress.report({ message: fetchProgress(done, repos.length) });
        return runPool(repos, limit, (r) => this.fetchOne(r, prune, outer).finally(() => progress.report({ message: fetchProgress(++done, repos.length) })), outer);
      }));
    if (outer.aborted) return { fetched: 0, failed: [] }; // disposed, or git changed: say nothing
    const failed = settled.flatMap((s, i) => (s.status === "rejected" ? [{ repo: repos[i], reason: s.reason }] : []));
    if (failed.length > 0) {
      const why = (e: unknown) => (isAbortError(e) ? localize("no answer after {0} s", FETCH_TIMEOUT_MS / 1000) : messageOf(e));
      const list = failed.slice(0, 3).map((f) => `${f.repo.name} (${why(f.reason)})`).join(", ");
      const more = failed.length > 3 ? localize(" and {0} more", failed.length - 3) : "";
      void vscode.window.showWarningMessage(localize("Polylog could not fetch {0} of {1} repositories: {2}{3}.", failed.length, repos.length, list, more));
    }
    // New remote branches: the Branch box's suggestions and a branch-mode page are out of date.
    this.suggestionsFor.delete("branches");
    if (this.suggestionsWanted.has("branches")) void this.loadSuggestions("branches");
    if (selectedBranches(this.filter).length) await this.reload();
    await this.readSync();
    const result: FetchResult = { fetched: repos.length - failed.length, failed: failed.map((f) => f.repo.name) };
    if (failed.length === 0) {
      // What it found, long enough to read after a long wait.
      result.summary = fetchSummary(repos.length, behindRepos(repos.map((r) => r.id), Object.fromEntries(this.sync)).length);
      vscode.window.setStatusBarMessage(result.summary, 8000);
    }
    return result;
  }

  /** Aborted by dispose and by a new git binary: a fetch in flight stops, with its helpers. */
  private fetchCtl = new AbortController();

  private async fetchOne(repo: Repo, prune: boolean, outer: AbortSignal): Promise<string> {
    const ctl = new AbortController();
    const stop = () => ctl.abort();
    const timer = setTimeout(stop, FETCH_TIMEOUT_MS);
    outer.addEventListener("abort", stop, { once: true });
    try {
      // tree: a timeout also kills ssh and the credential helpers git started.
      return await this.run(repo.root, fetchArgs(prune), ctl.signal, { tree: true, env: FETCH_ENV });
    } finally {
      clearTimeout(timer);
      outer.removeEventListener("abort", stop);
    }
  }

  /**
   * Right-click a repository behind its upstream → Pull. Through VS Code's own Git when it has
   * the repository open (its settings, prompts and conflict handling, exactly like its Pull);
   * otherwise git pull --ff-only, which only moves the branch forward and stops if it diverged.
   */
  async repoPull(arg: unknown): Promise<void> {
    const repo = this.contextRepo(arg);
    if (!repo || this.pulling.has(repo.id)) return;
    this.pulling.add(repo.id);
    try {
      // Both would fetch into the same remote-tracking refs: let Fetch All finish first.
      if (this.fetching) await this.fetching;
      // VS Code's own Pull (git.pull) reports its own errors (conflicts, a dirty tree) in its words.
      const viaVsCode = this.deps.discovery.vsCodeGitHas(repo.root);
      await vscode.window.withProgress({ location: { viewId: LogView.id }, title: localize("Pulling {0}", repo.name) }, async () => {
        if (viaVsCode) await this.deps.discovery.pullWithVsCodeGit(repo.root);
        else await this.pullFastForward(repo);
      });
    } catch (e) {
      if (!isAbortError(e) || !this.fetchCtl.signal.aborted) {
        const why = isAbortError(e) ? localize("no answer after {0} s", FETCH_TIMEOUT_MS / 1000)
          : /fast-forward/i.test(messageOf(e)) ? localize("it has diverged from its upstream, and Polylog only fast-forwards here. Pull it in Source Control or a terminal")
          : messageOf(e);
        void vscode.window.showErrorMessage(localize("Polylog could not pull {0}: {1}.", repo.name, why));
      }
    } finally {
      this.pulling.delete(repo.id);
    }
    // The new commits, the branch's distance from its upstream, and its working tree.
    void this.deps.uncommitted.readRepo(repo.id);
    await this.reload();
    await this.readSync(new Set([repo.id]));
    this.refsChanged.fire(repo.id);
  }

  /** Repositories being pulled: a second click on one waits for nothing and does nothing. */
  private readonly pulling = new Set<string>();

  /**
   * Pull for a repository VS Code's Git has not opened: fast-forward only (never a merge commit;
   * it stops if the branch diverged), no prompts, no submodules, and a minute to answer.
   */
  private async pullFastForward(repo: Repo): Promise<void> {
    const ctl = new AbortController();
    const outer = this.fetchCtl.signal;
    const stop = () => ctl.abort();
    const timer = setTimeout(stop, FETCH_TIMEOUT_MS);
    outer.addEventListener("abort", stop, { once: true });
    try {
      // English: its "fast-forward" error is recognized below whatever the system's language.
      await this.run(repo.root, ["pull", "--ff-only", "--quiet", "--recurse-submodules=no"], ctl.signal, { tree: true, env: { ...FETCH_ENV, LC_ALL: "C" } });
    } finally {
      clearTimeout(timer);
      outer.removeEventListener("abort", stop);
    }
  }

  /**
   * Pull All Behind (the Log's … menu): every repository with ↓ fast-forwarded to what the last
   * fetch brought, a few at a time. A diverged one, or one whose local changes touch the incoming
   * files, is left as it was and named.
   */
  async pullAllBehind(): Promise<PullResult> {
    if (this.fetching) await this.fetching;
    if (this.repos.length === 0) await this.loadRepos();
    const plan = pullPlan(this.repos.map((r) => r.id), Object.fromEntries(this.sync));
    const byId = (id: string) => this.repos.find((r) => r.id === id)!;
    const repos = plan.pull.map(byId).filter((r) => !this.pulling.has(r.id));
    if (repos.length === 0 && plan.diverged.length === 0) {
      void vscode.window.showInformationMessage(plan.pull.length > 0
        ? localize("Polylog: the repositories behind their upstream are already being pulled.")
        : localize("Polylog: no repository is behind its upstream (as of the last fetch)."));
      return { pulled: [], skipped: [] };
    }
    for (const r of repos) this.pulling.add(r.id);
    const outer = this.fetchCtl.signal;
    let settled: PromiseSettledResult<string>[];
    try {
      settled = await vscode.window.withProgress({ location: { viewId: LogView.id }, title: localize("Pulling") }, () =>
        // The pool stops starting merges on an abort; a merge already running is never killed
        // halfway through the working tree. No prompts (hooks and LFS may ask), and git's own words in English for pullReason.
        runPool(repos, Math.min(this.settings().maxConcurrency, FETCH_CONCURRENCY), (r) => this.run(r.root, pullArgs(), NEVER_ABORT, { env: { ...FETCH_ENV, LC_ALL: "C" } }), outer));
    } finally {
      for (const r of repos) this.pulling.delete(r.id);
    }
    if (outer.aborted) return { pulled: [], skipped: [] };
    const pulled = repos.filter((_, i) => settled[i].status === "fulfilled");
    const skipped = [
      ...repos.flatMap((r, i) => { const s = settled[i]; return s.status === "rejected" ? [{ name: r.name, reason: pullReason(messageOf(s.reason)) }] : []; }),
      ...plan.diverged.map((id) => ({ name: byId(id).name, reason: localize("it has diverged from its upstream") })),
    ];
    if (skipped.length > 0) {
      const list = skipped.slice(0, 3).map((x) => `${x.name} (${x.reason})`).join(", ");
      const more = skipped.length > 3 ? localize(" and {0} more", skipped.length - 3) : "";
      void vscode.window.showWarningMessage(localize("Polylog pulled {0} of {1} repositories. Left as they were: {2}{3}. Pull those in Source Control or a terminal.", pulled.length, pulled.length + skipped.length, list, more));
    } else {
      vscode.window.setStatusBarMessage(pullSummary(pulled.length), 8000);
    }
    // The new commits, each branch's distance from its upstream, and the working trees.
    for (const r of pulled) void this.deps.uncommitted.readRepo(r.id);
    await this.reload();
    await this.readSync();
    this.refsChanged.fire(undefined);
    return { pulled: pulled.map((r) => r.name), skipped };
  }

  /** Fetch and Pull All: Fetch All, then Pull All Behind with what it brought. */
  async fetchAndPullAll(): Promise<PullResult | undefined> {
    // Taken before: a git.path change mid-fetch aborts this one and swaps in a fresh controller.
    const signal = this.fetchCtl.signal;
    await this.fetchAll();
    // Disposed, or git changed mid-fetch: nothing more (the ↓ marks are from the old git).
    if (signal.aborted) return undefined;
    return this.pullAllBehind();
  }

  /** Show Only Repositories Behind: tick the repositories with commits to pull (as of the last fetch). */
  async showBehind(): Promise<void> {
    const ids = behindRepos(this.repos.map((r) => r.id), Object.fromEntries(this.sync));
    if (ids.length === 0) {
      void vscode.window.showInformationMessage(localize("Polylog: no repository is behind its upstream (as of the last fetch)."));
      return;
    }
    await this.setRepoFilter(ids);
  }

  private postSync(): void {
    this.toolbarChanged();
    this.post({ type: "sync", byRepo: Object.fromEntries(this.sync) });
    this.syncChanged.fire();
  }

  private readonly syncChanged = new vscode.EventEmitter<void>();
  /** A repository's distance from its upstream changed (the Uncommitted view offers Pull). */
  readonly onDidChangeSync = this.syncChanged.event;

  /** Repositories VS Code's Git reported a change in, whose upstream distance is read again. */
  private readonly syncTouched = new Set<string>();
  private readonly syncSoon = debounce(() => {
    const ids = new Set(this.syncTouched);
    this.syncTouched.clear();
    void this.readSync(ids);
  }, 400);

  /**
   * VS Code's Git reported a new state for a repository (a save, a stage, a fetch, a pull):
   * its uncommitted changes may have moved; its distance from its upstream only if HEAD or
   * the upstream did (a save does not move them).
   */
  repoStateChanged(root: string, headMoved: boolean, initial = false): void {
    // vscode.git's first status of a repository is not a change: the background read covers it.
    if (!initial) this.deps.uncommitted.touch(root);
    if (!headMoved) return;
    const repo = this.innermost(root)?.r;
    if (!repo) return;
    this.refsChanged.fire(repo.id);
    this.syncTouched.add(repo.id);
    this.syncSoon();
  }

  /** The repository a right-click on the Log's webview (a pane row or a commit row) was on. */
  /** The repository has commits to pull (as of the last fetch). */
  isBehind(repoId: string): boolean {
    return (this.sync.get(repoId)?.behind ?? 0) > 0;
  }

  private contextRepo(arg: unknown): Repo | undefined {
    const id = (arg as { repoId?: unknown } | undefined)?.repoId;
    return typeof id === "string" ? this.repos.find((r) => r.id === id) : undefined;
  }

  /** The commit a right-click on a Log row was on: a real commit of a listed repository. */
  private contextCommit(arg: unknown): { repo: Repo; sha: string } | undefined {
    const repo = this.contextRepo(arg);
    const sha = (arg as { sha?: unknown } | undefined)?.sha;
    return repo && typeof sha === "string" && isSha(sha) && sha !== UNCOMMITTED ? { repo, sha } : undefined;
  }

  /** Right-click a commit → Copy Commit ID. */
  async commitCopySha(arg: unknown): Promise<void> {
    const c = this.contextCommit(arg);
    if (c) await vscode.env.clipboard.writeText(c.sha);
  }

  /** Right-click a commit → Copy Message: the whole message (the row shows only the subject). */
  async commitCopyMessage(arg: unknown): Promise<void> {
    const c = this.contextCommit(arg);
    if (!c) return;
    try {
      const message = await this.run(c.repo.root, ["show", "-s", "--format=%B", c.sha, "--"], this.background.signal);
      await vscode.env.clipboard.writeText(message.trim());
    } catch (e) {
      void vscode.window.showErrorMessage(localize("Polylog could not read the commit message: {0}", messageOf(e)));
    }
  }

  /**
   * Right-click a commit → Open on Remote: its page on GitHub, GitLab, Bitbucket, Azure DevOps…,
   * from the repository's origin (or its first remote). Returns the URL opened.
   */
  async commitOpenOnRemote(arg: unknown): Promise<string | undefined> {
    const c = this.contextCommit(arg);
    if (!c) return undefined;
    const signal = new AbortController().signal;
    const urlOf = (name: string) => this.run(c.repo.root, ["remote", "get-url", "--", name], signal).then((s) => s.trim(), () => "");
    let remote = await urlOf("origin");
    if (!remote) {
      // No origin: the first remote git lists (alphabetical).
      const names = await this.run(c.repo.root, ["remote"], signal).then((s) => s.split("\n").map((x) => x.trim()).filter(Boolean), () => []);
      if (names[0]) remote = await urlOf(names[0]);
    }
    const url = remote ? commitWebUrl(remote, c.sha) : null;
    if (!url) {
      void vscode.window.showInformationMessage(localize("Polylog: {0} has no remote with a web page for this commit.", c.repo.name));
      return undefined;
    }
    // The integration suite checks the URL without launching a browser.
    if (process.env.POLYLOG_ITEST !== "1") await vscode.env.openExternal(vscode.Uri.parse(url, true));
    return url;
  }

  /** Sets the repo filter from the host (a right-click): the webview gets it with init. */
  private async setRepoFilter(repoIds: string[] | null): Promise<void> {
    const key = (ids: string[] | null) => (ids === null ? null : ids.join("\0"));
    if (key(repoIds) === key(this.filter.repoIds)) return;
    // A filter the user cannot see is a trap: picking repositories shows the pane.
    if (repoIds !== null && this.context.globalState.get<boolean>(HIDE_REPOS_KEY, false)) {
      await this.context.globalState.update(HIDE_REPOS_KEY, false);
      await vscode.commands.executeCommand("setContext", HIDE_REPOS_KEY, false);
    }
    this.filter = { ...this.filter, repoIds };
    this.persistFilter();
    this.postInit();
    this.reloadSoon.cancel();
    await this.reload();
  }

  /** A branch row filters history only; it never checks out that branch. */
  async selectBranch(repoId: string, branch: string): Promise<void> {
    if (!this.repos.some((r) => r.id === repoId)) return;
    if (this.history) this.leaveHistory();
    this.setLogMode("commits");
    this.filter = { ...this.filter, branch, branches: undefined, repoIds: [repoId] };
    await this.context.globalState.update(HIDE_REPOS_KEY, false);
    await vscode.commands.executeCommand("setContext", HIDE_REPOS_KEY, false);
    this.persistFilter(); this.postInit(true); this.reloadSoon.cancel();
    await this.reload();
  }

  async branchChanged(repoId: string): Promise<void> {
    this.suggestionsFor.delete("branches");
    if (this.suggestionsWanted.has("branches")) void this.loadSuggestions("branches");
    await this.reload();
    await this.deps.uncommitted.readRepo(repoId);
    await this.readSync(new Set([repoId]));
    this.refsChanged.fire(repoId);
  }

  /** polylog.profiles as written (lenient: malformed entries are skipped). */
  private rawProfiles(): Profiles {
    return readProfiles(vscode.workspace.getConfiguration("polylog").get("profiles"));
  }

  /** How each repository is named in polylog.profiles. */
  private profileKeys(): { id: string; key: string }[] {
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => ({ name: f.name, path: f.uri.fsPath }));
    return this.repos.map((r) => ({ id: r.id, key: repoKey(r.root, folders, process.platform === "win32") }));
  }

  resolvedProfiles(): ResolvedProfile[] {
    return resolveProfiles(this.rawProfiles(), this.profileKeys());
  }

  /** polylog.profiles changed (by Polylog or by hand): redraw the Repo List. */
  profilesChanged(): void {
    this.postInit();
  }

  /** The profile a right-click was on. */
  private contextProfile(arg: unknown): ResolvedProfile | undefined {
    const name = (arg as { profile?: unknown } | undefined)?.profile;
    return typeof name === "string" ? this.resolvedProfiles().find((p) => p.name === name) : undefined;
  }

  /** Right-click a profile → Show This Profile (the same as clicking it). */
  async profileShow(arg: unknown): Promise<void> {
    const p = this.contextProfile(arg);
    if (p) await this.setRepoFilter(profileFilter(p, this.repos.map((r) => r.id)));
  }

  /** ⋯ → Switch Profile…: All repositories, then each profile; works with the Repo List hidden. */
  async profileSwitch(): Promise<void> {
    const all = this.repos.map((r) => r.id);
    const resolved = this.resolvedProfiles();
    const active = activeProfiles(resolved, this.filter.repoIds, all);
    const nameOf = new Map(this.repos.map((r) => [r.id, r.name]));
    const items: vscode.QuickPickItem[] = [
      { label: localize("All repositories"), description: localize("{0} repositories", all.length), detail: this.filter.repoIds === null ? localize("Current") : undefined },
      ...resolved.map((p) => ({ label: p.name, description: p.ids.map((id) => nameOf.get(id)).join(", ") || localize("no repository found"), detail: active.includes(p.name) ? localize("Current") : undefined })),
    ];
    const i = await this.deps.ask.pick(items, resolved.length > 0 ? localize("Switch profile") : localize("No profiles yet: tick some repositories, then Save Selection as Profile…"));
    if (i === undefined) return;
    await this.setRepoFilter(i === 0 ? null : profileFilter(resolved[i - 1], all));
  }

  /** The workspace's own polylog.profiles (the listed ones also merge in the User settings' ones). */
  private ownProfiles(): Profiles {
    return readProfiles(vscode.workspace.getConfiguration("polylog").inspect("profiles")?.workspaceValue);
  }

  /**
   * An edit of the listed profiles, written to the workspace: its own profiles plus the ones this
   * edit changed, never a User-level profile it did not touch (the workspace file may be shared).
   * Nothing changed: nothing written (no settings.json created for a no-op).
   */
  private async writeChanges(before: Profiles, after: Profiles): Promise<void> {
    const own = this.ownProfiles();
    const out: Profiles = {};
    for (const [name, keys] of Object.entries(after)) {
      if (name in own || JSON.stringify(keys) !== JSON.stringify(before[name])) out[name] = keys;
    }
    if (JSON.stringify(out) !== JSON.stringify(own)) await this.writeProfiles(out);
  }

  /** A profile from the User settings cannot be renamed or deleted from a workspace: say where it is. */
  private userLevel(name: string): boolean {
    if (name in this.ownProfiles()) return false;
    void vscode.window.showInformationMessage(localize("Polylog: \"{0}\" is in your User settings (polylog.profiles); change it there.", name));
    return true;
  }

  /** Writes polylog.profiles to the workspace settings; false (with an error shown) if it could not. */
  private async writeProfiles(next: Profiles): Promise<boolean> {
    if (!vscode.workspace.workspaceFolders?.length) {
      void vscode.window.showErrorMessage(localize("Polylog: profiles are saved in the workspace settings; open a folder first."));
      return false;
    }
    try {
      await vscode.workspace.getConfiguration("polylog").update("profiles", next, vscode.ConfigurationTarget.Workspace);
    } catch (e) {
      void vscode.window.showErrorMessage(localize("Polylog could not save the profile: {0}", messageOf(e)));
      return false;
    }
    this.postInit();
    return true;
  }

  /** The ticked repositories as profile entries. */
  private tickedKeys(): string[] {
    const keyOf = new Map(this.profileKeys().map((k) => [k.id, k.key]));
    return (this.filter.repoIds ?? this.repos.map((r) => r.id)).flatMap((id) => keyOf.get(id) ?? []);
  }

  /** ＋ Save as profile…, the Repo List's right-click, ⋯: the ticked repositories under a name. */
  async profileSave(): Promise<void> {
    const keys = this.tickedKeys();
    if (keys.length === 0) return;
    const current = this.rawProfiles();
    const n = keys.length === 1 ? localize("1 repository") : localize("{0} repositories", keys.length);
    const name = await this.deps.ask.input(localize("Name for a profile of {0}", n), "backend", {
      validate: (v) => {
        if (!v.trim()) return undefined;
        const taken = Object.keys(current).find((k) => k.toLowerCase() === v.trim().toLowerCase());
        return taken === undefined ? undefined : { message: localize("\"{0}\" exists: Enter replaces it with these {1}.", taken, n), severity: vscode.InputBoxValidationSeverity.Warning };
      },
    });
    if (!name?.trim()) return;
    // Replacing keeps the existing spelling of the name.
    const taken = Object.keys(current).find((k) => k.toLowerCase() === name.trim().toLowerCase());
    await this.writeChanges(current, saveProfile(current, taken ?? name, keys));
  }

  /** Right-click a profile → Update to Current Selection. */
  async profileUpdate(arg: unknown): Promise<void> {
    const p = this.contextProfile(arg);
    const keys = this.tickedKeys();
    if (!p || keys.length === 0) return;
    const current = this.rawProfiles();
    await this.writeChanges(current, saveProfile(current, p.name, keys));
  }

  /** Right-click a profile → Rename…: refuses a name that is taken (in any case). */
  async profileRename(arg: unknown): Promise<void> {
    const p = this.contextProfile(arg);
    if (!p || this.userLevel(p.name)) return;
    const current = this.rawProfiles();
    const name = await this.deps.ask.input(localize("New name for profile \"{0}\"", p.name), p.name, { value: p.name, validate: (v) => nameProblem(current, v, p.name) });
    if (name === undefined || nameProblem(current, name, p.name) !== undefined || name.trim() === p.name) return;
    await this.writeChanges(current, renameProfile(current, p.name, name));
  }

  /** Right-click a profile → Delete: asks; the repositories stay as they are. */
  async profileDelete(arg: unknown): Promise<void> {
    const p = this.contextProfile(arg);
    if (!p || this.userLevel(p.name)) return;
    if (!(await this.deps.ask.warning(localize("Delete profile \"{0}\"?", p.name), localize("Its repositories stay as they are; only the name goes."), localize("Delete")))) return;
    const current = this.rawProfiles();
    await this.writeChanges(current, deleteProfile(current, p.name));
  }

  /** Right-click a repository → Profiles…: tick the profiles it belongs to, or start a new one with it. */
  async repoProfiles(arg: unknown): Promise<void> {
    const repo = this.contextRepo(arg);
    if (!repo) return;
    const key = this.profileKeys().find((k) => k.id === repo.id)?.key;
    if (!key) return;
    const current = this.rawProfiles();
    const names = profileNames(current);
    const items: vscode.QuickPickItem[] = [
      ...names.map((n) => ({ label: n, description: current[n].length === 1 ? localize("1 repository") : localize("{0} repositories", current[n].length), picked: current[n].includes(key) })),
      { label: localize("New profile with {0}…", repo.name), picked: false },
    ];
    const chosen = await this.deps.ask.pickMany(items, localize("Profiles with {0}", repo.name));
    if (chosen === undefined) return;
    let next = setMembership(current, key, chosen.filter((i) => i < names.length).map((i) => names[i]));
    if (chosen.includes(names.length)) {
      const name = await this.deps.ask.input(localize("Name for a new profile with {0}", repo.name), "backend", { validate: (v) => (v.trim() ? nameProblem(next, v) : undefined) });
      if (name !== undefined && nameProblem(next, name) === undefined) next = saveProfile(next, name, [key]);
    }
    await this.writeChanges(current, next);
  }

  /** Right-click → Show Only: this repository's commits alone. */
  async repoShowOnly(arg: unknown): Promise<void> {
    const repo = this.contextRepo(arg);
    if (repo) await this.setRepoFilter([repo.id]);
  }

  /** Right-click → Hide from the Log: untick this repository (the others stay as they are). */
  async repoHide(arg: unknown): Promise<void> {
    const repo = this.contextRepo(arg);
    if (!repo) return;
    const shown = this.filter.repoIds ?? this.repos.map((r) => r.id);
    await this.setRepoFilter(shown.filter((id) => id !== repo.id));
  }

  /** Right-click → Show All Repositories. */
  async repoShowAll(): Promise<void> {
    if (this.filter.repoIds !== null) await this.setRepoFilter(null);
  }

  async repoCopyPath(arg: unknown): Promise<void> {
    const repo = this.contextRepo(arg);
    if (repo) await vscode.env.clipboard.writeText(repo.root);
  }

  async repoOpenFolder(arg: unknown): Promise<void> {
    const repo = this.contextRepo(arg);
    if (repo) await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(repo.root), { forceNewWindow: true });
  }

  /**
   * Right-click → Exclude from Polylog: adds the repository's exact path to polylog.excludeRepos
   * (so a repo elsewhere with the same name stays), with an Undo. It goes where the setting
   * already applies from: settings arrays do not merge across scopes, so writing to another
   * would drop the user's own entries. With none yet, the user settings: an absolute path
   * belongs to this machine, not in a workspace file that may sit inside a repository.
   */
  async repoExclude(arg: unknown): Promise<void> {
    const repo = this.contextRepo(arg);
    if (!repo) return;
    const inspected = vscode.workspace.getConfiguration("polylog").inspect<string[]>("excludeRepos");
    const target = inspected?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    const previous = target === vscode.ConfigurationTarget.Workspace ? inspected?.workspaceValue : inspected?.globalValue;
    const pattern = repo.root.replace(/\\/g, "/");
    const next = addExclusion(previous, pattern);
    if (!next) return;
    // The repo leaves the filter too, or a filter of only it would match nothing.
    const ids = this.filter.repoIds;
    if (ids?.includes(repo.id)) {
      const rest = ids.filter((id) => id !== repo.id);
      this.filter = { ...this.filter, repoIds: rest.length > 0 ? rest : null };
      this.persistFilter();
    }
    // The configuration listener lists the repositories again (reposSettingChanged).
    await vscode.workspace.getConfiguration("polylog").update("excludeRepos", next, target);
    void vscode.window.showInformationMessage(localize("Polylog: {0} is excluded (polylog.excludeRepos).", repo.name), localize("Undo")).then(async (pick) => {
      if (pick !== localize("Undo")) return;
      const now = vscode.workspace.getConfiguration("polylog").inspect<string[]>("excludeRepos");
      const current = (target === vscode.ConfigurationTarget.Workspace ? now?.workspaceValue : now?.globalValue) ?? [];
      await vscode.workspace.getConfiguration("polylog").update("excludeRepos", undoExclusion(current, pattern, previous), target);
    });
  }

  /** The ticked repositories and the Path box, as the uncommitted store reads them. */
  private syncScope(): void {
    const p = this.filter.path === undefined ? undefined : normalizePath(this.filter.path);
    this.deps.uncommitted.setScope({ repos: selectRepos(this.filter, this.repos), pathspecs: p ? [pathspecOf(p)] : [] });
    this.scopeChanged.fire();
  }

  /** git, counted in the spawn log (the uncommitted store runs through it too). */
  get countedRun(): RunGit {
    return this.run;
  }

  private async reload(): Promise<void> {
    this.stats.reloads++;
    this.query.abort();
    this.queryState = null; // Load More waits for this reload's first page
    const ctl = (this.query = new AbortController());
    const s = this.settings();
    this.post({ type: "loading" });
    const t = Date.now();
    // Uncommitted work follows the ticked repositories and the Path box; once the background
    // read has run, each reload reads what no event keeps current (never before the page).
    this.syncScope();
    if (this.deps.uncommitted.started) void this.deps.uncommitted.readAll();
    try {
      // Me needs each repository's user.email, or the first page is empty and read twice.
      if (this.filter.mine && !hashQuery(this.filter.text) && this.meFor !== this.repos.map((r) => r.id).join("\0")) {
        if (await this.readMe()) this.postInit();
        if (ctl.signal.aborted) return;
      }
      // The commits do not wait for the uncommitted read: its rows follow as they land.
      const page = await fetchPage({
        repos: this.repos, filter: this.filter, pageSize: s.pageSize, concurrency: s.maxConcurrency,
        now: nowSec(), prev: null, run: this.run, signal: ctl.signal, me: this.meByRepo, history: this.history,
      });
      if (ctl.signal.aborted) return;
      this.rows = page.rows;
      this.failures = page.failures;
      this.done = page.done;
      this.queryState = page.state;
      this.branchUse = page.branchUse;
      if (!this.stats.firstRowsAt && page.rows.length > 0) this.stats.firstRowsAt = Date.now();
      this.stats.fetchMs = Date.now() - t;
      this.startBackgroundReads();
      this.clearTreeIfGone();
      this.refreshCurrentReferences();
      this.post({ type: "page", rows: this.rows, append: false, failures: page.failures, done: page.done, now: nowSec(), branchUse: page.branchUse });
    } catch (e) {
      if (!isAbortError(e)) void vscode.window.showErrorMessage(localize("Polylog could not read the log: {0}", messageOf(e)));
    }
  }

  private async loadMore(): Promise<void> {
    if (this.loadingMore || this.done || !this.queryState) return;
    this.loadingMore = true;
    const ctl = this.query; // a filter change aborts this too
    const prev = this.queryState;
    const s = this.settings();
    try {
      const page = await fetchPage({
        repos: this.repos, filter: this.filter, pageSize: s.pageSize, concurrency: s.maxConcurrency,
        now: nowSec(), prev: this.queryState, run: this.run, signal: ctl.signal, me: this.meByRepo, history: this.history,
      });
      // A reload (from the host) started meanwhile: its first page owns the list, not this one.
      if (ctl.signal.aborted || this.queryState !== prev) return;
      this.rows = this.rows.concat(page.rows);
      this.failures = this.failures.concat(page.failures);
      this.done = page.done;
      this.queryState = page.state;
      this.post({ type: "page", rows: page.rows, append: true, failures: page.failures, done: page.done, now: nowSec(), branchUse: page.branchUse });
    } catch (e) {
      if (!isAbortError(e)) void vscode.window.showErrorMessage(localize("Polylog could not load more commits: {0}", messageOf(e)));
    } finally {
      this.loadingMore = false;
    }
  }

  snapshot(): LogSnapshot {
    return {
      repos: this.repos, profiles: this.resolvedProfiles(), filter: this.filter, rows: this.rows, failures: this.failures, done: this.done,
      readyCount: this.readyCount, me: this.repos.flatMap((r) => this.meByRepo.get(r.id) ?? []), history: this.history, persistedFilter: this.context.workspaceState.get<FilterState>(FILTER_KEY), branches: this.branches, authors: this.authors, branchUse: this.branchUse, changes: this.deps.changes.snapshot(), changesVisible: this.deps.changes.visible,
      layout: this.layout(),
      stats: {
        msToFirstRows: this.stats.firstRowsAt ? this.stats.firstRowsAt - this.stats.createdAt : null,
        reloads: this.stats.reloads, discoveries: this.stats.discoveries, spawns: this.stats.spawns,
        discoveryMs: this.stats.discoveryMs, fetchMs: this.stats.fetchMs,
        msToResolve: this.stats.resolvedAt - this.stats.createdAt, msToReady: this.stats.readyAt - this.stats.createdAt,
      },
      spawnLog: [...this.spawnLog],
      uncommitted: this.deps.uncommitted.works().map((w) => ({ repoId: w.repoId, staged: w.staged.map((f) => f.path), changes: w.changes.map((f) => f.path) })),
      uncommittedChanges: this.deps.uncommitted.changes,
      logMode: this.logMode,
      workRows: this.workRows().map((r) => [this.repos.find((x) => x.id === r.repoId)?.name ?? r.repoId, r.preview, r.tags.join(", ")].join(" | ")),
      workTotals: totals(this.deps.uncommitted.works()),
      workKnown: this.deps.uncommitted.known,
      sync: Object.fromEntries(this.sync),
      fetching: this.fetching !== undefined, toolbar: this.toolbarState(),
      reported: this.repos.filter((r) => this.deps.discovery.reportsChanges(r.root)).map((r) => r.root),
      posts: structuredClone(this.posts),
    };
  }

  private findCommit(repoId: string, sha: string): { commit: Commit; repo: Repo } | undefined {
    if (!isSha(sha)) return undefined;
    const repo = this.repos.find((r) => r.id === repoId);
    const commit = this.rows.find((c) => c.repoId === repoId && c.sha === sha);
    return repo && commit ? { commit, repo } : undefined;
  }

  private async showDetail(repoId: string, sha: string): Promise<void> {
    // Validate first: a select that is not a listed commit must not kill the
    // detail already loading for the one that is.
    const found = this.findCommit(repoId, sha);
    if (!found) return;
    this.detail.abort();
    const ctl = (this.detail = new AbortController());
    this.combinedSel = null;
    const { commit, repo } = found;
    const key = commitKey(commit);
    if (this.openWhenLoaded !== key) this.openWhenLoaded = null;
    const base = { commit, repoRoot: repo.root, repoName: repo.name, files: [], message: "", focusPath: commit.file?.path, repoAccent: accentOf(assignAccents(this.repos), repoId) };
    // File history: the diff follows the selection, in one preview tab, keeping focus in the Log.
    if (this.history && commit.file) void this.openHistoryDiff(commit);
    this.setCommitTree({ ...base, status: "loading" });
    try {
      const { files, message } = parseShow(await this.run(repo.root, showArgs(sha), ctl.signal));
      if (ctl.signal.aborted) return; // a newer selection owns the tree now
      this.setCommitTree({ ...base, status: "ready", files, message });
      void this.updateCommitReferences(repo.root, repoId, sha, ctl.signal);
      if (this.openWhenLoaded === key) {
        this.openWhenLoaded = null;
        await this.openFirstOf(commit);
      }
    } catch (e) {
      if (!isAbortError(e) && !ctl.signal.aborted) this.setCommitTree({ ...base, status: "error", error: messageOf(e) });
    }
  }

  /** A selection, refresh or ref update reads this commit's refs without re-reading its files. */
  private refreshCurrentReferences(repoId?: string): void {
    const state = this.commitTree();
    if (!state || state.status !== "ready" || state.commit.sha === UNCOMMITTED || (repoId && state.commit.repoId !== repoId)) return;
    void this.updateCommitReferences(state.repoRoot, state.commit.repoId, state.commit.sha, this.detail.signal);
  }

  private async updateCommitReferences(root: string, repoId: string, sha: string, signal: AbortSignal): Promise<void> {
    const epoch = ++this.referenceEpoch;
    try {
      const value = await readReferences(this.run, root, sha, signal);
      if (signal.aborted || epoch !== this.referenceEpoch) return;
      if (this.logMode === "uncommitted") {
        if (this.commitsTree?.commit.repoId === repoId && this.commitsTree.commit.sha === sha) this.commitsTree.references = value;
      } else this.deps.changes.setReferences(repoId, sha, value);
    } catch { /* A missing ref must not hide the commit message or its files. */ }
  }

  /** A filter or refresh removed the tree's commit from the list: show nothing rather than a stale commit. */
  private clearTreeIfGone(): void {
    if (this.combinedSel) {
      // Combined Changes: keep the selected commits still listed.
      const kept = this.combinedSel.filter((f) => this.rows.some((c) => commitKey(c) === commitKey(f.commit)));
      if (kept.length === this.combinedSel.length) return;
      const focus = kept.find((f) => commitKey(f.commit) === this.combinedFocus) ?? kept[0];
      if (kept.length >= 2) void this.showCombined(kept, focus.commit);
      else if (kept.length === 1) void this.showDetail(kept[0].commit.repoId, kept[0].commit.sha);
      else {
        this.detail.abort();
        this.combinedSel = null;
        this.setCommitTree(null);
      }
      return;
    }
    const current = this.commitTree();
    if (!current) return;
    const key = commitKey(current.commit);
    if (this.rows.some((c) => commitKey(c) === key)) return;
    this.detail.abort();
    this.openWhenLoaded = null;
    this.setCommitTree(null);
  }

  /**
   * The Commits side's tree. On the Uncommitted side the Changes view shows a repository's
   * work: a commit's files (a selection, a detail read finishing, a reload) wait for the switch
   * to come back instead of replacing them.
   */
  private commitTree(): ReturnType<ChangesTree["current"]> {
    return this.logMode === "uncommitted" ? this.commitsTree : this.deps.changes.current();
  }

  private setCommitTree(state: ReturnType<ChangesTree["current"]>): void {
    if (this.logMode === "uncommitted") {
      this.commitsTree = state;
      this.commitsCombined = null;
    } else this.deps.changes.set(state);
  }

  private setCombinedTree(state: CombinedState): void {
    if (this.logMode === "uncommitted") {
      this.commitsTree = null;
      this.commitsCombined = state;
    } else this.deps.changes.setCombined(state);
  }

  /** Combined Changes: the selected commits (two or more), oldest first per repository; null when one is selected. */
  private combinedSel: { commit: Commit; repo: Repo }[] | null = null;
  private combinedFocus: string | null = null;
  private commitsCombined: CombinedState | null = null;

  private async selectMany(items: unknown, focus: unknown): Promise<void> {
    if (!Array.isArray(items)) return;
    const seen = new Set<string>();
    const found: { commit: Commit; repo: Repo }[] = [];
    for (const it of items.slice(0, SELECTION_LIMIT)) {
      const f = typeof it === "object" && it !== null ? this.findCommit((it as CommitRef).repoId, (it as CommitRef).sha) : undefined;
      if (f && !seen.has(commitKey(f.commit))) {
        seen.add(commitKey(f.commit));
        found.push(f);
      }
    }
    const fc = typeof focus === "object" && focus !== null ? this.findCommit((focus as CommitRef).repoId, (focus as CommitRef).sha)?.commit : undefined;
    if (found.length === 0) return;
    if (found.length === 1) return this.showDetail(found[0].commit.repoId, found[0].commit.sha);
    await this.showCombined(found, fc ?? found[found.length - 1].commit);
  }

  private async showCombined(found: { commit: Commit; repo: Repo }[], focus: Commit): Promise<void> {
    this.detail.abort();
    const ctl = (this.detail = new AbortController());
    this.openWhenLoaded = null;
    this.combinedSel = found;
    this.combinedFocus = commitKey(focus);
    // Repo List order; each repository's commits oldest first (the list is newest first).
    const groups = this.repos
      .map((repo) => ({ repo, commits: found.filter((f) => f.repo.id === repo.id).map((f) => f.commit).reverse() }))
      .filter((g) => g.commits.length > 0);
    const accents = assignAccents(this.repos);
    const base = { repos: [], noNetChange: [], count: found.length, unselected: {} };
    this.setCombinedTree({ ...base, status: "loading" });
    try {
      const settled = await runPool(groups, this.settings().maxConcurrency, (g, signal) => readCombined(this.run, g.repo.root, g.commits, signal), ctl.signal);
      if (ctl.signal.aborted) return; // a newer selection owns the tree now
      const failed = settled.find((r) => r.status === "rejected");
      if (failed) throw failed.reason;
      const state: CombinedState = { ...base, status: "ready", repos: [], noNetChange: [], unselected: {} };
      groups.forEach((g, i) => {
        const read = (settled[i] as PromiseFulfilledResult<Awaited<ReturnType<typeof readCombined>>>).value;
        state.noNetChange.push(...read.noNetChange);
        Object.assign(state.unselected, read.subjects);
        if (read.files.length === 0) return;
        state.repos.push({
          repoId: g.repo.id, repoName: g.repo.name, accent: accentOf(accents, g.repo.id), commits: g.commits,
          files: read.files.map((f): CombinedOpen => ({
            repoId: g.repo.id, path: f.path, status: f.status, beforeRef: f.beforeRef, beforePath: f.beforePath, shas: f.shas, mode: f.mode, included: f.included,
            ...(f.reason ? { reason: f.reason } : {}),
          })),
        });
      });
      this.setCombinedTree(state);
    } catch (e) {
      if (!isAbortError(e) && !ctl.signal.aborted) this.setCombinedTree({ ...base, status: "error", error: messageOf(e) });
    }
  }

  /** Clear Selection (the Changes view's title bar): back to the focused commit alone. */
  async clearSelection(): Promise<void> {
    const focus = this.combinedSel?.find((f) => commitKey(f.commit) === this.combinedFocus) ?? this.combinedSel?.[0];
    if (!focus) return;
    const ref = { repoId: focus.commit.repoId, sha: focus.commit.sha };
    this.post({ type: "setSelection", items: [ref], focus: ref });
    await this.showDetail(ref.repoId, ref.sha);
  }

  /** A Combined Changes file: only what the selected commits did to it (spec section 4). */
  async openCombinedDiff(o: CombinedOpen, preserveFocus = false): Promise<void> {
    const repo = this.repos.find((r) => r.id === o?.repoId);
    // From a tree node we built, but command arguments are untrusted: validate before git sees them.
    const safe = (p: unknown) => typeof p === "string" && p !== "" && !p.startsWith("/") && !p.split("/").includes("..");
    if (!repo || !Array.isArray(o.shas) || o.shas.length === 0 || o.shas.length > SELECTION_LIMIT || !o.shas.every(isSha)) return;
    if (!safe(o.path) || !safe(o.beforePath) || !(o.beforeRef === null || isSha(o.beforeRef))) return;
    const last = o.shas[o.shas.length - 1];
    const before: RevisionRef = o.mode === "merge"
      ? { root: repo.root, ref: last, path: o.path, without: [...o.shas].reverse() }
      : { root: repo.root, ref: o.status === "A" ? null : o.beforeRef, path: o.beforePath };
    const after: RevisionRef = { root: repo.root, ref: o.status === "D" ? null : last, path: o.path };
    await vscode.commands.executeCommand("vscode.diff", toUri(before), toUri(after), combinedTitle(o, repo.name), { preview: true, preserveFocus });
  }

  private openHistoryDiff(commit: Commit, preserveFocus = true): Promise<void> {
    // Overlapping swaps (holding ↓ with preview editors off) closed the tab a later
    // step had just activated: its diff was still open, so VS Code reused it.
    const step = ++this.historyStep;
    const run = () => (step === this.historyStep ? this.swapHistoryDiff(commit, preserveFocus) : undefined);
    this.historySteps = this.historySteps.then(run, run);
    return this.historySteps;
  }

  private async swapHistoryDiff(commit: Commit, preserveFocus: boolean): Promise<void> {
    if (!this.history) return; // queued before the user closed File History
    const f = commit.file!;
    const opened = await this.openDiff({ repoId: commit.repoId, sha: commit.sha, parent: commit.parents[0] ?? null, path: f.path, oldPath: f.oldPath, status: f.status }, preserveFocus);
    // Stepping through a history reuses one tab. VS Code's preview tab does that
    // unless the user turned preview editors off; then close the previous one.
    const previous = this.historyTab;
    this.historyTab = opened;
    if (!previous || previous === opened || vscode.workspace.getConfiguration("workbench.editor").get("enablePreview", true)) return;
    const tab = vscode.window.tabGroups.all.flatMap((g) => g.tabs)
      .find((t) => t.input instanceof vscode.TabInputTextDiff && t.input.modified.toString() === previous && !t.isDirty && !t.isPinned);
    if (tab) await vscode.window.tabGroups.close(tab, true);
  }

  private async openFirst(repoId: string, sha: string): Promise<void> {
    const combined = this.combinedSel ? this.deps.changes.currentCombined() : null;
    if (combined) {
      // Combined Changes: the first file of the first repository, once read.
      const first = combined.repos[0]?.files[0];
      if (first) await this.openCombinedDiff(first);
      return;
    }
    const found = this.findCommit(repoId, sha);
    if (!found) return;
    if (this.history && found.commit.file) return this.openHistoryDiff(found.commit, false);
    const current = this.deps.changes.current();
    if (current && commitKey(current.commit) === commitKey(found.commit) && current.status === "ready") {
      await this.openFirstOf(found.commit);
      return;
    }
    this.openWhenLoaded = commitKey(found.commit);
    if (!current || commitKey(current.commit) !== commitKey(found.commit)) await this.showDetail(repoId, sha);
  }

  private async openFirstOf(commit: Commit): Promise<void> {
    const f = firstOpenable(this.deps.changes.current()?.files ?? []);
    if (!f) return;
    await this.openDiff({ repoId: commit.repoId, sha: commit.sha, parent: commit.parents[0] ?? null, path: f.path, oldPath: f.oldPath, status: f.status });
  }

  /** Opens the diff; returns its modified-side URI (as a string), or undefined when refused. */
  async openDiff(a: OpenDiffArgs, preserveFocus = false, title?: string): Promise<string | undefined> {
    const repo = this.repos.find((r) => r.id === a?.repoId);
    // Refs come from the webview or a command argument: validate before they reach git.
    const safe = (p: unknown) => typeof p === "string" && p !== "" && !p.startsWith("/") && !p.split("/").includes("..");
    if (!repo || !isSha(a.sha) || !(a.parent === null || isSha(a.parent)) || !safe(a.path) || (a.oldPath !== undefined && !safe(a.oldPath))) return;
    if (a.sha === UNCOMMITTED) return this.openWorkingDiff(repo, a, preserveFocus);
    const status = typeof a.status === "string" ? a.status : undefined;
    const { before, after } = diffSides(repo.root, { sha: a.sha, parents: a.parent ? [a.parent] : [] }, { path: a.path, oldPath: a.oldPath, status });
    const label = title ?? `${path.posix.basename(a.path)} (${a.sha.slice(0, 7)}) — ${repo.name}`;
    // A panel view is not an editor group, so this always opens in the editor area above.
    const modified = toUri(after);
    await vscode.commands.executeCommand("vscode.diff", toUri(before), modified, label, { preview: true, preserveFocus });
    return modified.toString();
  }

  /** An uncommitted file: the same diff the Uncommitted view opens (Changes first, else Staged). */
  private async openWorkingDiff(repo: Repo, a: OpenDiffArgs, preserveFocus: boolean): Promise<string | undefined> {
    const work = this.deps.uncommitted.get(repo.id);
    const inChanges = work?.changes.find((f) => f.path === a.path);
    const file = inChanges ?? work?.staged.find((f) => f.path === a.path);
    if (!work || !file) return undefined;
    await openWorkDiff(work, inChanges ? "changes" : "staged", file, preserveFocus);
    return undefined;
  }

  /** The Log's switch: Commits (the Commit list) or Uncommitted (one row per repository with work). */
  private logMode: "commits" | "uncommitted" = "commits";
  /** The repository whose files the Changes view shows on the Uncommitted side. */
  private workRepo: string | undefined;
  /** What the Changes view showed before the switch went to Uncommitted (it comes back). */
  private commitsTree: ReturnType<ChangesTree["current"]> = null;

  private setLogMode(mode: "commits" | "uncommitted"): void {
    if (mode === this.logMode) return;
    this.logMode = mode;
    if (mode === "uncommitted") {
      this.commitsTree = this.deps.changes.current();
      this.commitsCombined = this.deps.changes.currentCombined();
      this.showWorkTree();
    } else {
      if (this.commitsCombined) this.deps.changes.setCombined(this.commitsCombined);
      else this.deps.changes.set(this.commitsTree);
      this.commitsTree = null;
      this.commitsCombined = null;
      // It may be a commit the list no longer has (a filter changed meanwhile).
      this.clearTreeIfGone();
    }
  }

  /** Repositories with uncommitted work, most recently edited first (unknown edit times last). */
  private workRows(): WorkRow[] {
    const now = Date.now();
    return this.deps.uncommitted.works()
      .filter((w) => distinctPaths(w).length > 0)
      .sort((a, b) => (b.editedAt ?? -Infinity) - (a.editedAt ?? -Infinity))
      .map((w) => ({ repoId: w.repoId, preview: previewLabel(w), meter: meter(w), tags: tags(w), edited: editedLabel(now, w.editedAt), canStage: w.canStage, hasStaged: w.staged.length > 0, hasChanges: w.changes.length > 0 }));
  }

  private postUncommitted(): void {
    this.post({ type: "uncommitted", known: this.deps.uncommitted.known, totals: totals(this.deps.uncommitted.works()), rows: this.workRows() });
  }

  /** The Changes view on the Uncommitted side: the selected repository's files, review only. */
  private showWorkTree(): void {
    if (this.logMode !== "uncommitted") return;
    const rows = this.workRows();
    const id = rows.some((r) => r.repoId === this.workRepo) ? this.workRepo : rows[0]?.repoId;
    const work = id ? this.deps.uncommitted.get(id) : undefined;
    const repo = id ? this.repos.find((r) => r.id === id) : undefined;
    if (!work || !repo) {
      this.deps.changes.set(null);
      return;
    }
    const staged = new Set(work.staged.map((f) => f.path));
    const byPath = new Map<string, FileChange>();
    for (const f of work.staged) byPath.set(f.path, { ...f, staged: true });
    // A file changed again after staging shows its working-tree side, marked staged only if nothing is left.
    for (const f of work.changes) byPath.set(f.path, { ...f, staged: false });
    const files = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)).map((f) => ({ ...f, staged: staged.has(f.path) && !work.changes.some((c) => c.path === f.path) }));
    const commit: Commit = { repoId: repo.id, sha: UNCOMMITTED, time: Math.floor(Date.now() / 1000), author: "", email: "", subject: localize("Uncommitted changes"), parents: work.head ? [work.head] : [] };
    this.deps.changes.set({ commit, repoRoot: repo.root, repoName: repo.name, status: "ready", message: "", files, discardable: work.canStage, stagedPaths: [...staged] });
  }

  /** All Files: a file the commit did not change, opened read-only as it was at that commit. */
  async openRevision(arg: unknown): Promise<void> {
    const a = arg as { repoId?: unknown; sha?: unknown; path?: unknown } | undefined;
    const repo = this.repos.find((r) => r.id === a?.repoId);
    if (!repo || !isSha(a?.sha) || typeof a?.path !== "string" || a.path === "" || a.path.split("/").includes("..")) return;
    const uri = toUri({ root: repo.root, ref: a.sha, path: a.path });
    await vscode.commands.executeCommand("vscode.open", uri, { preview: true }, `${path.posix.basename(a.path)} (${a.sha.slice(0, 7)})`);
  }

  /** Every repository of the workspace, in Repo List order (accents, the Uncommitted view). */
  get repoList(): readonly Repo[] {
    return this.repos;
  }

  /** A commit was made outside the Log (the Uncommitted view): read the first page again. */
  commitsChanged(): void {
    this.reloadSoon.cancel();
    void this.reload();
  }

  private post(m: HostMessage): void {
    if (MEASURE_POSTS) {
      const p = (this.posts[m.type] ??= { count: 0, bytes: 0 });
      p.count++;
      p.bytes += JSON.stringify(m).length;
    }
    void this.webviewView?.webview.postMessage(m);
  }

  postBranchMessage(message: Extract<HostMessage, { type: "sidebarState" | "branchTree" }>): void { this.post(message); }

  dispose(): void {
    this.background.abort();
    this.query.abort();
    this.detail.abort();
    this.fetchCtl.abort();
    this.syncSoon.cancel();
    this.reloadSoon.cancel();
    this.reposChangedSoon.cancel();
    this.scopeChanged.dispose();
    this.refsChanged.dispose();
    this.syncChanged.dispose();
    for (const d of this.viewDisposables) d.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

import { randomBytes } from "crypto";
import * as path from "path";
import * as vscode from "vscode";
import { firstOpenable } from "./changesModel";
import type { ChangesSnapshot, ChangesTree, OpenDiffArgs } from "./changesTree";
import { diffSides, parseShow, showArgs } from "./commitDetail";
import { debounce } from "./debounce";
import { DEFAULT_FILTER, normalizePath, pathspecOf, sameExceptText, sanitizeFilter, selectRepos, type FilterState } from "./filterModel";
import { fetchPage, type BranchUse, type QueryState, type RunGit } from "./logQuery";
import { isAbortError, runPool } from "./pool";
import type { AuthorName, BranchName, HostMessage, Layout, WebviewMessage, WorkRow } from "./protocol";
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
import { activeProfiles, profileFilter, readProfiles, repoKey, resolveProfiles, type Profiles, type ResolvedProfile } from "./profileModel";
import { renderHtml } from "./webview/html";

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
  private firstLoad: Promise<void> | undefined;

  constructor(private readonly context: vscode.ExtensionContext, private readonly deps: LogDeps) {
    this.run = (cwd, args, signal, opts) => {
      this.stats.spawns++;
      this.spawnLog.push({ root: cwd, cmd: args[0] ?? "" });
      if (this.spawnLog.length > 2000) this.spawnLog.splice(0, this.spawnLog.length - 2000);
      return deps.run(cwd, args, signal, opts);
    };
    this.filter = sanitizeFilter(context.workspaceState.get(FILTER_KEY) ?? DEFAULT_FILTER);
    this.syncRepoFiltered();
    this.disposables.push(
      deps.discovery.onDidChange(() => this.reposChangedSoon()),
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
      view.webview.onDidReceiveMessage((m: WebviewMessage) => void this.onMessage(m)),
      view.onDidDispose(() => {
        if (this.webviewView === view) this.webviewView = undefined;
      }),
    ];
  }


  async onMessage(m: WebviewMessage): Promise<void> {
    if (!m || typeof m !== "object") return; // webview input is untrusted
    switch (m.type) {
      case "ready":
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
        const next = sanitizeFilter(m.filter);
        const textOnly = sameExceptText(next, this.filter);
        this.filter = next;
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
        this.reloadSoon.cancel();
        await this.refreshRepos(true);
        return;
      case "loadMore":
        await this.loadMore();
        return;
      case "select":
        await this.showDetail(m.repoId, m.sha);
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
      case "layout":
        if (typeof m.repoPaneWidth === "number" && Number.isFinite(m.repoPaneWidth)) await this.context.globalState.update(PANE_WIDTH_KEY, Math.round(m.repoPaneWidth));
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
    };
  }

  /** forceMode: the host changed the switch (File History, a new webview); otherwise the page's choice stands. */
  private postInit(forceMode = false): void {
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
      void vscode.window.showInformationMessage("Polylog: this file is not in a repository of this workspace.");
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
      void vscode.window.showInformationMessage("Polylog: this file is not in a repository of this workspace.");
      return;
    }
    const target = vscode.Uri.file(file);
    try {
      await vscode.workspace.fs.stat(target);
    } catch {
      void vscode.window.showInformationMessage(`Polylog: ${path.basename(file)} no longer exists in the workspace.`);
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
    return this.filter.branch;
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
        void vscode.commands.executeCommand("setContext", FETCHING_KEY, false);
        this.refsChanged.fire(undefined);
      });
    }
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
    const settled = await vscode.window.withProgress({ location: { viewId: LogView.id }, title: "Fetching" }, () =>
      vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Polylog" }, (progress) => {
        let done = 0;
        progress.report({ message: fetchProgress(done, repos.length) });
        return runPool(repos, limit, (r) => this.fetchOne(r, prune, outer).finally(() => progress.report({ message: fetchProgress(++done, repos.length) })), outer);
      }));
    if (outer.aborted) return { fetched: 0, failed: [] }; // disposed, or git changed: say nothing
    const failed = settled.flatMap((s, i) => (s.status === "rejected" ? [{ repo: repos[i], reason: s.reason }] : []));
    if (failed.length > 0) {
      const why = (e: unknown) => (isAbortError(e) ? `no answer after ${FETCH_TIMEOUT_MS / 1000} s` : messageOf(e));
      const list = failed.slice(0, 3).map((f) => `${f.repo.name} (${why(f.reason)})`).join(", ");
      const more = failed.length > 3 ? ` and ${failed.length - 3} more` : "";
      void vscode.window.showWarningMessage(`Polylog could not fetch ${failed.length} of ${repos.length} repositories: ${list}${more}.`);
    }
    // New remote branches: the Branch box's suggestions and a branch-mode page are out of date.
    this.suggestionsFor.delete("branches");
    if (this.suggestionsWanted.has("branches")) void this.loadSuggestions("branches");
    if (this.filter.branch) await this.reload();
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
      await vscode.window.withProgress({ location: { viewId: LogView.id }, title: `Pulling ${repo.name}` }, async () => {
        if (viaVsCode) await this.deps.discovery.pullWithVsCodeGit(repo.root);
        else await this.pullFastForward(repo);
      });
    } catch (e) {
      if (!isAbortError(e) || !this.fetchCtl.signal.aborted) {
        const why = isAbortError(e) ? `no answer after ${FETCH_TIMEOUT_MS / 1000} s`
          : /fast-forward/i.test(messageOf(e)) ? "it has diverged from its upstream, and Polylog only fast-forwards here. Pull it in Source Control or a terminal"
          : messageOf(e);
        void vscode.window.showErrorMessage(`Polylog could not pull ${repo.name}: ${why}.`);
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
        ? "Polylog: the repositories behind their upstream are already being pulled."
        : "Polylog: no repository is behind its upstream (as of the last fetch).");
      return { pulled: [], skipped: [] };
    }
    for (const r of repos) this.pulling.add(r.id);
    const outer = this.fetchCtl.signal;
    let settled: PromiseSettledResult<string>[];
    try {
      settled = await vscode.window.withProgress({ location: { viewId: LogView.id }, title: "Pulling" }, () =>
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
      ...plan.diverged.map((id) => ({ name: byId(id).name, reason: "it has diverged from its upstream" })),
    ];
    if (skipped.length > 0) {
      const list = skipped.slice(0, 3).map((x) => `${x.name} (${x.reason})`).join(", ");
      const more = skipped.length > 3 ? ` and ${skipped.length - 3} more` : "";
      void vscode.window.showWarningMessage(`Polylog pulled ${pulled.length} of ${pulled.length + skipped.length} repositories. Left as they were: ${list}${more}. Pull those in Source Control or a terminal.`);
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
      void vscode.window.showInformationMessage("Polylog: no repository is behind its upstream (as of the last fetch).");
      return;
    }
    await this.setRepoFilter(ids);
  }

  private postSync(): void {
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
      void vscode.window.showErrorMessage(`Polylog could not read the commit message: ${messageOf(e)}`);
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
      void vscode.window.showInformationMessage(`Polylog: ${c.repo.name} has no remote with a web page for this commit.`);
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
      { label: "All repositories", description: `${all.length} repositories`, detail: this.filter.repoIds === null ? "Current" : undefined },
      ...resolved.map((p) => ({ label: p.name, description: p.ids.map((id) => nameOf.get(id)).join(", ") || "no repository found", detail: active.includes(p.name) ? "Current" : undefined })),
    ];
    const i = await this.deps.ask.pick(items, resolved.length > 0 ? "Switch profile" : "No profiles yet: tick some repositories, then Save Selection as Profile…");
    if (i === undefined) return;
    await this.setRepoFilter(i === 0 ? null : profileFilter(resolved[i - 1], all));
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
    void vscode.window.showInformationMessage(`Polylog: ${repo.name} is excluded (polylog.excludeRepos).`, "Undo").then(async (pick) => {
      if (pick !== "Undo") return;
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
      if (this.filter.mine && this.meFor !== this.repos.map((r) => r.id).join("\0")) {
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
      this.post({ type: "page", rows: this.rows, append: false, failures: page.failures, done: page.done, now: nowSec(), branchUse: page.branchUse });
    } catch (e) {
      if (!isAbortError(e)) void vscode.window.showErrorMessage(`Polylog could not read the log: ${messageOf(e)}`);
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
      if (!isAbortError(e)) void vscode.window.showErrorMessage(`Polylog could not load more commits: ${messageOf(e)}`);
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
      fetching: this.fetching !== undefined,
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
    const { commit, repo } = found;
    const key = commitKey(commit);
    if (this.openWhenLoaded !== key) this.openWhenLoaded = null;
    const base = { commit, repoRoot: repo.root, repoName: repo.name, files: [], message: "", focusPath: commit.file?.path };
    // File history: the diff follows the selection, in one preview tab, keeping focus in the Log.
    if (this.history && commit.file) void this.openHistoryDiff(commit);
    this.setCommitTree({ ...base, status: "loading" });
    try {
      const { files, message } = parseShow(await this.run(repo.root, showArgs(sha), ctl.signal));
      if (ctl.signal.aborted) return; // a newer selection owns the tree now
      this.setCommitTree({ ...base, status: "ready", files, message });
      if (this.openWhenLoaded === key) {
        this.openWhenLoaded = null;
        await this.openFirstOf(commit);
      }
    } catch (e) {
      if (!isAbortError(e) && !ctl.signal.aborted) this.setCommitTree({ ...base, status: "error", error: messageOf(e) });
    }
  }

  /** A filter or refresh removed the tree's commit from the list: show nothing rather than a stale commit. */
  private clearTreeIfGone(): void {
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
    if (this.logMode === "uncommitted") this.commitsTree = state;
    else this.deps.changes.set(state);
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
      this.showWorkTree();
    } else {
      this.deps.changes.set(this.commitsTree);
      this.commitsTree = null;
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
    const commit: Commit = { repoId: repo.id, sha: UNCOMMITTED, time: Math.floor(Date.now() / 1000), author: "", email: "", subject: "Uncommitted changes", parents: work.head ? [work.head] : [] };
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

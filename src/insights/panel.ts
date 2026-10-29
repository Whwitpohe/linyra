import { randomBytes } from "crypto";
import { promises as fs } from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { copyText } from "../clipboard";
import { debounce } from "../debounce";
import { gitDate } from "../filterModel";
import { GitError } from "../git";
import { localize } from "../i18n";
import type { RunGit } from "../logQuery";
import { abortError, isAbortError, runPool } from "../pool";
import { gitDirOf } from "../repoHead";
import type { Ask } from "../uncommittedActions";
import { isSha, type Repo } from "../types";
import { renderInsightsHtml } from "../webview/insights/html";
import { formatBytes, formatNumber } from "./format";
import { assess, commandText, confirmText, isConfigKey, maintenanceStart, taskInfo, TASKS, writePlan, type FormatOptions, type HealthAction, type HealthFacts, type MaintenanceTask, type WritePlan } from "./health";
import { HEALTH_CONFIG_REGEXP, HISTORY_FORMAT, indexEntries, parseConfig, parseCountObjects, parseHistory, parseTouches, parseTree, type HistoryCommit } from "./parse";
import { isTreeTab, type HistoryData, type InsightsHostMessage, type InsightsWebviewMessage, type ReadFailure, type TreeData, type TreeTab } from "./protocol";
import { DEFAULT_RANGE, HISTORY_LIMIT, isColorBy, isRange, isTab, logPathspec, readKey, safePath, sanitizeScope, sinceOf, treePath, type ColorBy, type InsightsRange, type InsightsScope, type InsightsTab } from "./range";
import { buildTree, findNode, heatSteps, keysOf, pruneTree, rankExtensions, type TreeNode } from "./treemap";

export interface InsightsDeps {
  context: vscode.ExtensionContext;
  /** Every repository of the workspace (the Log's list) and the ticked ones. */
  repos(): readonly Repo[];
  ticked(): readonly Repo[];
  /** The Log lists its repositories if it has not yet (opened before the Log ever was). */
  ensureRepos(): Promise<void>;
  accents(): ReadonlyMap<string, number>;
  /** The Log's counted runner: the integration suite counts every process. */
  run: RunGit;
  concurrency(): number;
  /** Every write is asked first (modal), through the integration suite's answer queue when testing. */
  ask: Ask;
  /** Show a commit in the Log (linyra.revealCommit). */
  reveal(repoId: string, sha: string): Thenable<unknown>;
  onDidChangeRefs: vscode.Event<string | undefined>;
  onDidChangeScope: vscode.Event<void>;
  onDidChangeAccents: vscode.Event<void>;
}

interface HistoryRead { commits: HistoryCommit[]; truncated: boolean }
/** A treemap's read of one repository: a value per path (bytes for Files, commits for Commits). */
interface TreeRead { entries: { path: string; value: number }[] }

/**
 * One tab's answer: what was read per repository for one key (scope path and range). It lives as
 * long as the Insights tab is open, like the Log's rows: switching tabs shows it again without git,
 * and a repository whose refs moved is dropped from it, so only that one is read again.
 */
interface Answer<T> {
  key: string;
  /** The read's clock: every repository's range starts at the same moment. */
  now: number;
  byRepo: Map<string, { value?: T; error?: string }>;
  /** Bumped when byRepo changes: a treemap built from it is built again. */
  version: number;
}

interface Answers { history?: Answer<HistoryRead>; files?: Answer<TreeRead>; commits?: Answer<TreeRead>; health?: Answer<HealthFacts> }

/** A treemap's tree, built from an answer's version for a set of repositories, kept for its drills. */
interface Built { answer: Answer<TreeRead>; version: number; repos: string; root: TreeNode; base: string[]; legend: TreeData["legend"]; heat: number[] }

const TAB_KEY = "linyra.insights.tab";
const RANGE_KEY = "linyra.insights.range";
const COLOR_KEY = "linyra.insights.colorBy";

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const exists = (p: string) => fs.stat(p).then(() => true, () => false);
/** A read Health can do without (its cell says it could not be read); an abort still stops the read. */
const orUndefined = <T>(p: Promise<T>): Promise<T | undefined> => p.catch((e) => { if (isAbortError(e)) throw e; return undefined; });
/** Health's numbers in the UI language; the file system monitor is git's own on Windows and macOS. */
const healthFormat = (): FormatOptions => ({ number: formatNumber, bytes: formatBytes, platform: process.platform, insensitive: process.platform === "win32" || process.platform === "darwin" });

/**
 * What Health reads from the git dir's files, with no git process: whether a commit-graph is there
 * (a single file or a split chain, in the common dir a worktree shares) and the index's entry count.
 */
async function gitDirFacts(root: string): Promise<Pick<HealthFacts, "commitGraph" | "tracked">> {
  const dir = await gitDirOf(root);
  if (!dir) return { commitGraph: undefined, tracked: undefined };
  const common = await fs.readFile(path.join(dir, "commondir"), "utf8").then((c) => path.resolve(dir, c.trim()), () => dir);
  const info = path.join(common, "objects", "info");
  const header = async (): Promise<number | undefined> => {
    let file: fs.FileHandle | undefined;
    try {
      file = await fs.open(path.join(dir, "index"), "r");
      const buf = new Uint8Array(12);
      const { bytesRead } = await file.read(buf, 0, 12, 0);
      // A split index's own entries are only those changed since its shared index.
      const split = (await fs.readdir(dir)).some((n) => n.startsWith("sharedindex."));
      return indexEntries(buf.subarray(0, bytesRead), split);
    } catch (e) {
      // No index yet: nothing was ever added.
      return (e as NodeJS.ErrnoException).code === "ENOENT" ? 0 : undefined;
    } finally {
      await file?.close();
    }
  };
  const [single, chain, tracked] = await Promise.all([exists(path.join(info, "commit-graph")), exists(path.join(info, "commit-graphs", "commit-graph-chain")), header()]);
  return { commitGraph: single || chain, tracked };
}
/** A repository with no commit yet has no HEAD: an empty answer, not a failure. */
const unborn = (e: unknown) => /HEAD/.test(messageOf(e)) && /unknown revision|not a valid object name|ambiguous argument|bad default revision|does not have any commits/i.test(messageOf(e));

/**
 * Linyra Insights: Visual History, Files, Commits and Repository Health, in one editor tab, over
 * the ticked repositories. Each tab reads only when shown, one git process per repository.
 */
export class InsightsPanel implements vscode.Disposable {
  static readonly viewType = "linyra.insights";
  private panel: vscode.WebviewPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private tab: InsightsTab;
  private range: InsightsRange;
  private colorBy: ColorBy;
  private scope: InsightsScope = { kind: "ticked" };
  private answers: Answers = {};
  private built: { files?: Built; commits?: Built } = {};
  /** The folder each treemap shows: keys below its base (the scope's root, or the scope's folder). */
  private drilled: Record<TreeTab, string[]> = { files: [], commits: [] };
  /** Repositories being written (Health's buttons wait for them). */
  private readonly busy = new Set<string>();
  /** Test seam: the last Health write's commands and failures. */
  lastWrite: { repo: string; command: string; error?: string }[] = [];
  /** The read in flight per tab: a newer request kills it. */
  private readonly reads = new Map<InsightsTab, AbortController>();
  /** Several repositories reporting at once (Update Project) read once. */
  private readonly showSoon = debounce(() => void this.show(), 250);
  /** Test seam: every message posted to the webview. */
  readonly posted: InsightsHostMessage[] = [];
  /** Test seam: every git process Insights started (the Log's spawn log counts them too). */
  readonly spawned: { root: string; args: string[] }[] = [];
  private readonly run: RunGit;

  constructor(private readonly deps: InsightsDeps) {
    this.run = (cwd, args, signal, opts) => {
      if (process.env.LINYRA_ITEST === "1") this.spawned.push({ root: cwd, args });
      return deps.run(cwd, args, signal, opts);
    };
    const state = deps.context.globalState;
    const tab = state.get(TAB_KEY), range = state.get(RANGE_KEY), color = state.get(COLOR_KEY);
    this.tab = isTab(tab) ? tab : "history";
    this.range = isRange(range) ? range : DEFAULT_RANGE;
    this.colorBy = isColorBy(color) ? color : "repo";
    this.disposables.push(
      deps.onDidChangeRefs((id) => this.refsChanged(id)),
      deps.onDidChangeScope(() => { if (this.panel) { this.postInit(); this.showSoon(); } }),
      deps.onDidChangeAccents(() => { if (this.panel) this.postInit(); }),
    );
  }

  /** Linyra: Insights. A path (Visual History from a file or folder) scopes it and shows Visual History. */
  async open(target?: { repoId: string; path: string; folder: boolean }, tab?: InsightsTab): Promise<void> {
    await this.deps.ensureRepos();
    if (target) this.setScope(sanitizeScope({ kind: target.path ? "path" : "repo", ...target }, (id) => this.known(id)));
    if (tab) this.setTab(tab);
    if (this.panel) {
      this.panel.reveal();
      this.postInit();
      void this.show();
      return;
    }
    const out = vscode.Uri.joinPath(this.deps.context.extensionUri, "out");
    const panel = vscode.window.createWebviewPanel(InsightsPanel.viewType, localize("Linyra Insights"), vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [out] });
    this.panel = panel;
    panel.iconPath = vscode.Uri.joinPath(this.deps.context.extensionUri, "media", "linyra.svg");
    const subscriptions = [
      panel.webview.onDidReceiveMessage((m: unknown) => void this.onMessage(m)),
      // Shown again: what changed while hidden is read now (a hidden tab reads nothing).
      panel.onDidChangeViewState(() => { if (panel.visible) this.showSoon(); }),
    ];
    panel.onDidDispose(() => {
      subscriptions.forEach((s) => s.dispose());
      if (this.panel !== panel) return;
      this.panel = undefined;
      for (const ctl of this.reads.values()) ctl.abort();
      this.reads.clear();
      this.showSoon.cancel();
      // Closing the tab drops what it read.
      this.answers = {};
      this.built = {};
      this.drilled = { files: [], commits: [] };
      this.scope = { kind: "ticked" };
    });
    panel.webview.html = renderInsightsHtml({ cspSource: panel.webview.cspSource, nonce: randomBytes(16).toString("hex"),
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(out, "insights.js")).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(out, "insights.css")).toString() });
  }

  /** Visual History from the Explorer, an editor tab or a Changes row: that file or folder. */
  async visualHistory(target: { root: string; path: string; folder?: boolean } | undefined): Promise<void> {
    await this.deps.ensureRepos();
    const repo = target && this.deps.repos().find((r) => r.root === target.root);
    if (!repo || !target) {
      void vscode.window.showInformationMessage(localize("Linyra: this file is not in a repository of this workspace."));
      return;
    }
    await this.open({ repoId: repo.id, path: target.path, folder: target.folder ?? false }, "history");
  }

  private known(repoId: string): boolean {
    return this.deps.repos().some((r) => r.id === repoId);
  }

  private setTab(tab: InsightsTab): void {
    this.tab = tab;
    void this.deps.context.globalState.update(TAB_KEY, tab);
  }

  /** A new scope starts each treemap at its root. */
  private setScope(scope: InsightsScope): void {
    if (JSON.stringify(scope) !== JSON.stringify(this.scope)) this.drilled = { files: [], commits: [] };
    this.scope = scope;
  }

  /** The repositories the scope covers: the ticked ones, or the one it names. */
  private scopeRepos(): Repo[] {
    if (this.scope.kind === "ticked") return [...this.deps.ticked()];
    const id = this.scope.repoId;
    const repo = this.deps.repos().find((r) => r.id === id);
    if (repo) return [repo];
    this.setScope({ kind: "ticked" }); // its repository left the workspace
    return [...this.deps.ticked()];
  }

  private post(m: InsightsHostMessage): void {
    if (process.env.LINYRA_ITEST === "1") this.posted.push(m);
    void this.panel?.webview.postMessage(m);
  }

  private postInit(): void {
    const accents = this.deps.accents();
    const repos = this.deps.repos().map((r) => ({ id: r.id, name: r.name, accent: accents.get(r.id) ?? 0 }));
    this.scopeRepos(); // drops a scope whose repository is gone
    this.post({ type: "init", repos, ticked: this.deps.ticked().map((r) => r.id), scope: this.scope, range: this.range, tab: this.tab, colorBy: this.colorBy, platform: process.platform });
  }

  /** A repository's refs moved (a commit, a checkout, a pull): what was read of it is out of date. */
  private refsChanged(id: string | undefined): void {
    for (const answer of Object.values(this.answers) as Answer<unknown>[]) {
      if (id === undefined) answer.byRepo.clear();
      else answer.byRepo.delete(id);
      answer.version++;
    }
    if (this.panel?.visible) this.showSoon();
  }

  async onMessage(value: unknown): Promise<void> {
    if (!value || typeof value !== "object") return;
    const m = value as InsightsWebviewMessage;
    switch (m.type) {
      case "ready":
        this.postInit();
        await this.show();
        return;
      case "tab":
        if (!isTab(m.tab)) return;
        this.setTab(m.tab);
        await this.show();
        return;
      case "scope":
        this.setScope(sanitizeScope(m.scope, (id) => this.known(id)));
        this.postInit();
        await this.show();
        return;
      case "range":
        if (!isRange(m.range)) return;
        this.range = m.range;
        this.drilled.commits = [];
        void this.deps.context.globalState.update(RANGE_KEY, m.range);
        this.postInit();
        await this.show();
        return;
      case "colorBy":
        if (!isColorBy(m.colorBy)) return;
        this.colorBy = m.colorBy;
        void this.deps.context.globalState.update(COLOR_KEY, m.colorBy);
        return;
      case "refresh":
        delete this.answers[this.tab as keyof Answers];
        await this.show();
        return;
      case "reveal":
        if (this.known(m.repoId) && isSha(m.sha)) await this.deps.reveal(m.repoId, m.sha);
        return;
      case "openFile": {
        const repo = this.deps.repos().find((r) => r.id === m.repoId);
        const p = safePath(m.path);
        if (!repo || !p) return;
        const file = path.join(repo.root, ...p.split("/"));
        // Commits lists files the range touched: one may be gone from the working tree since.
        if (!(await fs.stat(file).then((s) => s.isFile(), () => false))) {
          void vscode.window.showInformationMessage(localize("{0} is no longer in the working tree.", p));
          return;
        }
        await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(file));
        return;
      }
      case "visualHistory": {
        const p = safePath(m.path);
        if (!this.known(m.repoId) || !p) return;
        this.setScope({ kind: "path", repoId: m.repoId, path: p, folder: m.folder === true });
        this.setTab("history");
        this.postInit();
        await this.show();
        return;
      }
      case "drill": {
        if (!isTreeTab(m.tab) || !Array.isArray(m.path) || !m.path.every((k) => typeof k === "string")) return;
        const built = this.built[m.tab];
        // Only a folder that is there: the tree may have been read again meanwhile.
        if (!built || !findNode(built.root, [...built.base, ...m.path])?.children) return;
        this.drilled[m.tab] = m.path;
        this.postTree(m.tab, built);
        return;
      }
      case "health":
        await this.healthAction(m);
        return;
    }
  }

  /** The shown tab: what it has, and a read of what it lacks. */
  private async show(): Promise<void> {
    if (!this.panel) return;
    if (this.tab === "history") await this.showHistory();
    else if (isTreeTab(this.tab)) await this.showTree(this.tab);
    else if (this.tab === "health") await this.showHealth();
  }

  /** The answer for `key`, a fresh one if the key changed (a new scope path or range). */
  private answerFor<K extends keyof Answers>(tab: K, key: string): NonNullable<Answers[K]> {
    const current = this.answers[tab];
    if (current && current.key === key) return current as NonNullable<Answers[K]>;
    const fresh = { key, now: Math.floor(Date.now() / 1000), byRepo: new Map(), version: 0 } as NonNullable<Answers[K]>;
    this.answers[tab] = fresh;
    return fresh;
  }

  /**
   * Reads, one process per repository, the repositories `answer` lacks. False when a newer
   * request superseded it (its result is thrown away).
   */
  private async fill<T>(tab: InsightsTab, answer: Answer<T>, repos: readonly Repo[], read: (repo: Repo, signal: AbortSignal) => Promise<T>): Promise<boolean> {
    const missing = repos.filter((r) => !answer.byRepo.has(r.id));
    if (missing.length === 0) return true;
    this.reads.get(tab)?.abort();
    const ctl = new AbortController();
    this.reads.set(tab, ctl);
    const settled = await runPool(missing, this.deps.concurrency(), read, ctl.signal);
    if (ctl.signal.aborted || this.answers[tab as keyof Answers] !== answer) return false;
    this.reads.delete(tab);
    settled.forEach((s, i) => {
      if (s.status === "fulfilled") answer.byRepo.set(missing[i].id, { value: s.value });
      else if (!isAbortError(s.reason)) answer.byRepo.set(missing[i].id, { error: messageOf(s.reason) });
    });
    answer.version++;
    return true;
  }

  private failures<T>(answer: Answer<T>, repos: readonly Repo[]): ReadFailure[] {
    return repos.flatMap((r) => {
      const error = answer.byRepo.get(r.id)?.error;
      return error ? [{ repoId: r.id, name: r.name, reason: error }] : [];
    });
  }

  private async showHistory(): Promise<void> {
    const repos = this.scopeRepos();
    const scope = this.scope;
    const answer = this.answerFor("history", readKey("history", scope, this.range, []));
    const since = sinceOf(this.range, answer.now);
    if (repos.some((r) => !answer.byRepo.has(r.id))) this.post({ type: "history", status: "loading" });
    const args = ["log", "HEAD", "--no-merges", `--max-count=${HISTORY_LIMIT}`, ...(since === undefined ? [] : [`--since=${gitDate(since)}`]), "--numstat", HISTORY_FORMAT, ...logPathspec(scope)];
    const done = await this.fill("history", answer, repos, async (repo, signal) => {
      try {
        const commits = parseHistory(await this.run(repo.root, args, signal));
        return { commits, truncated: commits.length >= HISTORY_LIMIT };
      } catch (e) {
        if (unborn(e)) return { commits: [], truncated: false };
        throw e;
      }
    });
    if (!done || this.tab !== "history") return;
    const data: HistoryData = {
      since, now: answer.now,
      commits: repos.flatMap((r) => (answer.byRepo.get(r.id)?.value?.commits ?? []).map((c) => ({ repoId: r.id, ...c }))),
      truncated: repos.filter((r) => answer.byRepo.get(r.id)?.value?.truncated).map((r) => r.name),
      failures: this.failures(answer, repos),
    };
    this.post({ type: "history", status: "ready", data });
  }

  /**
   * Files: one ls-tree of HEAD per repository (sizes). Commits: one git log --name-only of the
   * range per repository (commits per path). Then the shown folder's part of the tree.
   */
  private async showTree(tab: TreeTab): Promise<void> {
    const repos = this.scopeRepos();
    const scope = this.scope;
    const answer = this.answerFor(tab, readKey(tab, scope, this.range, []));
    const since = tab === "commits" ? sinceOf(this.range, answer.now) : undefined;
    if (repos.some((r) => !answer.byRepo.has(r.id))) this.post({ type: "tree", tab, status: "loading" });
    const args = tab === "files"
      ? ["ls-tree", "-r", "-l", "-z", "HEAD", ...treePath(scope)]
      : ["log", "HEAD", "--no-merges", ...(since === undefined ? [] : [`--since=${gitDate(since)}`]), "--name-only", "-z", "--format=", ...logPathspec(scope)];
    const done = await this.fill(tab, answer, repos, async (repo, signal): Promise<TreeRead> => {
      try {
        const out = await this.run(repo.root, args, signal);
        return { entries: tab === "files" ? parseTree(out).map((f) => ({ path: f.path, value: f.size })) : [...parseTouches(out)].map(([p, value]) => ({ path: p, value })) };
      } catch (e) {
        if (unborn(e)) return { entries: [] };
        throw e;
      }
    });
    if (!done || this.tab !== tab) return;
    this.postTree(tab, this.build(tab, answer, repos));
  }

  /** The tree for an answer and its repositories, built again only when either changed. */
  private build(tab: TreeTab, answer: Answer<TreeRead>, repos: readonly Repo[]): Built {
    const key = repos.map((r) => r.id).join("\0");
    const old = this.built[tab];
    if (old && old.answer === answer && old.version === answer.version && old.repos === key) return old;
    const read = repos.map((r) => ({ id: r.id, name: r.name, entries: answer.byRepo.get(r.id)?.value?.entries ?? [] }));
    const root = buildTree(read);
    const scope = this.scope;
    // A path scope's treemap starts at its folder (a file: the folder holding it, which holds only it).
    const base = scope.kind === "path" ? keysOf(root, scope.repoId, scope.folder ? scope.path : path.posix.dirname(scope.path).replace(/^\.$/, "")) ?? [] : [];
    const all = read.flatMap((r) => r.entries);
    const built: Built = { answer, version: answer.version, repos: key, root, base,
      legend: tab === "files" ? rankExtensions(all) : [], heat: tab === "commits" ? heatSteps(all.map((e) => e.value)) : [] };
    this.built[tab] = built;
    return built;
  }

  private postTree(tab: TreeTab, built: Built): void {
    // The folder shown last, or as far down it as still exists.
    let drilled = this.drilled[tab];
    while (drilled.length && !findNode(built.root, [...built.base, ...drilled])?.children) drilled = drilled.slice(0, -1);
    this.drilled[tab] = drilled;
    const keys = [...built.base, ...drilled];
    const node = findNode(built.root, keys) ?? built.root;
    const answer = built.answer;
    const repos = this.scopeRepos();
    // The first crumb names where the scope starts: the ticked repositories, one, or a folder in one.
    const base = findNode(built.root, built.base) ?? built.root;
    const first = base.kind === "root" ? localize("Ticked repositories ({0})", repos.length)
      : base.kind === "repo" ? base.name : `${this.deps.repos().find((r) => r.id === base.repoId)?.name ?? ""} › ${base.path}`;
    const data: TreeData = {
      tab, path: drilled,
      crumbs: [first, ...drilled.map((_, i) => findNode(built.root, [...built.base, ...drilled.slice(0, i + 1)])?.name ?? "")],
      node: pruneTree(node), legend: built.legend, heat: built.heat,
      ...(tab === "commits" ? { since: sinceOf(this.range, answer.now) } : {}),
      failures: this.failures(answer, repos),
    };
    this.post({ type: "tree", tab, status: "ready", data });
  }

  /**
   * Health, per repository: git count-objects -v and one git config --get-regexp (every scope,
   * so the global maintenance.repo list comes with it): two processes. The commit-graph and the
   * tracked-file count come from the git dir's files.
   */
  private async readHealth(repo: Repo, signal: AbortSignal): Promise<HealthFacts> {
    const [objects, config, files] = await Promise.all([
      orUndefined(this.run(repo.root, ["count-objects", "-v"], signal).then(parseCountObjects)),
      // Exit 1: no key matched, which is an answer (nothing is set).
      orUndefined(this.run(repo.root, ["config", "--get-regexp", HEALTH_CONFIG_REGEXP], signal).then(parseConfig, (e) => {
        if (e instanceof GitError && e.exitCode === 1) return new Map<string, (string | null)[]>();
        throw e;
      })),
      gitDirFacts(repo.root),
    ]);
    if (signal.aborted) throw abortError();
    return { root: repo.root, objects, config, ...files };
  }

  private async showHealth(): Promise<void> {
    const repos = this.scopeRepos();
    const answer = this.answerFor("health", readKey("health", this.scope, this.range, []));
    if (repos.some((r) => !answer.byRepo.has(r.id))) this.post({ type: "health", status: "loading" });
    const done = await this.fill("health", answer, repos, (repo, signal) => this.readHealth(repo, signal));
    if (!done || this.tab !== "health") return;
    this.postHealth();
  }

  /** The rows as they stand: what was read, assessed now (thresholds, this platform). */
  private postHealth(): void {
    const answer = this.answers.health;
    if (!answer) return;
    const repos = this.scopeRepos();
    const rows = repos.flatMap((r) => {
      const facts = answer.byRepo.get(r.id)?.value;
      return facts ? [assess(r, facts, healthFormat())] : [];
    });
    this.post({ type: "health", status: "ready", data: { rows, failures: this.failures(answer, repos), busy: [...this.busy] } });
  }

  /**
   * A Health button. Nothing is written without the modal confirmation naming every command; a
   * copy writes nothing. Afterwards the written repositories are read again.
   */
  private async healthAction(m: Extract<InsightsWebviewMessage, { type: "health" }>): Promise<void> {
    const answer = this.answers.health;
    if (!answer || !Array.isArray(m.repoIds)) return;
    const repos = m.repoIds.flatMap((id) => {
      const repo = typeof id === "string" ? this.deps.repos().find((r) => r.id === id) : undefined;
      return repo && !this.busy.has(repo.id) && answer.byRepo.get(repo.id)?.value ? [repo] : [];
    });
    if (!repos.length) return;
    const row = (repo: Repo) => assess(repo, answer.byRepo.get(repo.id)!.value!, healthFormat());
    if (m.action === "copy") {
      await copyText(maintenanceStart(repos[0].root));
      void vscode.window.showInformationMessage(localize("Copied: {0}. Run it in a terminal to schedule git maintenance for {1}.", maintenanceStart(repos[0].root), repos[0].name));
      return;
    }
    let actions: (repo: Repo) => HealthAction[];
    if (m.action === "commitGraph") actions = () => [{ kind: "commitGraph" }];
    else if (m.action === "config") {
      if (!isConfigKey(m.key) || typeof m.value !== "boolean") return;
      const key = m.key, value = m.value;
      actions = () => [{ kind: "config", key, value }];
    } else if (m.action === "maintenance") {
      // The tasks the repositories' rows recommend start ticked.
      const wanted = new Set(repos.flatMap((r) => {
        const a = row(r).checks.find((c) => c.id === "objects")?.action;
        return a?.kind === "maintenance" && a.recommended ? a.tasks : [];
      }));
      const items = TASKS.map((task) => ({ label: task, detail: taskInfo(task).detail, picked: wanted.has(task) }));
      const picked = await this.deps.ask.pickMany(items, localize("git maintenance run: the tasks to run in {0}", repos.map((r) => r.name).join(", ")));
      if (!picked?.length) return;
      const tasks = picked.map((i) => TASKS[i]) as MaintenanceTask[];
      actions = () => [{ kind: "maintenance", tasks }];
    } else if (m.action === "optimize") actions = (repo) => row(repo).optimize;
    else return;
    const targets = repos.map((repo) => ({ repo, plans: actions(repo).flatMap((a) => writePlan(a) ?? []) })).filter((t) => t.plans.length > 0);
    if (!targets.length) {
      void vscode.window.showInformationMessage(localize("Nothing to optimize in the selected repositories."));
      return;
    }
    const c = confirmText(targets.map((t) => ({ name: t.repo.name, plans: t.plans })));
    if (!(await this.deps.ask.warning(c.message, c.detail, c.button))) return;
    await this.write(targets);
  }

  private async write(targets: { repo: Repo; plans: WritePlan[] }[]): Promise<void> {
    for (const t of targets) this.busy.add(t.repo.id);
    this.postHealth();
    // A write is never killed by a newer read: it runs to its end.
    const signal = new AbortController().signal;
    const log: { repo: string; command: string; error?: string }[] = [];
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: localize("Linyra: writing to {0}", targets.map((t) => t.repo.name).join(", ")) }, () =>
      runPool(targets, 2, async (t) => {
        // In order, and no further after a failure: a later command may rely on an earlier one.
        for (const p of t.plans) {
          try {
            await this.run(t.repo.root, p.args, signal, { env: { GIT_OPTIONAL_LOCKS: "1" } });
            log.push({ repo: t.repo.name, command: commandText(p) });
          } catch (e) {
            log.push({ repo: t.repo.name, command: commandText(p), error: messageOf(e) });
            void vscode.window.showErrorMessage(localize("{0}: {1} failed: {2}", t.repo.name, commandText(p), messageOf(e)));
            return;
          }
        }
      }, signal));
    this.lastWrite = log;
    const answer = this.answers.health;
    for (const t of targets) {
      this.busy.delete(t.repo.id);
      answer?.byRepo.delete(t.repo.id);
    }
    if (answer) answer.version++;
    if (this.tab === "health" && this.panel) await this.show();
    else this.postHealth();
  }

  /** Test seam: the tab's state as the integration suite checks it. */
  snapshot(): { open: boolean; visible: boolean; tab: InsightsTab; scope: InsightsScope; range: InsightsRange; reading: InsightsTab[]; posted: InsightsHostMessage[]; spawned: { root: string; args: string[] }[]; lastWrite: { repo: string; command: string; error?: string }[] } {
    return { open: !!this.panel, visible: !!this.panel?.visible, tab: this.tab, scope: this.scope, range: this.range, reading: [...this.reads.keys()], posted: this.posted, spawned: this.spawned, lastWrite: this.lastWrite };
  }

  dispose(): void {
    this.showSoon.cancel();
    this.panel?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

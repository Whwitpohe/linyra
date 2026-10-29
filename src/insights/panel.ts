import { randomBytes } from "crypto";
import * as path from "path";
import * as vscode from "vscode";
import { debounce } from "../debounce";
import { gitDate } from "../filterModel";
import { localize } from "../i18n";
import type { RunGit } from "../logQuery";
import { isAbortError, runPool } from "../pool";
import { isSha, type Repo } from "../types";
import { renderInsightsHtml } from "../webview/insights/html";
import { HISTORY_FORMAT, parseHistory, type HistoryCommit } from "./parse";
import type { HistoryData, InsightsHostMessage, InsightsWebviewMessage, ReadFailure } from "./protocol";
import { DEFAULT_RANGE, HISTORY_LIMIT, isColorBy, isRange, isTab, logPathspec, readKey, safePath, sanitizeScope, sinceOf, type ColorBy, type InsightsRange, type InsightsScope, type InsightsTab } from "./range";

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
  /** Show a commit in the Log (linyra.revealCommit). */
  reveal(repoId: string, sha: string): Thenable<unknown>;
  onDidChangeRefs: vscode.Event<string | undefined>;
  onDidChangeScope: vscode.Event<void>;
  onDidChangeAccents: vscode.Event<void>;
}

interface HistoryRead { commits: HistoryCommit[]; truncated: boolean }

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
}

const TAB_KEY = "linyra.insights.tab";
const RANGE_KEY = "linyra.insights.range";
const COLOR_KEY = "linyra.insights.colorBy";

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
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
  private history: Answer<HistoryRead> | undefined;
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
    if (target) this.scope = sanitizeScope({ kind: target.path ? "path" : "repo", ...target }, (id) => this.known(id));
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
      this.history = undefined;
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

  /** The repositories the scope covers: the ticked ones, or the one it names. */
  private scopeRepos(): Repo[] {
    if (this.scope.kind === "ticked") return [...this.deps.ticked()];
    const id = this.scope.repoId;
    const repo = this.deps.repos().find((r) => r.id === id);
    if (repo) return [repo];
    this.scope = { kind: "ticked" }; // its repository left the workspace
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
    for (const answer of [this.history]) {
      if (!answer) continue;
      if (id === undefined) answer.byRepo.clear();
      else answer.byRepo.delete(id);
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
        this.scope = sanitizeScope(m.scope, (id) => this.known(id));
        this.postInit();
        await this.show();
        return;
      case "range":
        if (!isRange(m.range)) return;
        this.range = m.range;
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
        this.forget(this.tab);
        await this.show();
        return;
      case "reveal":
        if (this.known(m.repoId) && isSha(m.sha)) await this.deps.reveal(m.repoId, m.sha);
        return;
      case "openFile": {
        const repo = this.deps.repos().find((r) => r.id === m.repoId);
        const p = safePath(m.path);
        if (repo && p) await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(path.join(repo.root, ...p.split("/"))));
        return;
      }
      case "visualHistory": {
        const p = safePath(m.path);
        if (!this.known(m.repoId) || !p) return;
        this.scope = { kind: "path", repoId: m.repoId, path: p, folder: m.folder === true };
        this.setTab("history");
        this.postInit();
        await this.show();
        return;
      }
    }
  }

  /** Refresh: the shown tab's answer is read again from scratch (a new clock for its range). */
  private forget(tab: InsightsTab): void {
    if (tab === "history") this.history = undefined;
  }

  /** The shown tab: what it has, and a read of what it lacks. */
  private async show(): Promise<void> {
    if (!this.panel) return;
    if (this.tab === "history") await this.showHistory();
  }

  /** The answer for `key`, a fresh one if the key changed (a new scope path or range). */
  private answerFor<T>(current: Answer<T> | undefined, key: string): Answer<T> {
    return current && current.key === key ? current : { key, now: Math.floor(Date.now() / 1000), byRepo: new Map() };
  }

  /**
   * Reads, one process per repository, the repositories `answer` lacks. False when a newer
   * request superseded it (its result is thrown away).
   */
  private async fill<T>(tab: InsightsTab, answer: Answer<T>, repos: readonly Repo[], read: (repo: Repo, signal: AbortSignal) => Promise<T>, current: () => Answer<T> | undefined): Promise<boolean> {
    const missing = repos.filter((r) => !answer.byRepo.has(r.id));
    if (missing.length === 0) return true;
    this.reads.get(tab)?.abort();
    const ctl = new AbortController();
    this.reads.set(tab, ctl);
    const settled = await runPool(missing, this.deps.concurrency(), read, ctl.signal);
    if (ctl.signal.aborted || current() !== answer) return false;
    this.reads.delete(tab);
    settled.forEach((s, i) => {
      if (s.status === "fulfilled") answer.byRepo.set(missing[i].id, { value: s.value });
      else if (!isAbortError(s.reason)) answer.byRepo.set(missing[i].id, { error: messageOf(s.reason) });
    });
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
    const answer = (this.history = this.answerFor(this.history, readKey("history", scope, this.range, [])));
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
    }, () => this.history);
    if (!done || this.tab !== "history") return;
    const data: HistoryData = {
      since, now: answer.now,
      commits: repos.flatMap((r) => (answer.byRepo.get(r.id)?.value?.commits ?? []).map((c) => ({ repoId: r.id, ...c }))),
      truncated: repos.filter((r) => answer.byRepo.get(r.id)?.value?.truncated).map((r) => r.name),
      failures: this.failures(answer, repos),
    };
    this.post({ type: "history", status: "ready", data });
  }

  /** Test seam: the tab's state as the integration suite checks it. */
  snapshot(): { open: boolean; visible: boolean; tab: InsightsTab; scope: InsightsScope; range: InsightsRange; reading: InsightsTab[]; posted: InsightsHostMessage[]; spawned: { root: string; args: string[] }[] } {
    return { open: !!this.panel, visible: !!this.panel?.visible, tab: this.tab, scope: this.scope, range: this.range, reading: [...this.reads.keys()], posted: this.posted, spawned: this.spawned };
  }

  dispose(): void {
    this.showSoon.cancel();
    this.panel?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

import { localize } from "./i18n";
import * as vscode from "vscode";
import { debounce } from "./debounce";
import type { RunGit } from "./logQuery";
import { isAbortError, runPool } from "./pool";
import type { RepoDiscovery } from "./repoDiscovery";
import type { Repo } from "./types";
import type { UncommittedStore } from "./uncommittedStore";
import { aheadBehindArgs, behindRepos, FETCH_ENV, fetchArgs, fetchProgress, fetchSummary, parseAheadBehind, pullArgs, pullPlan, pullReason, pullSummary, type AheadBehind } from "./upstream";

/** Fetch All's answer; summary is the status-bar line shown when every fetch succeeded. */
export interface FetchResult { fetched: number; failed: string[]; summary?: string }
/** Pull All Behind's answer: the repositories pulled, and those left as they were (and why). */
export interface PullResult { pulled: string[]; skipped: { name: string; reason: string }[] }

/** For a git run that must finish once started (a merge rewriting the working tree). */
const NEVER_ABORT = new AbortController().signal;
/** Context key: Fetch All is running (the toolbar shows a spinning sync instead of the cloud). */
const FETCHING_KEY = "linyra.fetching";
/** Fetch All: network-bound, so fewer at once than the log reads; and a fetch that hangs stops. */
const FETCH_CONCURRENCY = 8;
const FETCH_TIMEOUT_MS = 60_000;
/** How long the first ahead/behind read waits for VS Code's Git to count a repository before asking git. */
const FIRST_REPORT_MS = 3000;

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** What the upstream work needs from the Log. */
export interface SyncHost {
  /** The Log view: fetch and pull progress shows on its title. */
  viewId: string;
  repos(): readonly Repo[];
  /** Lists the repositories when the Log has not yet (a command run before the view opened). */
  ensureRepos(): Promise<void>;
  maxConcurrency(): number;
  run: RunGit;
  discovery: RepoDiscovery;
  uncommitted: UncommittedStore;
  /** Reads the Log's first page again (pulled commits). */
  reload(): Promise<void>;
  /** Fetch All brought remote branches: the Branch box's suggestions and a branch-mode page are out of date. */
  remotesFetched(): Promise<void>;
  /** Branches moved: in one repository, or in every one (undefined). */
  refsChanged(repoId: string | undefined): void;
  /** Fetching started or stopped. */
  toolbarChanged(): void;
  /** A repository's distance from its upstream changed. */
  syncChanged(byRepo: Record<string, AheadBehind>): void;
}

/**
 * Each repository's distance from its upstream (the Repo List's ↓/↑ badges), and the only
 * things Linyra changes in a repository on its own: Fetch All, Pull and Pull All Behind.
 */
export class SyncController implements vscode.Disposable {
  /** Only repositories ahead of or behind their upstream. */
  private sync = new Map<string, AheadBehind>();
  private fetchRun: Promise<FetchResult> | undefined;
  /** Aborted by dispose and by a new git binary: a fetch in flight stops, with its helpers. */
  private fetchCtl = new AbortController();
  /** Background reads: stopped when Linyra is. */
  private readonly background = new AbortController();
  /** Repositories being pulled: a second click on one waits for nothing and does nothing. */
  private readonly pulling = new Set<string>();
  private readonly changed = new vscode.EventEmitter<void>();
  /** A repository's distance from its upstream changed (the Uncommitted view offers Pull). */
  readonly onDidChange = this.changed.event;
  /** Repositories VS Code's Git reported a HEAD move in, whose upstream distance is read again. */
  private readonly touchedIds = new Set<string>();
  private readonly readSoon = debounce(() => {
    const ids = new Set(this.touchedIds);
    this.touchedIds.clear();
    void this.read(ids);
  }, 400);

  constructor(private readonly host: SyncHost) {}

  /** Fetch All is running. */
  get fetching(): boolean {
    return this.fetchRun !== undefined;
  }

  byRepo(): ReadonlyMap<string, AheadBehind> {
    return this.sync;
  }

  anyBehind(): boolean {
    return [...this.sync.values()].some((state) => state.behind > 0);
  }

  /** The repository has commits to pull (as of the last fetch). */
  isBehind(repoId: string): boolean {
    return (this.sync.get(repoId)?.behind ?? 0) > 0;
  }

  /** Of these repositories, those with commits to pull. */
  behind(repoIds: readonly string[]): string[] {
    return behindRepos([...repoIds], Object.fromEntries(this.sync));
  }

  /** HEAD or the upstream moved in this repository: read its distance again, soon. */
  touched(repoId: string): void {
    this.touchedIds.add(repoId);
    this.readSoon();
  }

  /** The git binary changed: a fetch running on the old one stops. */
  gitChanged(): void {
    this.fetchCtl.abort();
    this.fetchCtl = new AbortController();
  }

  /**
   * Reads ahead/behind for these repositories (every one by default): one git rev-list each,
   * from local refs. Reported only when a count changed.
   */
  /**
   * Each repository's distance from its upstream. `known`: the first read, where VS Code's Git has
   * already counted it for the repositories it watches (no git process for those); after a fetch,
   * a pull or a move, git is asked, since VS Code's Git may not have looked yet.
   */
  async read(only?: ReadonlySet<string>, known = false): Promise<void> {
    const all = this.host.repos();
    const repos = only ? all.filter((r) => only.has(r.id)) : [...all];
    // Right after startup VS Code's Git may not have counted a repository yet: wait (briefly) for it.
    if (known) await Promise.all(repos.map((r) => this.host.discovery.firstReport(r.root, FIRST_REPORT_MS)));
    const settled = await runPool(repos, this.host.maxConcurrency(), async (r, signal) => {
      const counted = known ? this.host.discovery.aheadBehind(r.root) : undefined;
      if (counted) return counted.upstream ? `${counted.ahead}	${counted.behind}` : "";
      return this.host.run(r.root, aheadBehindArgs(), signal);
    }, this.background.signal);
    const next = new Map(only ? this.sync : []);
    settled.forEach((s, i) => {
      const ab = s.status === "fulfilled" ? parseAheadBehind(s.value) : null;
      if (ab && (ab.ahead > 0 || ab.behind > 0)) next.set(repos[i].id, ab);
      else next.delete(repos[i].id);
    });
    for (const id of next.keys()) if (!all.some((r) => r.id === id)) next.delete(id);
    const key = (m: Map<string, AheadBehind>) => JSON.stringify([...m].sort());
    if (key(next) === key(this.sync)) return;
    this.sync = next;
    this.host.syncChanged(Object.fromEntries(next));
    this.changed.fire();
    void vscode.commands.executeCommand("setContext", "linyra.anyBehind", this.behind([...next.keys()]).length > 0);
  }

  /**
   * Fetch All (the Log's toolbar): git fetch in every repository, a few at a time, then read how
   * far each is from its upstream again. Never prompts (GIT_TERMINAL_PROMPT=0); a fetch that
   * hangs stops after a minute.
   */
  fetchAll(): Promise<FetchResult> {
    if (!this.fetchRun) {
      // The toolbar's cloud turns into a spinning sync until it is done.
      void vscode.commands.executeCommand("setContext", FETCHING_KEY, true);
      this.fetchRun = this.runFetchAll().finally(() => {
        this.fetchRun = undefined;
        this.host.toolbarChanged();
        void vscode.commands.executeCommand("setContext", FETCHING_KEY, false);
        this.host.refsChanged(undefined);
      });
    }
    this.host.toolbarChanged();
    return this.fetchRun;
  }

  private async runFetchAll(): Promise<FetchResult> {
    if (this.host.repos().length === 0) await this.host.ensureRepos();
    const repos = [...this.host.repos()];
    const prune = vscode.workspace.getConfiguration("git").get<boolean>("pruneOnFetch", false) === true;
    // Network work, not disk: fewer at once than the log reads.
    const limit = Math.min(this.host.maxConcurrency(), FETCH_CONCURRENCY);
    const outer = this.fetchCtl.signal;
    // A minute or so over SSH for many repositories: the Log's progress line, and a count in the status bar.
    const settled = await vscode.window.withProgress({ location: { viewId: this.host.viewId }, title: localize("Fetching") }, () =>
      vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Linyra" }, (progress) => {
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
      void vscode.window.showWarningMessage(localize("Linyra could not fetch {0} of {1} repositories: {2}{3}.", failed.length, repos.length, list, more));
    }
    await this.host.remotesFetched();
    await this.read();
    const result: FetchResult = { fetched: repos.length - failed.length, failed: failed.map((f) => f.repo.name) };
    if (failed.length === 0) {
      // What it found, long enough to read after a long wait.
      result.summary = fetchSummary(repos.length, this.behind(repos.map((r) => r.id)).length);
      vscode.window.setStatusBarMessage(result.summary, 8000);
    }
    return result;
  }

  private async fetchOne(repo: Repo, prune: boolean, outer: AbortSignal): Promise<string> {
    const ctl = new AbortController();
    const stop = () => ctl.abort();
    const timer = setTimeout(stop, FETCH_TIMEOUT_MS);
    outer.addEventListener("abort", stop, { once: true });
    try {
      // tree: a timeout also kills ssh and the credential helpers git started.
      return await this.host.run(repo.root, fetchArgs(prune), ctl.signal, { tree: true, env: FETCH_ENV });
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
  async pull(repo: Repo): Promise<void> {
    if (this.pulling.has(repo.id)) return;
    this.pulling.add(repo.id);
    try {
      // Both would fetch into the same remote-tracking refs: let Fetch All finish first.
      if (this.fetchRun) await this.fetchRun;
      // VS Code's own Pull (git.pull) reports its own errors (conflicts, a dirty tree) in its words.
      const viaVsCode = this.host.discovery.vsCodeGitHas(repo.root);
      await vscode.window.withProgress({ location: { viewId: this.host.viewId }, title: localize("Pulling {0}", repo.name) }, async () => {
        if (viaVsCode) await this.host.discovery.pullWithVsCodeGit(repo.root);
        else await this.pullFastForward(repo);
      });
    } catch (e) {
      if (!isAbortError(e) || !this.fetchCtl.signal.aborted) {
        const why = isAbortError(e) ? localize("no answer after {0} s", FETCH_TIMEOUT_MS / 1000)
          : /fast-forward/i.test(messageOf(e)) ? localize("it has diverged from its upstream, and Linyra only fast-forwards here. Pull it in Source Control or a terminal")
          : messageOf(e);
        void vscode.window.showErrorMessage(localize("Linyra could not pull {0}: {1}.", repo.name, why));
      }
    } finally {
      this.pulling.delete(repo.id);
    }
    // The new commits, the branch's distance from its upstream, and its working tree.
    void this.host.uncommitted.readRepo(repo.id);
    await this.host.reload();
    await this.read(new Set([repo.id]));
    this.host.refsChanged(repo.id);
  }

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
      await this.host.run(repo.root, ["pull", "--ff-only", "--quiet", "--recurse-submodules=no"], ctl.signal, { tree: true, env: { ...FETCH_ENV, LC_ALL: "C" } });
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
    if (this.fetchRun) await this.fetchRun;
    if (this.host.repos().length === 0) await this.host.ensureRepos();
    const all = this.host.repos();
    const plan = pullPlan(all.map((r) => r.id), Object.fromEntries(this.sync));
    const byId = (id: string) => all.find((r) => r.id === id)!;
    const repos = plan.pull.map(byId).filter((r) => !this.pulling.has(r.id));
    if (repos.length === 0 && plan.diverged.length === 0) {
      void vscode.window.showInformationMessage(plan.pull.length > 0
        ? localize("Linyra: the repositories behind their upstream are already being pulled.")
        : localize("Linyra: no repository is behind its upstream (as of the last fetch)."));
      return { pulled: [], skipped: [] };
    }
    for (const r of repos) this.pulling.add(r.id);
    const outer = this.fetchCtl.signal;
    let settled: PromiseSettledResult<string>[];
    try {
      settled = await vscode.window.withProgress({ location: { viewId: this.host.viewId }, title: localize("Pulling") }, () =>
        // The pool stops starting merges on an abort; a merge already running is never killed
        // halfway through the working tree. No prompts (hooks and LFS may ask), and git's own words in English for pullReason.
        runPool(repos, Math.min(this.host.maxConcurrency(), FETCH_CONCURRENCY), (r) => this.host.run(r.root, pullArgs(), NEVER_ABORT, { env: { ...FETCH_ENV, LC_ALL: "C" } }), outer));
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
      void vscode.window.showWarningMessage(localize("Linyra pulled {0} of {1} repositories. Left as they were: {2}{3}. Pull those in Source Control or a terminal.", pulled.length, pulled.length + skipped.length, list, more));
    } else {
      vscode.window.setStatusBarMessage(pullSummary(pulled.length), 8000);
    }
    // The new commits, each branch's distance from its upstream, and the working trees.
    for (const r of pulled) void this.host.uncommitted.readRepo(r.id);
    await this.host.reload();
    await this.read();
    this.host.refsChanged(undefined);
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

  dispose(): void {
    this.background.abort();
    this.fetchCtl.abort();
    this.readSoon.cancel();
    this.changed.dispose();
  }
}

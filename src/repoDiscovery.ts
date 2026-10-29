import { localize } from "./i18n";
import { promises as fs } from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { walkForRepos } from "./discoverWalk";
import { excludeRepos, labelRepos, mergeRoots } from "./repos";
import type { Settings } from "./settings";
import type { Repo } from "./types";

// The slice of vscode.git's API that Linyra uses: discovery, and which git binary it found. Its
// Repository.log() cannot express --grep, so it is deliberately not used.
interface GitBranch { name?: string; commit?: string; upstream?: { remote?: string; name?: string }; ahead?: number; behind?: number }
export interface BranchRepository {
  status?(): Promise<void>;
  checkout?(ref: string): Promise<void>;
  createBranch?(name: string, checkout: boolean, ref?: string): Promise<void>;
  setBranchUpstream?(name: string, upstream: string): Promise<void>;
  deleteBranch?(name: string, force?: boolean): Promise<void>;
  fetch?(remote?: string, ref?: string): Promise<void>;
  pull?(): Promise<void>;
  push?(remote?: string, branch?: string, setUpstream?: boolean): Promise<void>;
  merge?(ref: string): Promise<void>;
  rebase?(ref: string): Promise<void>;
  createWorktree?(options: { path: string; branch: string; commitish: string }): Promise<string>;
}
interface GitRepository extends BranchRepository {
  rootUri: vscode.Uri;
  state?: {
    HEAD?: GitBranch;
    onDidChange?: vscode.Event<void>;
    // vscode.git's API v1: what its last status found. untrackedChanges only when git.untrackedChanges is "separate".
    indexChanges?: readonly unknown[];
    workingTreeChanges?: readonly unknown[];
    mergeChanges?: readonly unknown[];
    untrackedChanges?: readonly unknown[];
    remotes?: readonly { name: string; fetchUrl?: string; pushUrl?: string }[];
  };
  status?(): Promise<void>;
  // Absolute file paths; in vscode.git's API v1 since before 1.85.
  add?(paths: string[]): Promise<void>;
  revert?(paths: string[]): Promise<void>;
  clean?(paths: string[]): Promise<void>;
  commit?(message: string, opts?: { all?: boolean | "tracked" }): Promise<void>;
  inputBox?: { value: string };
}

/** A repository's state change in vscode.git. */
export interface RepoStateChange {
  root: string;
  /** Its HEAD commit, branch, upstream or ahead/behind differ from the last report (or from when it was first seen). */
  headMoved: boolean;
  /**
   * vscode.git is still opening repositories (its first reports of each, before its list
   * settled): nothing changed, it only learned the state.
   */
  initial: boolean;
}

/** Two folder paths are one: normalized, no trailing separator, case-insensitive where the file system is. */
function sameRoot(a: string, b: string): boolean {
  const norm = (p: string) => {
    const n = path.normalize(p).replace(/[\\/]+$/, "");
    return process.platform === "win32" || process.platform === "darwin" ? n.toLowerCase() : n;
  };
  // A symlinked workspace folder is vscode.git's real path: compare where both lead too.
  return norm(a) === norm(b) || norm(real(a)) === norm(real(b));
}

/**
 * Folders' real paths (symlinks resolved), learned once per folder off the extension host's
 * thread: a slow or network drive must not stall every extension. real() only reads what
 * learnReal() has resolved; a folder not learned yet compares as written.
 */
const realPaths = new Map<string, string>();
function real(p: string): string {
  return realPaths.get(p) ?? p;
}
async function learnReal(paths: Iterable<string>): Promise<void> {
  await Promise.all([...new Set(paths)].filter((p) => !realPaths.has(p)).map(async (p) => {
    realPaths.set(p, await fs.realpath(p).catch(() => p));
  }));
}

const headKey = (h: GitBranch | undefined) =>
  h ? [h.commit, h.name, h.upstream?.remote, h.upstream?.name, h.ahead, h.behind].map((x) => x ?? "").join("\0") : "";
type GitState = "uninitialized" | "initialized";
interface GitAPI {
  /** The binary vscode.git found (from git.path or its own search). */
  git?: { path?: string };
  state: GitState;
  onDidChangeState: vscode.Event<GitState>;
  repositories: GitRepository[];
  /** The open repository containing a file or folder (case- and symlink-aware), if any. */
  getRepository?(uri: vscode.Uri): GitRepository | null;
  onDidOpenRepository: vscode.Event<GitRepository>;
  onDidCloseRepository: vscode.Event<GitRepository>;
}
interface GitExtension { getAPI(version: 1): GitAPI }

/** vscode.git opens repositories one by one after "initialized"; adopt its list once it has been quiet this long. */
const SETTLE_MS = 1000;

/**
 * Lists the workspace's repositories without ever waiting on vscode.git: the
 * first answer comes from a quick walk of the workspace folders (milliseconds).
 * vscode.git starts in the background; once it has finished opening
 * repositories, its list becomes the source (it honours the user's git
 * settings) and onDidChange fires so the Log can re-check.
 */
export class RepoDiscovery implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [this.emitter];

  /**
   * Whether VS Code's Git has exactly this repository open (not merely a parent of it): then its
   * own commands can act on it. Its lookup handles case and symlinks; the roots are compared
   * normalized, so a nested repository it has not opened never resolves to its parent.
   */
  private vsCodeGitRepo(root: string): GitRepository | undefined {
    const found = this.api?.getRepository?.(vscode.Uri.file(root)) ?? this.api?.repositories.find((r) => sameRoot(r.rootUri.fsPath, root));
    return found && sameRoot(found.rootUri.fsPath, root) ? found : undefined;
  }

  vsCodeGitHas(root: string): boolean {
    return this.vsCodeGitRepo(root) !== undefined;
  }

  /**
   * The HEAD commit of a repository VS Code's Git watches and has found clean: no staged,
   * unstaged, merge or untracked change in its last status. undefined when that is not known
   * (not watched, no status yet, untracked files hidden from it): then git is asked. Its events
   * keep it current, so a clean repository needs no git process of Linyra's own.
   */
  cleanHead(root: string): string | undefined {
    if (!this.reportsChanges(root)) return;
    const state = this.vsCodeGitRepo(root)?.state;
    if (!state?.HEAD?.commit) return;
    const untracked = vscode.workspace.getConfiguration("git", vscode.Uri.file(root)).get<string>("untrackedChanges", "mixed");
    if (untracked === "hidden" || (untracked === "separate" && state.untrackedChanges === undefined)) return;
    const lists = [state.indexChanges, state.workingTreeChanges, state.mergeChanges, state.untrackedChanges ?? []];
    return lists.every((list) => list !== undefined && list.length === 0) ? state.HEAD.commit : undefined;
  }

  /**
   * Uncommitted work as VS Code's Git last found it in a repository it watches, as its status
   * bar marks it (* + !); undefined when not known. Untracked files count only where it lists them.
   */
  workMark(root: string): { changes: boolean; staged: boolean; conflicts: number } | undefined {
    if (!this.reportsChanges(root)) return;
    const state = this.vsCodeGitRepo(root)?.state;
    if (!state?.HEAD || !state.indexChanges || !state.workingTreeChanges) return;
    return { changes: state.workingTreeChanges.length + (state.untrackedChanges?.length ?? 0) > 0, staged: state.indexChanges.length > 0, conflicts: state.mergeChanges?.length ?? 0 };
  }

  /** The remote names VS Code's Git has for a repository it watches (undefined: ask git). */
  remotes(root: string): string[] | undefined {
    if (!this.reportsChanges(root)) return;
    const state = this.vsCodeGitRepo(root)?.state;
    return state?.HEAD && state.remotes ? state.remotes.map((r) => r.name) : undefined;
  }

  /** The remote URLs VS Code's Git has for a repository it watches, origin's first (undefined: ask git). */
  remoteUrls(root: string): string[] | undefined {
    if (!this.reportsChanges(root)) return;
    const state = this.vsCodeGitRepo(root)?.state;
    if (!state?.HEAD || !state.remotes) return;
    const ordered = [...state.remotes.filter((r) => r.name === "origin"), ...state.remotes.filter((r) => r.name !== "origin")];
    return ordered.map((r) => r.fetchUrl ?? r.pushUrl).filter((u): u is string => !!u);
  }

  /** Ahead/behind its upstream as VS Code's Git last found it (undefined: not watched, no status yet). */
  aheadBehind(root: string): { ahead: number; behind: number; upstream: boolean } | undefined {
    if (!this.reportsChanges(root)) return;
    const head = this.vsCodeGitRepo(root)?.state?.HEAD;
    if (!head) return;
    if (!head.upstream) return { ahead: 0, behind: 0, upstream: false };
    return head.ahead === undefined || head.behind === undefined ? undefined : { ahead: head.ahead, behind: head.behind, upstream: true };
  }

  branchRepository(root: string): BranchRepository | undefined {
    return this.vsCodeGitRepo(root);
  }

  /**
   * VS Code's own Pull (git.pull) on this repository, which reports its errors in its own words.
   * Its view of the repository can lag a change made in a terminal (a remote just added, an
   * upstream just set): it reads the repository again first.
   */
  /**
   * The repository as VS Code's Git has it, read again first (its view can lag a change made in
   * a terminal). Stage, Unstage, Discard and Commit go through it, so Source Control stays in step.
   */
  private async gitRepoFor(root: string): Promise<GitRepository> {
    const repo = this.vsCodeGitRepo(root);
    if (!repo) throw new Error(localize("VS Code's Git does not have this repository open"));
    await repo.status?.();
    return repo;
  }

  private abs(root: string, paths: readonly string[]): string[] {
    return paths.map((p) => path.join(root, ...p.split("/")));
  }

  /** git add, through VS Code's Git. Paths are repository-relative, as git prints them. */
  async stage(root: string, paths: string[]): Promise<void> {
    const r = await this.gitRepoFor(root);
    await r.add!(this.abs(root, paths));
  }

  /** Unstage (git restore --staged), through VS Code's Git. */
  async unstage(root: string, paths: string[]): Promise<void> {
    const r = await this.gitRepoFor(root);
    await r.revert!(this.abs(root, paths));
  }

  /**
   * Discard, through VS Code's Git (its paths spelled from its own root: it matches them as URIs).
   * `unstage` are unstaged first, so the working tree goes back to the last commit. New files it
   * does not list (git.untrackedChanges "hidden") it skips without a word: the user confirmed
   * them, so they are deleted here.
   */
  async discard(root: string, paths: string[], untracked: readonly string[] = [], unstage: readonly string[] = []): Promise<void> {
    let r = await this.gitRepoFor(root);
    if (unstage.length > 0) {
      await r.revert!(this.abs(r.rootUri.fsPath, unstage));
      // Its Changes group must now hold what was staged, or clean skips those files.
      r = await this.gitRepoFor(root);
    }
    await r.clean!(this.abs(r.rootUri.fsPath, paths));
    for (const p of untracked) await fs.rm(path.join(r.rootUri.fsPath, ...p.split("/")), { force: true });
  }

  /**
   * Commit the staged files (or, with `all`, every change; "tracked": tracked files only, as
   * git.smartCommitChanges says), through VS Code's Git. A draft in Source Control's message
   * box is kept: vscode.git clears it after any commit.
   */
  async commit(root: string, message: string, all: boolean | "tracked"): Promise<void> {
    const r = await this.gitRepoFor(root);
    const draft = r.inputBox?.value;
    try {
      await r.commit!(message, all ? { all } : undefined);
    } finally {
      if (r.inputBox && draft !== undefined) r.inputBox.value = draft;
    }
  }

  async pullWithVsCodeGit(root: string): Promise<void> {
    const repo = this.vsCodeGitRepo(root);
    if (!repo) throw new Error(localize("VS Code's Git does not have this repository open"));
    await repo.status?.();
    await vscode.commands.executeCommand("git.pull", repo.rootUri);
  }

  /** Roots vscode.git reports state changes for. */
  private readonly watched = new Set<string>();
  private readonly watchedChanged = new vscode.EventEmitter<void>();
  private watchedTimer: ReturnType<typeof setTimeout> | undefined;
  /** vscode.git opens repositories in a burst (68 at startup): one redraw, not one per repository. */
  private watchedChangedSoon(): void {
    clearTimeout(this.watchedTimer);
    this.watchedTimer = setTimeout(() => this.watchedChanged.fire(), 100);
  }
  /** vscode.git opened or closed a repository: which ones can stage has changed. */
  readonly onDidChangeWatched = this.watchedChanged.event;

  /**
   * Whether VS Code's Git reports this repository's changes (it opened the repository, and
   * git.autorefresh is on). Repositories it does not watch get no events at all.
   */
  reportsChanges(root: string): boolean {
    return [...this.watched].some((w) => sameRoot(w, root)) && vscode.workspace.getConfiguration("git", vscode.Uri.file(root)).get<boolean>("autorefresh", true) !== false;
  }

  /** The git binary VS Code's Git extension uses, once it has activated. */
  gitPath(): string | undefined {
    const p = this.api?.git?.path;
    return typeof p === "string" && p !== "" ? p : undefined;
  }
  private started = false;
  /** vscode.git, once it has settled. */
  private ready: GitAPI | undefined;
  private api: GitAPI | undefined;
  private readonly gitFound = new vscode.EventEmitter<void>();
  /** vscode.git has activated and reported its git binary (see gitPath). */
  readonly onDidFindGit = this.gitFound.event;
  private readonly repoStateChanged = new vscode.EventEmitter<RepoStateChange>();
  /** A repository's state changed in vscode.git (a save, a stage, a checkout): its root. */
  readonly onDidChangeRepoState = this.repoStateChanged.event;

  async list(settings: Settings): Promise<Repo[]> {
    if (!this.started) {
      this.started = true;
      void this.startGitApi();
    }
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const walk = await walkForRepos(folders, settings.scanDepth);
    const git = this.ready ? this.ready.repositories.map((r) => r.rootUri.fsPath) : [];
    await learnReal([...walk, ...git, ...folders]);
    return excludeRepos(labelRepos(mergeRoots(walk, git, folders)), settings.excludeRepos);
  }

  private async startGitApi(): Promise<void> {
    const ext = vscode.extensions.getExtension<GitExtension>("vscode.git");
    if (!ext) return;
    let api: GitAPI;
    try {
      api = (ext.isActive ? ext.exports : await ext.activate()).getAPI(1);
    } catch {
      return; // git disabled or the extension failed; the walk stays the source
    }
    this.api = api;
    if (this.gitPath()) this.gitFound.fire();
    // One listener per open repository, dropped when vscode.git closes it.
    const watching = new Map<GitRepository, vscode.Disposable>();
    const watch = (r: GitRepository) => {
      const root = r.rootUri.fsPath;
      // Where HEAD stood when first seen, so the first report after a fetch counts as a move.
      // Unknown until vscode.git's first status: learning it is not a move; a report without
      // it (a failed status) keeps the last one known.
      let head = r.state?.HEAD ? headKey(r.state.HEAD) : undefined;
      const d = r.state?.onDidChange?.(() => {
        const now = r.state?.HEAD ? headKey(r.state.HEAD) : undefined;
        const initial = (head === undefined && now !== undefined) || this.ready === undefined;
        const headMoved = head !== undefined && now !== undefined && now !== head;
        if (now !== undefined) head = now;
        this.repoStateChanged.fire({ root, headMoved, initial });
      });
      if (d) {
        watching.set(r, d);
        this.watched.add(root);
        // Announced once its real path is known, so a symlinked folder is matched from the first ask.
        void learnReal([root]).then(() => this.watchedChangedSoon());
      }
    };
    const unwatch = (r: GitRepository) => {
      watching.get(r)?.dispose();
      watching.delete(r);
      this.watched.delete(r.rootUri.fsPath);
      this.watchedChangedSoon();
    };
    api.repositories.forEach(watch);
    this.disposables.push(api.onDidOpenRepository(watch), api.onDidCloseRepository(unwatch), {
      dispose: () => {
        for (const d of watching.values()) d.dispose();
        watching.clear();
      },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settleSoon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const first = !this.ready;
        this.ready = api;
        if (first || api.repositories.length > 0) this.emitter.fire();
      }, SETTLE_MS);
    };
    this.disposables.push(
      api.onDidOpenRepository(() => (this.ready ? this.emitter.fire() : settleSoon())),
      api.onDidCloseRepository(() => (this.ready ? this.emitter.fire() : settleSoon())),
      api.onDidChangeState((st) => st === "initialized" && settleSoon()),
      { dispose: () => clearTimeout(timer) },
    );
    if (api.state === "initialized") settleSoon();
  }

  dispose(): void {
    this.gitFound.dispose();
    this.repoStateChanged.dispose();
    clearTimeout(this.watchedTimer);
    this.watchedChanged.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

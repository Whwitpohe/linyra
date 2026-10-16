import * as path from "path";
import * as vscode from "vscode";
import { ChangesTree, type OpenDiffArgs } from "./changesTree";
import { UNCOMMITTED } from "./types";
import { validPair } from "./compareModel";
import type { ReposWebview } from "./compareProtocol";
import { CompareRepos } from "./compareRepos";
import { CompareSelection, CompareSide, HIDE_SAME, hideSameOf, type CompareMode } from "./compareView";
import { CompareStore, rowLabel } from "./compareStore";
import { GitRunner } from "./git";
import { gitCandidates } from "./gitBinary";
import { HIDE_REPOS_KEY, LogView } from "./logView";
import type { WebviewMessage } from "./protocol";
import { RepoDiscovery } from "./repoDiscovery";
import { RevisionProvider } from "./revisionProvider";
import { SCHEME } from "./revisionUri";
import { BlameView } from "./blameView";
import { readSettings } from "./settings";
import { UncommittedStore } from "./uncommittedStore";
import { UncommittedView } from "./uncommittedView";
import { assignAccents } from "./webview/view";

const UNCOMMITTED_SHOWN = "polylog.uncommitted.shown";

export function activate(context: vscode.ExtensionContext): void {
  void vscode.commands.executeCommand("setContext", "polylog.uncommittedShown", context.workspaceState.get<boolean>(UNCOMMITTED_SHOWN, false));
  const discovery = new RepoDiscovery();
  // All Files reads one folder at a time, through the Log's counted runner (the spawn log sees it).
  const ALL_FILES_KEY = "polylog.changesAllFiles";
  const changes: ChangesTree = new ChangesTree((root, args, signal) => log.countedRun(root, args, signal), context.globalState.get<boolean>(ALL_FILES_KEY, false), () => vscode.workspace.getConfiguration("polylog").get<number>("maxConcurrency", 16));
  const setAllFiles = (on: boolean) => {
    changes.setAllFiles(on);
    void context.globalState.update(ALL_FILES_KEY, on);
    void vscode.commands.executeCommand("setContext", ALL_FILES_KEY, on);
  };
  void vscode.commands.executeCommand("setContext", ALL_FILES_KEY, changes.showsAllFiles);
  // VS Code's git: git.path first, then the binary its Git extension found, then PATH.
  const git = new GitRunner(() => gitCandidates(vscode.workspace.getConfiguration("git").get("path"), discovery.gitPath()));
  // Uncommitted work runs its git through the Log's counted runner (so the spawn log sees it).
  const uncommitted: UncommittedStore = new UncommittedStore({
    run: (cwd, args, signal, opts): Promise<string> => log.countedRun(cwd, args, signal, opts),
    reportsChanges: (root) => discovery.reportsChanges(root),
    canStage: (root) => discovery.vsCodeGitHas(root),
    concurrency: () => readSettings((k) => vscode.workspace.getConfiguration("polylog").get(k)).maxConcurrency,
  });
  const log: LogView = new LogView(context, { discovery, run: git.run, changes, uncommitted });
  /** A commit row's right-click: the Log's { repoId, sha }, a Compare commit row, or the Changes view's root. */
  const commitArg = (arg: unknown): unknown => {
    const n = arg as { kind?: unknown; repoId?: unknown; commit?: { sha?: unknown } } | undefined;
    if (!n || typeof n !== "object" || n.kind !== "commit") return arg;
    if (typeof n.repoId === "string" && typeof n.commit?.sha === "string") return { repoId: n.repoId, sha: n.commit.sha };
    const s = changes.current();
    return s && s.commit.sha !== UNCOMMITTED ? { repoId: s.commit.repoId, sha: s.commit.sha } : undefined;
  };
  /** A file or folder row of any Polylog tree (Changes, Uncommitted, Compare): its repository and repo-relative path. */
  const fileRow = (arg: unknown): { root: string; path: string } | undefined => {
    const n = arg as { kind?: unknown; repoId?: unknown; path?: unknown; owner?: { repoId?: unknown } } | undefined;
    if (!n || typeof n !== "object" || (n.kind !== "file" && n.kind !== "folder") || typeof n.path !== "string") return undefined;
    const repoId = typeof n.repoId === "string" ? n.repoId : typeof n.owner?.repoId === "string" ? n.owner.repoId : changes.current()?.commit.repoId;
    const repo = log.repoList.find((r) => r.id === repoId);
    return repo ? { root: repo.root, path: n.path } : undefined;
  };
  /** A Compare file row, as the file in the workspace (File History and Open File take a file: URI). */
  const compareFile = (arg: unknown): unknown => {
    const side = (arg as { side?: unknown } | undefined)?.side;
    const f = side === "left" || side === "right" ? fileRow(arg) : undefined;
    return f ? vscode.Uri.file(path.join(f.root, ...f.path.split("/"))) : arg;
  };
  /** A right-click in the Changes view on uncommitted work: its repository, and the file if on one. */
  const changesTarget = (arg: unknown): { repoId: string; path?: string } | undefined => {
    const n = arg as { kind?: unknown; path?: unknown; owner?: { repoId?: unknown } } | undefined;
    const s = changes.current();
    if (!n || typeof n !== "object" || s?.commit.sha !== UNCOMMITTED) return undefined;
    if (n.kind === "commit") return { repoId: s.commit.repoId };
    // A folder stands for every file under it.
    return (n.kind === "file" || n.kind === "folder") && typeof n.path === "string" ? { repoId: typeof n.owner?.repoId === "string" ? n.owner.repoId : s.commit.repoId, path: n.path } : undefined;
  };
  /** A Changes view row on the Uncommitted side, as the Uncommitted view's row of that group; other rows as they are. */
  const inGroup = (arg: unknown, group: "staged" | "changes"): unknown => {
    const t = changesTarget(arg);
    return t ? { ...t, group } : arg;
  };
  const repoOf = (arg: unknown): unknown => changesTarget(arg)?.repoId ?? (arg as { repoId?: unknown } | undefined)?.repoId;
  const uncommittedView = new UncommittedView({ store: uncommitted, discovery, accents: () => assignAccents(log.repoList), committed: () => log.commitsChanged(), behind: (id) => log.isBehind(id) });
  const compare = new CompareStore({
    run: (root, args, signal) => log.countedRun(root, args, signal),
    concurrency: () => Math.max(1, Math.min(4, vscode.workspace.getConfiguration("polylog").get<number>("maxConcurrency", 16))),
    repos: () => log.tickedRepos(),
  });
  const selection = new CompareSelection();
  const compareDeps = { context, store: compare, log, selection };
  const compareRepos = new CompareRepos(compareDeps);
  const sides = { left: new CompareSide("left", compareDeps), right: new CompareSide("right", compareDeps) };
  // Hide Files Already on Both: on unless turned off; both sides follow it.
  void vscode.commands.executeCommand("setContext", HIDE_SAME, hideSameOf(context));
  const setHideSame = async (hide: boolean) => {
    await context.globalState.update(HIDE_SAME, hide);
    await vscode.commands.executeCommand("setContext", HIDE_SAME, hide);
    sides.left.hideSameChanged();
    sides.right.hideSameChanged();
  };
  const blame = new BlameView((root, args, signal) => log.countedRun(root, args, signal), () => log.repoList.map((r) => r.root));
  // Group by Repository shows the Repositories pane; on unless the user turned it off.
  void vscode.commands.executeCommand("setContext", HIDE_REPOS_KEY, context.globalState.get<boolean>(HIDE_REPOS_KEY, false));
  // Polylog never opens, expands or reveals a view by itself: hiding and collapsing are the user's.
  context.subscriptions.push(
    // Switching git.path takes effect at once: forget the binary, stop git processes still
    // running on the old one, and read everything again.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("git.path")) return;
      git.reset();
      void log.gitChanged();
    }),
    // VS Code's Git extension reports its binary a moment after startup. If no git could
    // run before that, try again with it (otherwise nothing needs reloading).
    discovery.onDidFindGit(() => {
      if (git.failed()) {
        git.reset();
        void log.gitChanged();
      }
    }),
    discovery,
    changes,
    vscode.window.registerFileDecorationProvider(changes),
    vscode.commands.registerCommand("polylog.fileHistory", (arg?: unknown) => log.fileHistory(compareFile(arg))),
    vscode.commands.registerCommand("polylog.openWorkingFile", (arg?: unknown) => log.openWorkingFile(compareFile(arg))),
    vscode.commands.registerCommand("polylog.copyFilePath", async (arg?: unknown) => {
      const f = fileRow(arg);
      if (f) await vscode.env.clipboard.writeText(path.join(f.root, ...f.path.split("/")));
    }),
    vscode.commands.registerCommand("polylog.copyRelativePath", async (arg?: unknown) => {
      const f = fileRow(arg);
      if (f) await vscode.env.clipboard.writeText(f.path);
    }),
    vscode.commands.registerCommand("polylog.showRepos", () => log.setGroupByRepo(true)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("polylog.excludeRepos") || e.affectsConfiguration("polylog.scanDepth")) void log.reposSettingChanged();
    }),
    // Uncommitted changes follow the working tree: VS Code's Git reporting a change in a
    // repository, or a save. Only that repository is read again.
    discovery.onDidChangeRepoState((e) => log.repoStateChanged(e.root, e.headMoved, e.initial)),
    discovery.onDidChangeWatched(() => uncommittedView.refresh()),
    log.onDidChangeSync(() => uncommittedView.refresh()),
    log.onDidChangeScope(() => void compare.scopeChanged()),
    compare,
    selection,
    compareRepos,
    vscode.window.registerWebviewViewProvider(CompareRepos.viewType, compareRepos),
    sides.left,
    sides.right,
    vscode.window.registerFileDecorationProvider(sides.left),
    vscode.window.registerFileDecorationProvider(sides.right),
    vscode.commands.registerCommand("polylog.compareBranches", () => compareRepos.open()),
    vscode.commands.registerCommand("polylog.compareWith", () => (log.branchBox ? compareRepos.compareWith(log.branchBox) : compareRepos.pick())),
    vscode.commands.registerCommand("polylog.comparePick", () => compareRepos.pick()),
    vscode.commands.registerCommand("polylog.compareClose", () => compareRepos.close()),
    // The Log toolbar's toggles: the outline icon shows a view, the filled one (shown) hides it.
    vscode.commands.registerCommand("polylog.compareShow", () => compareRepos.open()),
    vscode.commands.registerCommand("polylog.compareHide", () => compareRepos.close()),
    vscode.commands.registerCommand("polylog.uncommittedShow", () => vscode.commands.executeCommand("polylog.focusUncommitted")),
    vscode.commands.registerCommand("polylog.uncommittedHide", () => vscode.commands.executeCommand("polylog.uncommittedClose")),
    vscode.commands.registerCommand("polylog.compareSwap", () => compareRepos.swap()),
    vscode.commands.registerCommand("polylog.compareShowCommits", () => compareRepos.setMode("commits")),
    vscode.commands.registerCommand("polylog.compareShowFiles", () => compareRepos.setMode("files")),
    vscode.commands.registerCommand("polylog.compareHideSame", () => setHideSame(true)),
    vscode.commands.registerCommand("polylog.compareShowSame", () => setHideSame(false)),
    vscode.commands.registerCommand("polylog.compareRefresh", () => compareRepos.refresh()),
    vscode.commands.registerCommand("polylog.compareOpenFile", (arg?: { side?: unknown }) => (arg?.side === "left" || arg?.side === "right" ? sides[arg.side].openFile(arg) : undefined)),
    vscode.commands.registerCommand("polylog.compareOpenSinceSplit", (arg?: { side?: unknown; repoId?: unknown; path?: unknown }) => {
      // From the tree's right-click the argument is the row; from a test, { side, repoId, path }.
      const side = arg?.side === "left" || arg?.side === "right" ? arg.side : undefined;
      return side ? sides[side].openSinceSplit(arg) : undefined;
    }),
    vscode.commands.registerCommand("polylog.compareMore", (side?: unknown) => (side === "left" || side === "right" ? sides[side].more() : undefined)),
    vscode.workspace.onDidSaveTextDocument((doc) => doc.uri.scheme === "file" && uncommitted.touch(doc.uri.fsPath)),
    uncommitted,
    uncommittedView,
    vscode.window.registerFileDecorationProvider(uncommittedView),
    // The Polylog side bar (Uncommitted) is hidden until the user asks for it (remembered per workspace).
    vscode.commands.registerCommand("polylog.focusUncommitted", async () => {
      await context.workspaceState.update(UNCOMMITTED_SHOWN, true);
      await vscode.commands.executeCommand("setContext", "polylog.uncommittedShown", true);
      await vscode.commands.executeCommand("polylog.uncommitted.focus");
    }),
    vscode.commands.registerCommand("polylog.uncommittedClose", async () => {
      await context.workspaceState.update(UNCOMMITTED_SHOWN, false);
      await vscode.commands.executeCommand("setContext", "polylog.uncommittedShown", false);
    }),
    vscode.commands.registerCommand("polylog.refreshUncommitted", () => uncommitted.readAll(true)),
    // From the Changes view a file row stands for both halves: Stage takes its unstaged one, Unstage its staged one.
    // `many` is the selection when the right-clicked row is in it.
    vscode.commands.registerCommand("polylog.stage", (arg?: unknown, many?: unknown[]) => uncommittedView.stage(inGroup(arg, "changes"), many?.map((m) => inGroup(m, "changes")))),
    vscode.commands.registerCommand("polylog.unstage", (arg?: unknown, many?: unknown[]) => uncommittedView.unstage(inGroup(arg, "staged"), many?.map((m) => inGroup(m, "staged")))),
    vscode.commands.registerCommand("polylog.discard", (arg?: unknown, many?: unknown[]) => uncommittedView.discard(changesTarget(arg) ?? arg, many?.map((m) => changesTarget(m) ?? m))),
    // A repository row (the Uncommitted view, the Log's Uncommitted side, or the Changes view's root): every file it lists.
    vscode.commands.registerCommand("polylog.discardAll", (arg?: unknown) => uncommittedView.discard({ repoId: repoOf(arg) })),
    vscode.commands.registerCommand("polylog.stageAll", (arg?: unknown) => uncommittedView.stage({ repoId: repoOf(arg), group: "changes" })),
    vscode.commands.registerCommand("polylog.unstageAll", (arg?: unknown) => uncommittedView.unstage({ repoId: repoOf(arg), group: "staged" })),
    vscode.commands.registerCommand("polylog.commitRepo", (arg?: unknown) => uncommittedView.commit(changesTarget(arg) ?? arg)),
    vscode.commands.registerCommand("polylog.openUncommittedDiff", (arg?: unknown) => uncommittedView.openDiff(arg)),
    vscode.commands.registerCommand("polylog.hideRepos", () => log.setGroupByRepo(false)),
    // Right-click on a repository in the Log's webview (a Repositories pane row or a commit row).
    vscode.commands.registerCommand("polylog.fetchAll", () => log.fetchAll()),
    // The spinning button while Fetch All runs: already fetching, nothing more to do.
    vscode.commands.registerCommand("polylog.fetching", () => undefined),
    // Right-click a commit row in the Log.
    vscode.commands.registerCommand("polylog.commitCopySha", (arg?: unknown) => log.commitCopySha(commitArg(arg))),
    vscode.commands.registerCommand("polylog.commitCopyMessage", (arg?: unknown) => log.commitCopyMessage(commitArg(arg))),
    vscode.commands.registerCommand("polylog.commitOpenOnRemote", (arg?: unknown) => log.commitOpenOnRemote(commitArg(arg))),
    vscode.commands.registerCommand("polylog.showBehind", () => log.showBehind()),
    vscode.commands.registerCommand("polylog.pullAllBehind", () => log.pullAllBehind()),
    vscode.commands.registerCommand("polylog.fetchAndPullAll", () => log.fetchAndPullAll()),
    vscode.commands.registerCommand("polylog.repoPull", (arg?: unknown) => log.repoPull(arg)),
    vscode.commands.registerCommand("polylog.repoShowOnly", (arg?: unknown) => log.repoShowOnly(arg)),
    vscode.commands.registerCommand("polylog.repoHide", (arg?: unknown) => log.repoHide(arg)),
    vscode.commands.registerCommand("polylog.repoShowAll", () => log.repoShowAll()),
    vscode.commands.registerCommand("polylog.repoExclude", (arg?: unknown) => log.repoExclude(arg)),
    vscode.commands.registerCommand("polylog.repoOpenFolder", (arg?: unknown) => log.repoOpenFolder(arg)),
    vscode.commands.registerCommand("polylog.repoCopyPath", (arg?: unknown) => log.repoCopyPath(arg)),
    log,
    // Retained: switching the panel to Terminal and back must keep selection and scroll.
    vscode.window.registerWebviewViewProvider(LogView.id, log, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new RevisionProvider((root, args, signal) => log.countedRun(root, args, signal), () => log.repoList.map((r) => r.root))),
    blame,
    vscode.commands.registerCommand("polylog.open", () => vscode.commands.executeCommand(`${LogView.id}.focus`)),
    vscode.commands.registerCommand("polylog.openDiff", (a: OpenDiffArgs) => log.openDiff(a)),
    vscode.commands.registerCommand("polylog.openRevision", (arg?: unknown) => log.openRevision(arg)),
    vscode.commands.registerCommand("polylog.changesShowAll", () => setAllFiles(true)),
    vscode.commands.registerCommand("polylog.changesShowChanged", () => setAllFiles(false)),
    vscode.commands.registerCommand("polylog.copySha", () => {
      const s = changes.current();
      if (s) void vscode.env.clipboard.writeText(s.commit.sha);
    }),
    vscode.commands.registerCommand("polylog.copyMessage", () => {
      const s = changes.current();
      if (s) void vscode.env.clipboard.writeText(s.message || s.commit.subject);
    }),
  );
  // Test seam for the integration suite only; never registered for users.
  if (process.env.POLYLOG_ITEST === "1") {
    context.subscriptions.push(
      vscode.commands.registerCommand("polylog._itest.snapshot", () => log.snapshot()),
      vscode.commands.registerCommand("polylog._itest.blame", () => blame.last),
      vscode.commands.registerCommand("polylog._itest.send", (m: WebviewMessage) => log.onMessage(m)),
      vscode.commands.registerCommand("polylog._itest.uncommitted", () => uncommittedView.snapshot()),
      vscode.commands.registerCommand("polylog._itest.uncommittedShown", () => context.workspaceState.get<boolean>(UNCOMMITTED_SHOWN, false)),
      vscode.commands.registerCommand("polylog._itest.compareStore", () => ({
        pair: compare.pair, reading: compare.reading, rows: compare.results().map((x) => rowLabel(x.repo.name, x.result)),
      })),
      vscode.commands.registerCommand("polylog._itest.comparePick", (p: unknown) => compare.setPair(p === null ? null : validPair(p) ? p : null).then(() => undefined)),
      vscode.commands.registerCommand("polylog._itest.compareRefresh", () => compare.refresh()),
      vscode.commands.registerCommand("polylog._itest.compareSwap", () => compare.swap()),
      vscode.commands.registerCommand("polylog._itest.compare", () => compareRepos.snapshot()),
      vscode.commands.registerCommand("polylog._itest.compareSide", (s: "left" | "right") => sides[s].snapshot()),
      vscode.commands.registerCommand("polylog._itest.compareView", (p: unknown) => (validPair(p) ? compareRepos.setPair(p) : undefined)),
      vscode.commands.registerCommand("polylog._itest.compareMode", (m: CompareMode) => compareRepos.setMode(m)),
      vscode.commands.registerCommand("polylog._itest.compareSelect", (id: string) => compareRepos.select(id)),
      vscode.commands.registerCommand("polylog._itest.comparePosted", () => compareRepos.posted),
      vscode.commands.registerCommand("polylog._itest.compareReposSend", (m: ReposWebview) => compareRepos.onMessage(m)),
      vscode.commands.registerCommand("polylog._itest.expandChanges", (dir: string) => changes.expandPath(dir)),
      vscode.commands.registerCommand("polylog._itest.answer", (v: string | undefined) => uncommittedView.ask.queue(v)),
      vscode.commands.registerCommand("polylog._itest.lastWarning", () => uncommittedView.ask.lastWarning),
      vscode.commands.registerCommand("polylog._itest.asked", () => uncommittedView.ask.asked),
      vscode.commands.registerCommand("polylog._itest.beforeAnswer", (f: (() => Promise<void>) | undefined) => (uncommittedView.ask.beforeAnswer = f)),
    );
  }
}

export function deactivate(): void {}

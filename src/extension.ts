import * as path from "path";
import * as vscode from "vscode";
import { copiedText, copyText, setCopiedText } from "./clipboard";
import { configureI18n } from "./i18n";
import { migratePrivateState } from "./stateMigration";
import { ChangesTree, type OpenDiffArgs } from "./changesTree";
import { ChangesPanel } from "./changesPanel";
import type { CombinedOpen } from "./changesModel";
import { UNCOMMITTED, type Repo } from "./types";
import { validPair } from "./compareModel";
import type { ReposWebview } from "./compareProtocol";
import { CompareRepos } from "./compareRepos";
import { CompareSelection, CompareSide, HIDE_SAME, hideSameOf, MergePreviewDocs, SHOWN as COMPARE_SHOWN, type CompareMode } from "./compareView";
import { CompareStore, rowLabel } from "./compareStore";
import { GitRunner } from "./git";
import { gitCandidates } from "./gitBinary";
import { HIDE_REPOS_KEY, LogView } from "./logView";
import { disposeOutputLog } from "./outputLog";
import type { WebviewMessage } from "./protocol";
import type { CommitWebviewMessage } from "./commitProtocol";
import { RepoDiscovery } from "./repoDiscovery";
import { RevisionProvider } from "./revisionProvider";
import { SCHEME } from "./revisionUri";
import { BlameView } from "./blameView";
import { readSettings } from "./settings";
import { UncommittedStore } from "./uncommittedStore";
import { Ask, UncommittedActions } from "./uncommittedActions";
import { CommitPanel } from "./commitPanel";
import { BranchController, type BranchAction, type StashAction } from "./branchController";
import { CommitActions } from "./commitActions";
import { MultiRepo } from "./multiRepo";
import type { CommitAction } from "./commitActionModel";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  await Promise.all([migratePrivateState(context.workspaceState), migratePrivateState(context.globalState)]);
  configureI18n(vscode.env.language, vscode.l10n.bundle);
  const discovery = new RepoDiscovery();
  // All Files reads one folder at a time, through the Log's counted runner (the spawn log sees it).
  const ALL_FILES_KEY = "linyra.changesAllFiles";
  const changes: ChangesTree = new ChangesTree((root, args, signal) => log.countedRun(root, args, signal), context.globalState.get<boolean>(ALL_FILES_KEY, false), () => vscode.workspace.getConfiguration("linyra").get<number>("maxConcurrency", 16));
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
    cleanHead: (root) => discovery.cleanHead(root),
    canStage: (root) => discovery.vsCodeGitHas(root),
    concurrency: () => readSettings((k) => vscode.workspace.getConfiguration("linyra").get(k)).maxConcurrency,
  });
  const ask = new Ask();
  const log: LogView = new LogView(context, { discovery, run: git.run, changes, uncommitted, ask,
    toolbarFlags: () => ({ compareShown: context.workspaceState.get<boolean>(COMPARE_SHOWN, false) }) });
  const changesPanel = new ChangesPanel(context, changes);
  let compareNode = (arg: unknown): unknown => arg;
  /** A commit row's right-click: the Log's { repoId, sha }, a Compare commit row, or the Changes view's root. */
  const commitArg = (arg: unknown): unknown => {
    arg = compareNode(changes.commandArgument(arg));
    const n = arg as { kind?: unknown; repoId?: unknown; commit?: { sha?: unknown } } | undefined;
    if (!n || typeof n !== "object" || n.kind !== "commit") return arg;
    if (typeof n.repoId === "string" && typeof n.commit?.sha === "string") return { repoId: n.repoId, sha: n.commit.sha };
    const s = changes.current();
    return s && s.commit.sha !== UNCOMMITTED ? { repoId: s.commit.repoId, sha: s.commit.sha } : undefined;
  };
  /** A file or folder row of any Linyra tree (Changes, Uncommitted, Compare): its repository and repo-relative path. */
  const fileRow = (arg: unknown): { root: string; path: string } | undefined => {
    arg = compareNode(changes.commandArgument(arg));
    const n = arg as { kind?: unknown; repoId?: unknown; path?: unknown; owner?: { repoId?: unknown } } | undefined;
    if (!n || typeof n !== "object" || (n.kind !== "file" && n.kind !== "folder") || typeof n.path !== "string") return undefined;
    const repoId = typeof n.repoId === "string" ? n.repoId : typeof n.owner?.repoId === "string" ? n.owner.repoId : changes.current()?.commit.repoId;
    const repo = log.repoList.find((r) => r.id === repoId);
    return repo ? { root: repo.root, path: n.path } : undefined;
  };
  /** A Compare file row, as the file in the workspace (File History and Open File take a file: URI). */
  const compareFile = (arg: unknown): unknown => {
    const fromChanges = typeof (arg as { changesNodeId?: unknown } | undefined)?.changesNodeId === "string";
    arg = compareNode(changes.commandArgument(arg));
    const side = (arg as { side?: unknown } | undefined)?.side;
    const f = fromChanges || side === "left" || side === "right" ? fileRow(arg) : undefined;
    return f ? vscode.Uri.file(path.join(f.root, ...f.path.split("/"))) : arg;
  };
  /** A right-click in the Changes view on uncommitted work: its repository, and the file if on one. */
  const changesTarget = (arg: unknown): { repoId: string; path?: string } | undefined => {
    arg = changes.commandArgument(arg);
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
  const repoOf = (arg: unknown): unknown => changesTarget(arg)?.repoId ?? (changes.commandArgument(arg) as { repoId?: unknown } | undefined)?.repoId;
  const uncommittedActions = new UncommittedActions({ store: uncommitted, discovery, run: log.countedRun, committed: () => log.commitsChanged(), ask });
  // The Commit side bar: Commit and Push… pushes through Push… (multiRepo, made below; used only once Linyra runs).
  const commitPanel = new CommitPanel({ context, store: uncommitted, actions: uncommittedActions, run: log.countedRun, ask,
    accents: () => log.accents(), behind: (id) => log.upstream.isBehind(id), shown: () => void log.uncommittedViewShown(),
    committed: () => log.commitsChanged(), push: (ids) => multiRepo.push(ids) });
  const compare = new CompareStore({
    run: (root, args, signal, opts) => log.countedRun(root, args, signal, opts),
    concurrency: () => Math.max(1, Math.min(4, vscode.workspace.getConfiguration("linyra").get<number>("maxConcurrency", 16))),
    repos: () => log.tickedRepos(),
  });
  const selection = new CompareSelection();
  const mergeDocs = new MergePreviewDocs();
  const compareDeps = { context, store: compare, log, selection, mergeDocs, ask,
    mergeEach: (title: string, plans: { repo: Repo; ref: string }[], skipped: { name: string; reason: string }[]) => multiRepo.mergeEach(title, plans, skipped) };
  const compareRepos = new CompareRepos(compareDeps);
  context.subscriptions.push(mergeDocs, vscode.workspace.registerTextDocumentContentProvider(MergePreviewDocs.scheme, mergeDocs));
  const branchSidebar = new BranchController(context, {
    repos: () => log.repoList, run: (root, args, signal, opts) => log.countedRun(root, args, signal, opts), discovery, ask,
    post: (message) => log.postBranchMessage(message), view: (repoId, branch) => log.selectBranch(repoId, branch),
    compare: async (repoId, branch, current) => { await log.selectBranch(repoId, branch); await compareRepos.comparePair({ left: branch, right: current }, repoId); },
    changed: (id) => log.branchChanged(id), concurrency: () => readSettings((k) => vscode.workspace.getConfiguration("linyra").get(k)).maxConcurrency,
  });
  log.branchSidebar = branchSidebar;
  const multiRepo = new MultiRepo({ viewId: LogView.id, repos: () => log.tickedRepos(), run: log.countedRun, ask,
    fetchAll: () => log.upstream.fetchAll(), changed: (ids) => log.reposChanged(ids) });
  context.subscriptions.push(
    vscode.commands.registerCommand("linyra.branchesAcross", () => multiRepo.branches()),
    vscode.commands.registerCommand("linyra.pushAll", () => multiRepo.push()),
    vscode.commands.registerCommand("linyra.updateProject", () => multiRepo.update()),
  );
  const commitActions = new CommitActions({ commit: (arg) => log.listedCommit(arg), selection: () => log.selectedCommits(), run: log.countedRun, discovery, ask, changed: (id) => log.branchChanged(id) });
  for (const [command, action] of [["linyra.commitCherryPick", "cherryPick"], ["linyra.commitRevert", "revert"], ["linyra.commitReset", "reset"],
    ["linyra.commitCheckout", "checkout"], ["linyra.commitNewBranch", "newBranch"], ["linyra.commitNewTag", "newTag"],
    ["linyra.commitUndo", "undo"], ["linyra.commitReword", "reword"], ["linyra.commitPushUpTo", "pushUpTo"]] satisfies [string, CommitAction][]) {
    context.subscriptions.push(vscode.commands.registerCommand(command, (arg: unknown) => commitActions.run(action, arg)));
  }
  context.subscriptions.push(
    vscode.commands.registerCommand("linyra.commitCompareLocal", (arg: unknown) => commitActions.compareLocal(arg)),
    vscode.commands.registerCommand("linyra.commitCreatePatch", (arg: unknown) => commitActions.createPatch(arg)),
  );
  for (const action of ["view", "copy", "favorite", "compare", "worktreeDiff", "checkout", "create", "rename", "delete", "fetch", "pull", "push", "merge", "rebase", "worktree", "pullMerge", "pullRebase"] satisfies BranchAction[]) {
    context.subscriptions.push(vscode.commands.registerCommand(`linyra.branch.${action}`, (arg: unknown) => branchSidebar.action(action, arg)));
  }
  context.subscriptions.push(branchSidebar, log.onDidChangeRefs((id) => void branchSidebar.refresh(id)));
  for (const action of ["show", "apply", "pop", "drop"] satisfies StashAction[]) {
    context.subscriptions.push(vscode.commands.registerCommand(`linyra.stash.${action}`, (arg: unknown) => branchSidebar.stash(action, arg)));
  }
  context.subscriptions.push(vscode.commands.registerCommand("linyra.stash.create", (arg: unknown) => branchSidebar.stashCreate(arg)));
  const sides = { left: new CompareSide("left", compareDeps), right: new CompareSide("right", compareDeps) };
  compareNode = (arg: unknown): unknown => {
    const side = (arg as { compareSide?: unknown } | undefined)?.compareSide;
    return side === "left" || side === "right" ? sides[side].commandArgument(arg) : arg;
  };
  compareRepos.attachSides(sides);
  // Hide Files Already on Both: on unless turned off; both sides follow it.
  void vscode.commands.executeCommand("setContext", HIDE_SAME, hideSameOf(context));
  const setHideSame = async (hide: boolean) => {
    await context.globalState.update(HIDE_SAME, hide);
    await vscode.commands.executeCommand("setContext", HIDE_SAME, hide);
    sides.left.hideSameChanged();
    sides.right.hideSameChanged();
    compareRepos.toolbarChanged();
  };
  const blame = new BlameView((root, args, signal) => log.countedRun(root, args, signal), () => log.repoList.map((r) => r.root));
  // Group by Repository shows the Repositories pane; on unless the user turned it off.
  void vscode.commands.executeCommand("setContext", HIDE_REPOS_KEY, context.globalState.get<boolean>(HIDE_REPOS_KEY, false));
  // Linyra never opens, expands or reveals a view by itself: hiding and collapsing are the user's.
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
    changesPanel,
    vscode.commands.registerCommand("linyra.openChangesEditor", () => changesPanel.open()),
    vscode.commands.registerCommand("linyra.changes.focus", () => log.showChanges(true, true)),
    vscode.commands.registerCommand("linyra.changes.removeView", () => log.showChanges(false)),
    vscode.window.registerFileDecorationProvider(changes),
    vscode.commands.registerCommand("linyra.fileHistory", (arg?: unknown) => log.fileHistory(compareFile(arg))),
    vscode.commands.registerCommand("linyra.openWorkingFile", (arg?: unknown) => log.openWorkingFile(compareFile(arg))),
    vscode.commands.registerCommand("linyra.copyFilePath", async (arg?: unknown) => {
      const f = fileRow(arg);
      if (f) await copyText(path.join(f.root, ...f.path.split("/")));
    }),
    vscode.commands.registerCommand("linyra.copyRelativePath", async (arg?: unknown) => {
      const f = fileRow(arg);
      if (f) await copyText(f.path);
    }),
    vscode.commands.registerCommand("linyra.showRepos", () => log.setGroupByRepo(true)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("linyra.excludeRepos") || e.affectsConfiguration("linyra.scanDepth")) void log.reposSettingChanged();
      if (e.affectsConfiguration("linyra.profiles")) log.profilesChanged();
    }),
    // Uncommitted changes follow the working tree: VS Code's Git reporting a change in a
    // repository, or a save. Only that repository is read again.
    discovery.onDidChangeRepoState((e) => log.repoStateChanged(e.root, e.headMoved, e.initial)),
    log.onDidChangeScope(() => void compare.scopeChanged()),
    compare,
    selection,
    compareRepos,
    vscode.window.registerWebviewViewProvider(CompareRepos.viewType, compareRepos, { webviewOptions: { retainContextWhenHidden: true } }),
    sides.left,
    sides.right,
    vscode.window.registerFileDecorationProvider(sides.left),
    vscode.window.registerFileDecorationProvider(sides.right),
    vscode.commands.registerCommand("linyra.compareBranches", () => compareRepos.open()),
    vscode.commands.registerCommand("linyra.compareWith", () => (log.branchBox ? compareRepos.compareWith(log.branchBox) : compareRepos.pick())),
    vscode.commands.registerCommand("linyra.comparePick", () => compareRepos.pick()),
    vscode.commands.registerCommand("linyra.compareClose", () => compareRepos.close()),
    // The Log toolbar's toggles: the outline icon shows a view, the filled one (shown) hides it.
    vscode.commands.registerCommand("linyra.compareShow", () => compareRepos.open()),
    vscode.commands.registerCommand("linyra.compareHide", () => compareRepos.close()),
    vscode.commands.registerCommand("linyra.compareSwap", () => compareRepos.swap()),
    vscode.commands.registerCommand("linyra.compareShowCommits", () => compareRepos.setMode("commits")),
    vscode.commands.registerCommand("linyra.compareShowFiles", () => compareRepos.setMode("files")),
    vscode.commands.registerCommand("linyra.compareHideSame", () => setHideSame(true)),
    vscode.commands.registerCommand("linyra.compareShowSame", () => setHideSame(false)),
    vscode.commands.registerCommand("linyra.compareRefresh", () => compareRepos.refresh()),
    vscode.commands.registerCommand("linyra.compareOpenFile", (arg?: unknown) => {
      const value = compareNode(arg) as { side?: unknown } | undefined;
      return value?.side === "left" || value?.side === "right" ? sides[value.side].openFile(value) : undefined;
    }),
    vscode.commands.registerCommand("linyra.compareOpenSinceSplit", (arg?: { side?: unknown; repoId?: unknown; path?: unknown }) => {
      // From the tree's right-click the argument is the row; from a test, { side, repoId, path }.
      const value = compareNode(arg) as typeof arg;
      const side = value?.side === "left" || value?.side === "right" ? value.side : undefined;
      return side ? sides[side].openSinceSplit(value) : undefined;
    }),
    vscode.commands.registerCommand("linyra.compareMore", (side?: unknown) => (side === "left" || side === "right" ? sides[side].more() : undefined)),
    vscode.commands.registerCommand("linyra.compareMergePreview", (arg?: { side?: unknown }) => {
      const value = compareNode(arg) as typeof arg;
      return value?.side === "left" || value?.side === "right" ? sides[value.side].previewMerge(value) : undefined;
    }),
    vscode.commands.registerCommand("linyra.compareCherryPick", (arg?: { compareSide?: unknown }) => {
      const side = arg?.compareSide === "left" || arg?.compareSide === "right" ? sides[arg.compareSide] : undefined;
      const t = side?.cherryPickTargets(arg);
      return t ? commitActions.cherryPickCommits(t.repo, t.commits) : undefined;
    }),
    vscode.commands.registerCommand("linyra.compareMerge", (arg?: { repoId?: unknown }) => compareRepos.mergeIntoRight(typeof arg?.repoId === "string" ? arg.repoId : undefined)),
    vscode.commands.registerCommand("linyra.compareReleaseNotes", () => compareRepos.copyReleaseNotes()),
    vscode.commands.registerCommand("linyra.compareOnlyConflicts", () => compareRepos.setOnlyConflicts(true)),
    vscode.commands.registerCommand("linyra.compareAllConflicts", () => compareRepos.setOnlyConflicts(false)),
    ...(["left", "right"] as const).flatMap((side) => [
      vscode.commands.registerCommand(`linyra.compare${side === "left" ? "Left" : "Right"}.focus`, () => compareRepos.setSideShown(side, true, true)),
      vscode.commands.registerCommand(`linyra.compare${side === "left" ? "Left" : "Right"}.removeView`, () => compareRepos.setSideShown(side, false)),
    ]),
    vscode.workspace.onDidSaveTextDocument((doc) => doc.uri.scheme === "file" && uncommitted.touch(doc.uri.fsPath, true)),
    // Back from another program (a terminal, a Git client): what VS Code's Git does not watch may have changed.
    vscode.window.onDidChangeWindowState((state) => {
      if (!state.focused) return;
      log.windowFocused();
      if (commitPanel.visible) void uncommitted.readUnreported();
    }),
    uncommitted,
    // Uncommitted work is on the Log's Uncommitted side (this command opens it) and in the Commit side bar.
    commitPanel,
    vscode.window.registerWebviewViewProvider(CommitPanel.messageId, commitPanel),
    vscode.window.registerFileDecorationProvider(commitPanel),
    discovery.onDidChangeWatched(() => commitPanel.refresh()),
    log.upstream.onDidChange(() => commitPanel.refresh()),
    log.onDidChangeAccents(() => commitPanel.refresh()),
    vscode.commands.registerCommand("linyra.focusUncommitted", () => log.showUncommitted()),
    vscode.commands.registerCommand("linyra.refreshUncommitted", () => uncommitted.readAll(true)),
    vscode.commands.registerCommand("linyra.commitPanel.diff", (arg?: unknown) => commitPanel.diff(arg)),
    vscode.commands.registerCommand("linyra.commitPanel.rollback", (arg?: unknown, many?: unknown) => commitPanel.rollback(arg, many)),
    vscode.commands.registerCommand("linyra.commitPanel.add", (arg?: unknown, many?: unknown) => commitPanel.addToVcs(arg, many)),
    vscode.commands.registerCommand("linyra.commitPanel.removeFromVcs", (arg?: unknown, many?: unknown) => commitPanel.removeFromVcs(arg, many)),
    vscode.commands.registerCommand("linyra.commitPanel.delete", (arg?: unknown, many?: unknown) => commitPanel.deleteFiles(arg, many)),
    vscode.commands.registerCommand("linyra.commitPanel.ignore", (arg?: unknown, many?: unknown) => commitPanel.ignore(arg, many)),
    vscode.commands.registerCommand("linyra.commitPanel.history", () => commitPanel.history()),
    vscode.commands.registerCommand("linyra.commitPanel.groupRepoOn", () => commitPanel.setGrouping("repo", true)),
    vscode.commands.registerCommand("linyra.commitPanel.groupRepoOff", () => commitPanel.setGrouping("repo", false)),
    vscode.commands.registerCommand("linyra.commitPanel.groupDirOn", () => commitPanel.setGrouping("dir", true)),
    vscode.commands.registerCommand("linyra.commitPanel.groupDirOff", () => commitPanel.setGrouping("dir", false)),
    // From the Changes view a file row stands for both halves: Stage takes its unstaged one, Unstage its staged one.
    // `many` is the selection when the right-clicked row is in it.
    vscode.commands.registerCommand("linyra.stage", (arg?: unknown, many?: unknown[]) => uncommittedActions.stage(inGroup(arg, "changes"), changes.commandSelection(arg, many)?.map((m) => inGroup(m, "changes")))),
    vscode.commands.registerCommand("linyra.unstage", (arg?: unknown, many?: unknown[]) => uncommittedActions.unstage(inGroup(arg, "staged"), changes.commandSelection(arg, many)?.map((m) => inGroup(m, "staged")))),
    vscode.commands.registerCommand("linyra.discard", (arg?: unknown, many?: unknown[]) => uncommittedActions.discard(changesTarget(arg) ?? arg, changes.commandSelection(arg, many)?.map((m) => changesTarget(m) ?? m))),
    // A repository row (the Uncommitted view, the Log's Uncommitted side, or the Changes view's root): every file it lists.
    vscode.commands.registerCommand("linyra.discardAll", (arg?: unknown) => uncommittedActions.discard({ repoId: repoOf(arg) })),
    vscode.commands.registerCommand("linyra.stageAll", (arg?: unknown) => uncommittedActions.stage({ repoId: repoOf(arg), group: "changes" })),
    vscode.commands.registerCommand("linyra.unstageAll", (arg?: unknown) => uncommittedActions.unstage({ repoId: repoOf(arg), group: "staged" })),
    vscode.commands.registerCommand("linyra.commitRepo", (arg?: unknown) => uncommittedActions.commit(changesTarget(arg) ?? arg)),
    vscode.commands.registerCommand("linyra.openUncommittedDiff", (arg?: unknown) => uncommittedActions.openDiff(arg)),
    vscode.commands.registerCommand("linyra.hideRepos", () => log.setGroupByRepo(false)),
    // Right-click on a repository in the Log's webview (a Repositories pane row or a commit row).
    vscode.commands.registerCommand("linyra.fetchAll", () => log.upstream.fetchAll()),
    // The spinning button while Fetch All runs: already fetching, nothing more to do.
    vscode.commands.registerCommand("linyra.fetching", () => undefined),
    // Right-click a commit row in the Log.
    vscode.commands.registerCommand("linyra.commitCopySha", (arg?: unknown) => log.commands.copySha(commitArg(arg))),
    vscode.commands.registerCommand("linyra.commitCopyMessage", (arg?: unknown) => log.commands.copyMessage(commitArg(arg))),
    vscode.commands.registerCommand("linyra.commitOpenOnRemote", (arg?: unknown) => log.commands.openOnRemote(commitArg(arg))),
    vscode.commands.registerCommand("linyra.showBehind", () => log.commands.showBehind()),
    vscode.commands.registerCommand("linyra.pullAllBehind", () => log.upstream.pullAllBehind()),
    vscode.commands.registerCommand("linyra.fetchAndPullAll", () => log.upstream.fetchAndPullAll()),
    vscode.commands.registerCommand("linyra.repoPull", (arg?: unknown) => { const repo = log.contextRepo(arg); return repo && log.upstream.pull(repo); }),
    vscode.commands.registerCommand("linyra.repoShowOnly", (arg?: unknown) => log.commands.showOnly(arg)),
    vscode.commands.registerCommand("linyra.repoHide", (arg?: unknown) => log.commands.hide(arg)),
    vscode.commands.registerCommand("linyra.repoShowAll", () => log.commands.showAll()),
    vscode.commands.registerCommand("linyra.repoExclude", (arg?: unknown) => log.commands.exclude(arg)),
    vscode.commands.registerCommand("linyra.repoOpenFolder", (arg?: unknown) => log.commands.openFolder(arg)),
    vscode.commands.registerCommand("linyra.repoCopyPath", (arg?: unknown) => log.commands.copyPath(arg)),
    vscode.commands.registerCommand("linyra.profileSwitch", () => log.profiles.switch()),
    vscode.commands.registerCommand("linyra.profileShow", (arg?: unknown) => log.profiles.show(arg)),
    vscode.commands.registerCommand("linyra.profileSave", () => log.profiles.save()),
    vscode.commands.registerCommand("linyra.profileUpdate", (arg?: unknown) => log.profiles.update(arg)),
    vscode.commands.registerCommand("linyra.profileRename", (arg?: unknown) => log.profiles.rename(arg)),
    vscode.commands.registerCommand("linyra.profileDelete", (arg?: unknown) => log.profiles.delete(arg)),
    vscode.commands.registerCommand("linyra.repoProfiles", (arg?: unknown) => log.profiles.forRepo(arg)),
    log,
    // Retained: switching the panel to Terminal and back must keep selection and scroll.
    vscode.window.registerWebviewViewProvider(LogView.id, log, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new RevisionProvider((root, args, signal) => log.countedRun(root, args, signal), () => log.repoList.map((r) => r.root))),
    blame,
    vscode.commands.registerCommand("linyra.open", () => vscode.commands.executeCommand(`${LogView.id}.focus`)),
    vscode.commands.registerCommand("linyra.openDiff", (a: OpenDiffArgs) => log.openDiff(a)),
    vscode.commands.registerCommand("linyra.openCombinedDiff", (o: CombinedOpen) => log.openCombinedDiff(o)),
    vscode.commands.registerCommand("linyra.clearSelection", () => log.clearSelection()),
    vscode.commands.registerCommand("linyra.openRevision", (arg?: unknown) => log.openRevision(arg)),
    vscode.commands.registerCommand("linyra.changesShowAll", () => setAllFiles(true)),
    vscode.commands.registerCommand("linyra.changesShowChanged", () => setAllFiles(false)),
    vscode.commands.registerCommand("linyra.copySha", () => {
      const s = changes.current();
      if (s) void copyText(s.commit.sha);
    }),
    vscode.commands.registerCommand("linyra.copyMessage", () => {
      const s = changes.current();
      if (s) void copyText(s.message || s.commit.subject);
    }),
  );
  // Test seam for the integration suite only; never registered for users.
  if (process.env.LINYRA_ITEST === "1") {
    context.subscriptions.push(
      vscode.commands.registerCommand("linyra._itest.branches", () => branchSidebar.snapshot()),
      vscode.commands.registerCommand("linyra._itest.branchWorktreePath", (value: string | undefined) => { branchSidebar.worktreePath = value; }),
      vscode.commands.registerCommand("linyra._itest.snapshot", () => log.snapshot()),
      vscode.commands.registerCommand("linyra._itest.blame", () => blame.last),
      vscode.commands.registerCommand("linyra._itest.send", (m: WebviewMessage) => log.onMessage(m)),
      vscode.commands.registerCommand("linyra._itest.uncommitted", () => uncommittedActions.snapshot()),
      vscode.commands.registerCommand("linyra._itest.commitPanel", () => commitPanel.snapshot()),
      vscode.commands.registerCommand("linyra._itest.commitSend", (m: CommitWebviewMessage) => commitPanel.onMessage(m)),
      vscode.commands.registerCommand("linyra._itest.commitCheck", (ids: string[], on: boolean) => commitPanel.check(ids.map((id) => ({ id })), on)),
      vscode.commands.registerCommand("linyra._itest.compareStore", () => ({
        pair: compare.pair, reading: compare.reading, rows: compare.results().map((x) => rowLabel(x.repo.name, x.result)),
      })),
      vscode.commands.registerCommand("linyra._itest.comparePick", (p: unknown) => compare.setPair(p === null ? null : validPair(p) ? p : null).then(() => undefined)),
      vscode.commands.registerCommand("linyra._itest.compareRefresh", () => compare.refresh()),
      vscode.commands.registerCommand("linyra._itest.compareSwap", () => compare.swap()),
      vscode.commands.registerCommand("linyra._itest.compare", () => compareRepos.snapshot()),
      vscode.commands.registerCommand("linyra._itest.compareSide", (s: "left" | "right") => sides[s].snapshot()),
      vscode.commands.registerCommand("linyra._itest.compareView", (p: unknown) => (validPair(p) ? compareRepos.setPair(p) : undefined)),
      vscode.commands.registerCommand("linyra._itest.compareMode", (m: CompareMode) => compareRepos.setMode(m)),
      vscode.commands.registerCommand("linyra._itest.compareSelect", (id: string) => compareRepos.select(id)),
      vscode.commands.registerCommand("linyra._itest.comparePosted", () => compareRepos.posted),
      vscode.commands.registerCommand("linyra._itest.compareReposSend", (m: ReposWebview) => compareRepos.onMessage(m)),
      vscode.commands.registerCommand("linyra._itest.expandChanges", (dir: string) => changes.expandPath(dir)),
      vscode.commands.registerCommand("linyra._itest.changesMessage", (message: unknown, viewId?: unknown) => changes.onMessage(message, viewId === "editor" ? "editor" : "main")),
      vscode.commands.registerCommand("linyra._itest.clipboard", () => copiedText()),
      vscode.commands.registerCommand("linyra._itest.setClipboard", (text: string) => setCopiedText(text)),
      vscode.commands.registerCommand("linyra._itest.answer", (v: string | undefined) => uncommittedActions.ask.queue(v)),
      vscode.commands.registerCommand("linyra._itest.lastWarning", () => uncommittedActions.ask.lastWarning),
      vscode.commands.registerCommand("linyra._itest.asked", () => uncommittedActions.ask.asked),
      vscode.commands.registerCommand("linyra._itest.beforeAnswer", (f: (() => Promise<void>) | undefined) => (uncommittedActions.ask.beforeAnswer = f)),
    );
  }
}

export function deactivate(): void {
  disposeOutputLog();
}

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
import { openForm } from "./formPanel";
import { OperationActions } from "./operationActions";
import { PatchActions } from "./patchActions";
import { RunAcross } from "./runAcross";
import { OPERATIONS, operationCommand } from "./repoMarkModel";
import type { CommitAction } from "./commitActionModel";
import { aiIfAny } from "./ai/features/commands";
import { registerAiFeatures } from "./ai/features/register";
import { LinyraAi } from "./ai/service";
import { InsightsPanel } from "./insights/panel";
import { locate } from "./insights/range";
import { isSha } from "./types";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  await Promise.all([migratePrivateState(context.workspaceState), migratePrivateState(context.globalState)]);
  configureI18n(vscode.env.language, vscode.l10n.bundle);
  // The AI service (aiService() for every AI feature) and Configure / Switch / Remove AI.
  const aiCore = new LinyraAi(context);
  context.subscriptions.push(aiCore, ...aiCore.commands());
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
  // Release… and Tag Across Repositories… ask through a review form in an editor tab.
  ask.formOpener = (spec, check) => openForm(context.extensionUri, spec, check);
  const log: LogView = new LogView(context, { discovery, run: git.run, changes, uncommitted, ask,
    toolbarFlags: () => ({ compareShown: context.workspaceState.get<boolean>(COMPARE_SHOWN, false) }) });
  const changesPanel = new ChangesPanel(context, changes);
  // A merge, rebase, cherry-pick or revert that stopped: the Repo List's right-click on its row.
  const operations = new OperationActions({ repos: () => log.repoList, contextRepo: (arg) => log.contextRepo(arg), mark: (id) => log.marks.get(id),
    run: log.countedRun, ask, changed: (ids) => log.reposChanged(ids) });
  // Apply Patch…: a repository row's right-click (the Repo List, the Commit side bar), or the palette.
  // ⋯ → Run Git Command Across Repositories…: its report is a read-only document.
  const runAcross = new RunAcross({ repos: () => log.tickedRepos(), viewId: LogView.id, run: log.countedRun, ask,
    concurrency: () => readSettings((k) => vscode.workspace.getConfiguration("linyra").get(k)).maxConcurrency, changed: (ids) => log.reposChanged(ids) });
  const patches = new PatchActions({ repos: () => log.tickedRepos(), contextRepo: (arg) => log.contextRepo(arg), run: log.countedRun, ask,
    changed: (ids) => log.reposChanged(ids) });
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
  const uncommittedActions = new UncommittedActions({ store: uncommitted, discovery, run: log.countedRun, ask });
  // The Commit side bar: Commit and Push… pushes through Push… (multiRepo, made below; used only once Linyra runs).
  const commitPanel = new CommitPanel({ context, store: uncommitted, actions: uncommittedActions, run: log.countedRun, ask,
    accents: () => log.accents(), behind: (id) => log.upstream.isBehind(id), shown: () => void log.uncommittedViewShown(),
    committed: () => log.commitsChanged(), push: (ids) => multiRepo.push(ids),
    aiAvailable: () => aiIfAny() !== undefined, generateMessage: (plan, draft, progress, signal) => ai.features.commitMessage(plan, draft, progress, signal) });
  const compare = new CompareStore({
    run: (root, args, signal, opts) => log.countedRun(root, args, signal, opts),
    concurrency: () => Math.max(1, Math.min(4, vscode.workspace.getConfiguration("linyra").get<number>("maxConcurrency", 16))),
    repos: () => log.tickedRepos(),
  });
  const selection = new CompareSelection();
  const mergeDocs = new MergePreviewDocs();
  const compareDeps = { context, store: compare, log, selection, mergeDocs, ask,
    mergeEach: (title: string, plans: { repo: Repo; merge: () => Promise<unknown> }[], skipped: { name: string; reason: string; failed?: boolean }[], opts?: { quiet?: boolean }) => multiRepo.mergeEach(title, plans, skipped, opts),
    mergeRef: (repo: Repo, ref: string) => multiRepo.mergeRef(repo, ref) };
  const compareRepos = new CompareRepos(compareDeps);
  // The hover card's Compare: the HEAD row's branch against its merge target, in Compare Branches.
  log.hover.compare = (repoId, left, right) => compareRepos.comparePair({ left, right }, repoId);
  context.subscriptions.push(mergeDocs, vscode.workspace.registerTextDocumentContentProvider(MergePreviewDocs.scheme, mergeDocs));
  const branchSidebar = new BranchController(context, {
    repos: () => log.repoList, run: (root, args, signal, opts) => log.countedRun(root, args, signal, opts), discovery, ask,
    post: (message) => log.postBranchMessage(message), view: (repoId, branch) => log.selectBranch(repoId, branch),
    compare: async (repoId, branch, current) => { await log.selectBranch(repoId, branch); await compareRepos.comparePair({ left: branch, right: current }, repoId); },
    changed: (id) => log.branchChanged(id), concurrency: () => readSettings((k) => vscode.workspace.getConfiguration("linyra").get(k)).maxConcurrency,
    // The integration suite answers Stash Changes… through Ask's queue: VS Code's plain input box there.
    ...(process.env.LINYRA_ITEST === "1" ? {} : {
      // ✨ in Stash Changes…: the AI writes the message into Linyra's own box.
      stashWriter: () => ai.features.stashWriter(),
    }),
  });
  log.branchSidebar = branchSidebar;
  const multiRepo = new MultiRepo({ viewId: LogView.id, repos: () => log.tickedRepos(), run: log.countedRun, ask,
    fetchAll: () => log.upstream.fetchAll(), changed: (ids) => log.reposChanged(ids), state: context.globalState });
  // Every command runs with the place it was started from, when its argument names one (a right-click
  // in a Linyra webview, a shortcut naming its button): its choices and names are asked there (Ask.from).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const command = (id: string, run: (...args: any[]) => unknown): vscode.Disposable =>
    vscode.commands.registerCommand(id, (...args: unknown[]) => ask.from(args[0], () => run(...args)));
  context.subscriptions.push(
    // { name }: the branch sheet's Check Out Everywhere… (asks first); else the picker of all three.
    command("linyra.branchesAcross", (arg?: { name?: unknown }) => (typeof arg?.name === "string" ? multiRepo.checkoutNamed(arg.name) : multiRepo.branches())),
    command("linyra.pushAll", () => multiRepo.push()),
    command("linyra.tagAcross", () => multiRepo.tags()),
    command("linyra.updateProject", () => multiRepo.update()),
  );
  const commitActions = new CommitActions({ commit: (arg) => log.listedCommit(arg), selection: () => log.selectedCommits(), run: log.countedRun, discovery, ask, changed: (id) => log.branchChanged(id) });
  for (const [id, action] of [["linyra.commitCherryPick", "cherryPick"], ["linyra.commitRevert", "revert"], ["linyra.commitReset", "reset"],
    ["linyra.commitCheckout", "checkout"], ["linyra.commitNewBranch", "newBranch"], ["linyra.commitNewTag", "newTag"],
    ["linyra.commitUndo", "undo"], ["linyra.commitReword", "reword"], ["linyra.commitPushUpTo", "pushUpTo"]] satisfies [string, CommitAction][]) {
    context.subscriptions.push(command(id, (arg: unknown) => commitActions.run(action, arg)));
  }
  context.subscriptions.push(
    command("linyra.commitCompareLocal", (arg: unknown) => commitActions.compareLocal(arg)),
    command("linyra.commitCreatePatch", (arg: unknown) => commitActions.createPatch(arg)),
  );
  for (const action of ["view", "copy", "favorite", "compare", "worktreeDiff", "checkout", "create", "rename", "delete", "fetch", "pull", "push", "merge", "rebase", "worktree", "pullMerge", "pullRebase", "upstream"] satisfies BranchAction[]) {
    context.subscriptions.push(command(`linyra.branch.${action}`, (arg: unknown) => branchSidebar.action(action, arg)));
  }
  context.subscriptions.push(branchSidebar, log.onDidChangeRefs((id) => void branchSidebar.refresh(id)));
  for (const action of ["show", "apply", "pop", "drop"] satisfies StashAction[]) {
    context.subscriptions.push(command(`linyra.stash.${action}`, (arg: unknown) => branchSidebar.stash(action, arg)));
  }
  context.subscriptions.push(command("linyra.stash.create", (arg: unknown) => branchSidebar.stashCreate(arg)));
  for (const action of ["open", "reveal", "copyPath", "remove"] as const) {
    context.subscriptions.push(command(`linyra.worktree.${action}`, (arg: unknown) => branchSidebar.worktree(action, arg)));
  }
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
    command("linyra.openChangesEditor", () => changesPanel.open()),
    command("linyra.changes.focus", () => log.showChanges(true, true)),
    command("linyra.changes.removeView", () => log.showChanges(false)),
    vscode.window.registerFileDecorationProvider(changes),
    command("linyra.fileHistory", (arg?: unknown) => log.fileHistory(compareFile(arg))),
    // A folder of the Changes view or the Commit side bar: the Log's Path filter for it.
    command("linyra.folderHistory", (arg?: unknown) => log.folderHistory(fileRow(arg))),
    // A File History row's right-click: the file at that commit, with the Log's blame.
    command("linyra.historyBlame", (arg?: unknown) => log.blameAt(arg)),
    command("linyra.openWorkingFile", (arg?: unknown) => log.openWorkingFile(compareFile(arg))),
    command("linyra.copyFilePath", async (arg?: unknown) => {
      const f = fileRow(arg);
      if (f) await copyText(path.join(f.root, ...f.path.split("/")));
    }),
    command("linyra.copyRelativePath", async (arg?: unknown) => {
      const f = fileRow(arg);
      if (f) await copyText(f.path);
    }),
    command("linyra.showRepos", () => log.setGroupByRepo(true)),
    command("linyra.resolveConflicts", (arg?: unknown) => operations.resolve(arg)),
    ...OPERATIONS.flatMap((op) => [
      command(operationCommand(op, "continue"), (arg?: unknown) => operations.continue(arg, op)),
      command(operationCommand(op, "abort"), (arg?: unknown) => operations.abort(arg, op)),
    ]),
    command("linyra.abortAll", () => operations.abortAll()),
    command("linyra.applyPatch", (arg?: unknown) => patches.apply(arg)),
    command("linyra.showBranchSheet", (arg?: unknown) => log.showBranchSheet(arg)),
    runAcross,
    vscode.workspace.registerTextDocumentContentProvider(RunAcross.scheme, runAcross),
    command("linyra.runAcross", () => runAcross.run()),
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
    command("linyra.compareBranches", () => compareRepos.open()),
    // { name }: the branch sheet's Compare… (that branch on ◀, the other side picked); else the Branch box's.
    command("linyra.compareWith", (arg?: { name?: unknown }) => {
      const left = typeof arg?.name === "string" ? arg.name : log.branchBox;
      return left ? compareRepos.compareWith(left) : compareRepos.pick();
    }),
    command("linyra.comparePick", () => compareRepos.pick()),
    command("linyra.compareClose", () => compareRepos.close()),
    // The Log toolbar's toggles: the outline icon shows a view, the filled one (shown) hides it.
    command("linyra.compareShow", () => compareRepos.open()),
    command("linyra.compareHide", () => compareRepos.close()),
    command("linyra.compareSwap", () => compareRepos.swap()),
    command("linyra.compareShowCommits", () => compareRepos.setMode("commits")),
    command("linyra.compareShowFiles", () => compareRepos.setMode("files")),
    command("linyra.compareHideSame", () => setHideSame(true)),
    command("linyra.compareShowSame", () => setHideSame(false)),
    command("linyra.compareRefresh", () => compareRepos.refresh()),
    command("linyra.compareOpenFile", (arg?: unknown) => {
      const value = compareNode(arg) as { side?: unknown } | undefined;
      return value?.side === "left" || value?.side === "right" ? sides[value.side].openFile(value) : undefined;
    }),
    command("linyra.compareOpenSinceSplit", (arg?: { side?: unknown; repoId?: unknown; path?: unknown }) => {
      // From the tree's right-click the argument is the row; from a test, { side, repoId, path }.
      const value = compareNode(arg) as typeof arg;
      const side = value?.side === "left" || value?.side === "right" ? value.side : undefined;
      return side ? sides[side].openSinceSplit(value) : undefined;
    }),
    command("linyra.compareMore", (side?: unknown) => (side === "left" || side === "right" ? sides[side].more() : undefined)),
    command("linyra.compareMergePreview", (arg?: { side?: unknown }) => {
      const value = compareNode(arg) as typeof arg;
      return value?.side === "left" || value?.side === "right" ? sides[value.side].previewMerge(value) : undefined;
    }),
    command("linyra.compareCherryPick", (arg?: { compareSide?: unknown }) => {
      const side = arg?.compareSide === "left" || arg?.compareSide === "right" ? sides[arg.compareSide] : undefined;
      const t = side?.cherryPickTargets(arg);
      return t ? commitActions.cherryPickCommits(t.repo, t.commits) : undefined;
    }),
    command("linyra.compareMerge", (arg?: { repoId?: unknown }) => compareRepos.mergeIntoRight(typeof arg?.repoId === "string" ? arg.repoId : undefined)),
    command("linyra.compareReleaseNotes", () => compareRepos.copyReleaseNotes()),
    command("linyra.release", () => compareRepos.release()),
    command("linyra.compareOnlyConflicts", () => compareRepos.setOnlyConflicts(true)),
    command("linyra.compareAllConflicts", () => compareRepos.setOnlyConflicts(false)),
    ...(["left", "right"] as const).flatMap((side) => [
      command(`linyra.compare${side === "left" ? "Left" : "Right"}.focus`, () => compareRepos.setSideShown(side, true, true)),
      command(`linyra.compare${side === "left" ? "Left" : "Right"}.removeView`, () => compareRepos.setSideShown(side, false)),
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
    command("linyra.focusUncommitted", () => log.showUncommitted()),
    command("linyra.refreshUncommitted", () => uncommitted.readAll(true)),
    command("linyra.commitPanel.diff", (arg?: unknown) => commitPanel.diff(arg)),
    command("linyra.commitPanel.rollback", (arg?: unknown, many?: unknown) => commitPanel.discard(arg, many)),
    command("linyra.commitPanel.add", (arg?: unknown, many?: unknown) => commitPanel.addToVcs(arg, many)),
    command("linyra.commitPanel.removeFromVcs", (arg?: unknown, many?: unknown) => commitPanel.removeFromVcs(arg, many)),
    command("linyra.commitPanel.delete", (arg?: unknown, many?: unknown) => commitPanel.deleteFiles(arg, many)),
    command("linyra.commitPanel.ignore", (arg?: unknown, many?: unknown) => commitPanel.ignore(arg, many)),
    command("linyra.commitPanel.history", () => commitPanel.history()),
    command("linyra.commitPanel.groupRepoOn", () => commitPanel.setGrouping("repo", true)),
    command("linyra.commitPanel.groupRepoOff", () => commitPanel.setGrouping("repo", false)),
    command("linyra.commitPanel.groupDirOn", () => commitPanel.setGrouping("dir", true)),
    command("linyra.commitPanel.groupDirOff", () => commitPanel.setGrouping("dir", false)),
    // From the Changes view a file row stands for both halves: Stage takes its unstaged one, Unstage its staged one.
    // `many` is the selection when the right-clicked row is in it.
    command("linyra.stage", (arg?: unknown, many?: unknown[]) => uncommittedActions.stage(inGroup(arg, "changes"), changes.commandSelection(arg, many)?.map((m) => inGroup(m, "changes")))),
    command("linyra.unstage", (arg?: unknown, many?: unknown[]) => uncommittedActions.unstage(inGroup(arg, "staged"), changes.commandSelection(arg, many)?.map((m) => inGroup(m, "staged")))),
    command("linyra.discard", (arg?: unknown, many?: unknown[]) => uncommittedActions.discard(changesTarget(arg) ?? arg, changes.commandSelection(arg, many)?.map((m) => changesTarget(m) ?? m))),
    // A repository row (the Uncommitted view, the Log's Uncommitted side, or the Changes view's root): every file it lists.
    command("linyra.discardAll", (arg?: unknown) => uncommittedActions.discard({ repoId: repoOf(arg) })),
    command("linyra.stageAll", (arg?: unknown) => uncommittedActions.stage({ repoId: repoOf(arg), group: "changes" })),
    command("linyra.unstageAll", (arg?: unknown) => uncommittedActions.unstage({ repoId: repoOf(arg), group: "staged" })),
    // Commit… on the Uncommitted side or in the Changes view: the Commit side bar, that repository's files checked.
    command("linyra.commitRepo", (arg?: unknown) => commitPanel.openFor(((changesTarget(arg) ?? arg) as { repoId?: unknown } | undefined)?.repoId ?? repoOf(arg))),
    command("linyra.deleteNew", (arg?: unknown, many?: unknown[]) => uncommittedActions.deleteNew(changesTarget(arg) ?? arg, changes.commandSelection(arg, many)?.map((m) => changesTarget(m) ?? m))),
    // Delete New Files…: a folder's, or a whole repository's (the Uncommitted side's row, the Changes view's root).
    command("linyra.deleteNewAll", (arg?: unknown) => uncommittedActions.deleteNew(changesTarget(arg) ?? { repoId: repoOf(arg) })),
    command("linyra.openUncommittedDiff", (arg?: unknown) => uncommittedActions.openDiff(arg)),
    command("linyra.hideRepos", () => log.setGroupByRepo(false)),
    // Right-click on a repository in the Log's webview (a Repositories pane row or a commit row).
    command("linyra.fetchAll", () => log.upstream.fetchAll()),
    // The spinning button while Fetch All runs: already fetching, nothing more to do.
    command("linyra.fetching", () => undefined),
    // Right-click a commit row in the Log.
    command("linyra.commitCopySha", (arg?: unknown) => log.commands.copySha(commitArg(arg))),
    command("linyra.commitCopyMessage", (arg?: unknown) => log.commands.copyMessage(commitArg(arg))),
    command("linyra.commitOpenOnRemote", (arg?: unknown) => log.commands.openOnRemote(commitArg(arg))),
    command("linyra.showBehind", () => log.commands.showBehind()),
    command("linyra.pullAllBehind", () => log.upstream.pullAllBehind()),
    command("linyra.fetchAndPullAll", () => log.upstream.fetchAndPullAll()),
    command("linyra.repoPull", (arg?: unknown) => { const repo = log.contextRepo(arg); return repo && log.upstream.pull(repo); }),
    command("linyra.repoShowOnly", (arg?: unknown) => log.commands.showOnly(arg)),
    command("linyra.repoHide", (arg?: unknown) => log.commands.hide(arg)),
    command("linyra.repoShowAll", () => log.commands.showAll()),
    command("linyra.repoExclude", (arg?: unknown) => log.commands.exclude(arg)),
    command("linyra.repoOpenFolder", (arg?: unknown) => log.commands.openFolder(arg)),
    command("linyra.repoCopyPath", (arg?: unknown) => log.commands.copyPath(arg)),
    command("linyra.profileSwitch", () => log.profiles.switch()),
    command("linyra.profileShow", (arg?: unknown) => log.profiles.show(arg)),
    command("linyra.profileSave", () => log.profiles.save()),
    command("linyra.profileUpdate", (arg?: unknown) => log.profiles.update(arg)),
    command("linyra.profileRename", (arg?: unknown) => log.profiles.rename(arg)),
    command("linyra.profileDelete", (arg?: unknown) => log.profiles.delete(arg)),
    command("linyra.repoProfiles", (arg?: unknown) => log.profiles.forRepo(arg)),
    log,
    // Retained: switching the panel to Terminal and back must keep selection and scroll.
    vscode.window.registerWebviewViewProvider(LogView.id, log, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new RevisionProvider((root, args, signal) => log.countedRun(root, args, signal), () => log.repoList.map((r) => r.root))),
    blame,
    command("linyra.open", () => vscode.commands.executeCommand(`${LogView.id}.focus`)),
    command("linyra.openDiff", (a: OpenDiffArgs) => log.openDiff(a)),
    command("linyra.openCombinedDiff", (o: CombinedOpen) => log.openCombinedDiff(o)),
    command("linyra.clearSelection", () => log.clearSelection()),
    command("linyra.openRevision", (arg?: unknown) => log.openRevision(arg)),
    command("linyra.changesShowAll", () => setAllFiles(true)),
    command("linyra.changesShowChanged", () => setAllFiles(false)),
    command("linyra.copySha", () => {
      const s = changes.current();
      if (s) void copyText(s.commit.sha);
    }),
    command("linyra.copyMessage", () => {
      const s = changes.current();
      if (s) void copyText(s.message || s.commit.subject);
    }),
  );
  // The AI features (src/ai/features): commands over the existing ones; the model only through aiService().
  const ai = registerAiFeatures({ context, log, uncommitted, compare, compareSelection: () => selection.repoId, branches: branchSidebar, mergeDocs, ask, commitArg,
    shownCommit: () => { const s = changes.current(); return s && s.commit.sha !== UNCOMMITTED ? { repoId: s.commit.repoId, sha: s.commit.sha } : undefined; },
    compareTarget: (arg) => {
      const n = compareNode(arg) as { repoId?: unknown; path?: unknown; owner?: { repoId?: unknown } } | undefined;
      return { repoId: typeof n?.repoId === "string" ? n.repoId : typeof n?.owner?.repoId === "string" ? n.owner.repoId : undefined, path: typeof n?.path === "string" ? n.path : undefined };
    },
    compareRepos, multiRepo, commitPanel });
  // Linyra Insights (src/insights): Visual History, Files, Commits and Repository Health, in an editor tab.
  const insights = new InsightsPanel({ context, repos: () => log.repoList, ticked: () => log.tickedRepos(),
    // Opened before the Log ever listed its repositories: list them.
    ensureRepos: () => log.ensureRepos(),
    accents: () => log.accents(), run: log.countedRun, concurrency: () => readSettings((k) => vscode.workspace.getConfiguration("linyra").get(k)).maxConcurrency, ask,
    reveal: (repoId, sha) => vscode.commands.executeCommand("linyra.revealCommit", { repoId, sha }),
    onDidChangeRefs: log.onDidChangeRefs, onDidChangeScope: log.onDidChangeScope, onDidChangeAccents: log.onDidChangeAccents });
  /** Visual History's target: a Changes or Compare row, an Explorer file or folder, or the active editor's file. */
  const visualTarget = async (arg: unknown): Promise<{ root: string; path: string; folder: boolean } | undefined> => {
    const row = fileRow(arg);
    if (row) return { ...row, folder: (compareNode(changes.commandArgument(arg)) as { kind?: unknown } | undefined)?.kind === "folder" };
    const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
    if (uri?.scheme !== "file") return undefined;
    const found = locate(log.repoList, uri.fsPath, process.platform === "win32" || process.platform === "darwin");
    if (!found) return undefined;
    const stat = await vscode.workspace.fs.stat(uri).then((s) => s, () => undefined);
    return { root: found.repo.root, path: found.path, folder: !!stat && (stat.type & vscode.FileType.Directory) !== 0 };
  };
  context.subscriptions.push(insights,
    command("linyra.insights", () => insights.open()),
    command("linyra.visualHistory", async (arg?: unknown) => {
      if (log.repoList.length === 0) await insights.open();
      return insights.visualHistory(await visualTarget(arg));
    }),
    // A commit in the Log (Insights' bubbles): selected where listed, else found by its hash.
    command("linyra.revealCommit", async (arg?: unknown) => {
      const a = arg as { repoId?: unknown; sha?: unknown } | undefined;
      if (typeof a?.repoId === "string" && isSha(a.sha)) await log.showCommit(a.repoId, a.sha);
    }),
  );
  // Test seam for the integration suite only; never registered for users.
  if (process.env.LINYRA_ITEST === "1") {
    context.subscriptions.push(
      command("linyra._itest.insights", () => insights.snapshot()),
      command("linyra._itest.insightsSend", (m: unknown) => insights.onMessage(m)),
    );
    context.subscriptions.push(
      command("linyra._itest.branches", () => branchSidebar.snapshot()),
      command("linyra._itest.branchError", () => branchSidebar.lastError),
      command("linyra._itest.lastDetail", () => uncommittedActions.ask.lastDetail),
      command("linyra._itest.lastItems", () => uncommittedActions.ask.lastItems),
      command("linyra._itest.branchWorktreePath", (value: string | undefined) => { branchSidebar.worktreePath = value; }),
      command("linyra._itest.snapshot", () => log.snapshot()),
      command("linyra._itest.blame", () => blame.last),
      command("linyra._itest.send", (m: WebviewMessage) => log.onMessage(m)),
      // A question asked in the Log (promptModel.ts), and its answer as the webview would give it.
      command("linyra._itest.lastPrompt", () => log.prompts.last),
      command("linyra._itest.promptAnswer", (id: number, answer: unknown) => log.prompts.answered(id, answer)),
      command("linyra._itest.uncommitted", () => uncommittedActions.snapshot()),
      command("linyra._itest.commitPanel", () => commitPanel.snapshot()),
      command("linyra._itest.commitSend", (m: CommitWebviewMessage) => commitPanel.onMessage(m)),
      command("linyra._itest.commitCheck", (ids: string[], on: boolean) => commitPanel.check(ids.map((id) => ({ id })), on)),
      command("linyra._itest.compareStore", () => ({
        // The merge checks after a read count as reading here: a test waits for the whole answer.
        pair: compare.pair, reading: compare.reading || compare.checking, rows: compare.results().map((x) => rowLabel(x.repo.name, x.result)),
      })),
      command("linyra._itest.comparePick", (p: unknown) => compare.setPair(p === null ? null : validPair(p) ? p : null).then(() => undefined)),
      command("linyra._itest.compareRefresh", () => compare.refresh()),
      command("linyra._itest.compareSwap", () => compare.swap()),
      command("linyra._itest.compare", () => compareRepos.snapshot()),
      command("linyra._itest.compareSide", (s: "left" | "right") => sides[s].snapshot()),
      command("linyra._itest.compareView", (p: unknown) => (validPair(p) ? compareRepos.setPair(p) : undefined)),
      command("linyra._itest.compareMode", (m: CompareMode) => compareRepos.setMode(m)),
      command("linyra._itest.compareSelect", (id: string) => compareRepos.select(id)),
      command("linyra._itest.comparePosted", () => compareRepos.posted),
      command("linyra._itest.compareReposSend", (m: ReposWebview) => compareRepos.onMessage(m)),
      command("linyra._itest.expandChanges", (dir: string) => changes.expandPath(dir)),
      command("linyra._itest.changesMessage", (message: unknown, viewId?: unknown) => changes.onMessage(message, viewId === "editor" ? "editor" : "main")),
      command("linyra._itest.clipboard", () => copiedText()),
      command("linyra._itest.setClipboard", (text: string) => setCopiedText(text)),
      command("linyra._itest.answer", (v: string | undefined) => uncommittedActions.ask.queue(v)),
      command("linyra._itest.lastWarning", () => uncommittedActions.ask.lastWarning),
      command("linyra._itest.lastForm", () => uncommittedActions.ask.lastForm),
      command("linyra._itest.operationError", () => { const e = operations.lastError; operations.lastError = undefined; return e; }),
      command("linyra._itest.runAcross", (line: string) => runAcross.run(line)),
      command("linyra._itest.branchSheet", () => log.branchSheet.last),
      command("linyra._itest.branchSheetAcross", () => log.branchSheet.lastAcross),
      command("linyra._itest.branchSheetAcrossReads", () => log.branchSheet.acrossReads),
      command("linyra._itest.patch", (file?: string) => { patches.testFile = file; const m = patches.lastMessage; patches.lastMessage = undefined; return m; }),
      command("linyra._itest.asked", () => uncommittedActions.ask.asked),
      command("linyra._itest.beforeAnswer", (f: (() => Promise<void>) | undefined) => (uncommittedActions.ask.beforeAnswer = f)),
    );
  }
}

export function deactivate(): void {
  disposeOutputLog();
}

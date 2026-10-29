import { localize } from "./i18n";
import * as vscode from "vscode";
import { copyText } from "./clipboard";
import { Limiter, lsTreeArgs, mergeLevel, parseLsTree } from "./allFiles";
import { decorationFor, describeChanges, describeCombined, stat, viewDescription, type ChangesState, type CombinedOpen, type CombinedState, type NodeDesc, type Owner } from "./changesModel";
import { commitKey, UNCOMMITTED } from "./types";
import { commitDetails } from "./changesPresentation";
import type { CommitReferences } from "./commitReferences";
import type { ChangeRow, ChangesMessage, ChangesPage } from "./changesProtocol";
import { ACCENT_COLORS } from "./webview/view";

/** Runs git in a repository (All Files reads one folder with it). */
export type RunInRepo = (root: string, args: string[], signal: AbortSignal) => Promise<string>;

export interface OpenDiffArgs {
  repoId: string;
  sha: string;
  parent: string | null;
  path: string;
  oldPath?: string;
  /** The file's status in the commit (A, D, …): its empty side needs no git process. */
  status?: string;
}

export interface ChangesSnapshot {
  presentation?: ChangesPage;
  message: string | undefined;
  /** What the view's title says next to "Changes". */
  description: string;
  items: string[];
  /** URI scheme of every node's resourceUri, as VS Code receives it (test seam). */
  schemes: string[];
  /** "<file> <badge> <theme color>" for every decorated file (test seam). */
  decorations: string[];
  /** File history: the highlighted file's label. */
  focused: string | undefined;
  /** What VS Code has selected in the tree (File History reveals its file). */
  selected: string[];
  /** Combined Changes: every file's diff arguments (what a click opens). */
  combined: CombinedOpen[];
}

const nowSec = () => Math.floor(Date.now() / 1000);
const TREE_SCHEME = "linyra-tree";

/** The Changes view reuses the tree model and native commands in a resizable detail layout. */
export class ChangesTree implements vscode.TreeDataProvider<NodeDesc>, vscode.FileDecorationProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<NodeDesc | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly decorationsChanged = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this.decorationsChanged.event;
  /** uri.toString() → decoration, for the files of the commit on screen. */
  private decorations = new Map<string, vscode.FileDecoration>();
  /** The URIs decorated now: a new commit tells VS Code about these and the new ones only. */
  private decorated: vscode.Uri[] = [];
  private send: ((message: ChangesPage | { type: "copied" }) => void) | undefined;
  private isVisible: () => boolean = () => false;
  private readonly additionalViews = new Set<{ send: (message: ChangesPage | { type: "copied" }) => void; visible: () => boolean }>();
  private description = "";
  private selection: NodeDesc[] = [];
  private readonly selections = new Map<string, NodeDesc[]>();
  private nodesById = new Map<string, NodeDesc>();
  private presentation: ChangesPage | undefined;
  private state: ChangesState | null = null;
  private roots: NodeDesc[] = [];
  private message: string | undefined;
  private parents = new Map<NodeDesc, NodeDesc>();
  private focused: NodeDesc | undefined;
  /** All Files: the commit's whole tree, read one folder at a time; folder path → its rows. */
  private allFiles: boolean;
  private loaded = new Map<string, NodeDesc[]>();
  private allReads = new AbortController();
  /** All Files' folder reads, a few at a time: a commit can touch hundreds of folders. */
  private reads: Limiter;
  /** Selects a commit in the Log (a parent hash in the details); false when the Log has not loaded it. */
  selectCommit: ((repoId: string, sha: string) => Promise<boolean>) | undefined;

  constructor(private readonly runInRepo?: RunInRepo, allFiles = false, private readonly concurrency: () => number = () => 16) {
    this.reads = new Limiter(concurrency());
    this.allFiles = allFiles;
    this.render();
  }

  attach(send: (message: ChangesPage | { type: "copied" }) => void, visible: () => boolean): void {
    this.send = send;
    this.isVisible = visible;
  }

  visibilityChanged(): void {
    if (this.visible) { this.post(); void this.hydrate(); }
  }

  subscribe(send: (message: ChangesPage | { type: "copied" }) => void, visible: () => boolean): vscode.Disposable {
    const view = { send, visible };
    this.additionalViews.add(view);
    this.visibilityChanged();
    return new vscode.Disposable(() => this.additionalViews.delete(view));
  }

  private broadcast(message: ChangesPage | { type: "copied" }): void {
    this.send?.(message);
    for (const view of this.additionalViews) view.send(message);
  }

  /** Native webview context menus carry an id, resolved against the current host-owned tree. */
  commandArgument(arg: unknown): unknown {
    const id = (arg as { changesNodeId?: unknown } | undefined)?.changesNodeId;
    return typeof id === "string" ? this.nodesById.get(id) : arg;
  }

  commandSelection(arg: unknown, many?: unknown[]): unknown[] | undefined {
    const node = this.commandArgument(arg);
    const viewId = (arg as { changesViewId?: unknown } | undefined)?.changesViewId;
    const selected = typeof viewId === "string" ? this.selections.get(viewId) ?? [] : this.selection;
    return typeof (arg as { changesNodeId?: unknown } | undefined)?.changesNodeId === "string" && selected.includes(node as NodeDesc)
      ? selected : many;
  }

  async onMessage(value: unknown, viewId = "main"): Promise<void> {
    if (!value || typeof value !== "object") return;
    const m = value as ChangesMessage;
    if (m.type === "action") {
      if (m.action === "expandAll") {
        const state = this.state, combined = this.combined;
        const read = async (nodes: NodeDesc[]): Promise<void> => {
          if (this.state !== state || this.combined !== combined) return;
          await Promise.all(nodes.filter((node) => node.kind !== "file").map(async (node) => read(await this.getChildren(node))));
        };
        await read(this.roots);
        if (this.state === state && this.combined === combined) this.post();
        return;
      }
      if (m.action === "openOnRemote") {
        const details = commitDetails(this.state, this.combined);
        if (details.length === 1) await vscode.commands.executeCommand("linyra.commitOpenOnRemote", { repoId: details[0].repoId, sha: details[0].sha });
        return;
      }
      const command = m.action === "allFiles" ? "linyra.changesShowAll" : m.action === "changedFiles" ? "linyra.changesShowChanged" : m.action === "clearSelection" ? "linyra.clearSelection" : m.action === "openChangesEditor" ? "linyra.openChangesEditor" : undefined;
      if (command) await vscode.commands.executeCommand(command);
      return;
    }
    if (m.type === "ready") { this.post(); await this.hydrate(); return; }
    if (m.type === "selection" && Array.isArray(m.ids)) {
      const selected = m.ids.flatMap((id) => typeof id === "string" && this.nodesById.has(id) ? [this.nodesById.get(id)!] : []);
      this.selections.set(viewId, selected);
      if (viewId === "main") this.selection = selected;
      return;
    }
    if (m.type === "copy" && (m.field === "sha" || m.field === "message")) {
      const detail = commitDetails(this.state, this.combined).find((c) => c.sha === m.sha);
      if (!detail) return;
      if (m.field === "sha") await copyText(detail.sha);
      else if (this.state?.commit.sha === detail.sha && this.state.status === "ready") await copyText(this.state.message || this.state.commit.subject);
      else await vscode.commands.executeCommand("linyra.commitCopyMessage", { repoId: detail.repoId, sha: detail.sha });
      this.broadcast({ type: "copied" });
      return;
    }
    if (m.type === "selectCommit") {
      // Only a parent of a commit on screen: the message is untrusted.
      const parent = commitDetails(this.state, this.combined).some((c) => c.repoId === m.repoId && c.parents?.includes(m.sha));
      if (!parent || !this.selectCommit || await this.selectCommit(m.repoId, m.sha)) return;
      void vscode.window.showInformationMessage(localize("Commit {0} is not loaded in the Log. Load more commits, or search for its hash.", m.sha.slice(0, 7)));
      return;
    }
    if (m.type !== "open" && m.type !== "expand") return;
    const node = this.nodesById.get(m.id);
    if (!node) return;
    if (m.type === "expand" && node.kind !== "file") { await this.getChildren(node); this.post(); return; }
    if (m.type !== "open" || node.kind !== "file") return;
    const command = this.getTreeItem(node).command;
    if (command) await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
  }

  private children(node: NodeDesc): NodeDesc[] {
    return node.kind === "file" ? [] : this.allFilesActive()
      ? this.loaded.get(node.kind === "commit" || node.kind === "repo" ? "" : node.path) ?? [] : node.children;
  }

  private post(): void {
    this.nodesById.clear();
    const row = (node: NodeDesc): ChangeRow => {
      this.nodesById.set(node.id, node);
      const item = this.getTreeItem(node);
      const common = { id: node.id, kind: node.kind === "commit" ? "repo" as const : node.kind,
        label: node.label, description: node.description, tooltip: node.tooltip, contextValue: item.contextValue ?? "",
        path: node.kind === "folder" || node.kind === "file" ? node.path : undefined };
      return node.kind === "file"
        ? { ...common, oldPath: node.file.oldPath, status: node.file.status, added: node.file.added, deleted: node.file.deleted,
          staged: node.file.staged, untracked: node.file.untracked, unchanged: node.unchanged, combined: !!node.combined }
        : { ...common, collapsed: node.kind === "folder" && node.changedCount === 0, children: this.children(node).map(row) };
    };
    const roots = this.roots.map(row);
    // The full commit lives below the files, so its title never occupies a tree row.
    const shown = this.state?.commit.sha !== UNCOMMITTED && this.roots[0]?.kind === "commit" ? roots[0].children ?? [] : roots;
    const details = commitDetails(this.state, this.combined);
    const key = this.state ? commitKey(this.state.commit) : this.combined ? JSON.stringify(this.combined.repos.map((r) => [r.repoId, r.commits.map((c) => c.sha)])) : "";
    const changedRoot = this.allFilesActive() ? describeChanges(this.state, nowSec()).roots[0] : undefined;
    const searchRoots = changedRoot && changedRoot.kind !== "file" ? changedRoot.children.map(row) : undefined;
    const page: ChangesPage = { type: "changes", key: `${key}/${this.allFiles}`, description: this.description, message: this.message,
      roots: shown, searchRoots, details, focusId: this.focused?.id, allFiles: this.allFiles };
    this.presentation = page;
    this.broadcast(page);
  }

  /** As with the native tree, only changed folders expand automatically in All Files. */
  private async hydrate(): Promise<void> {
    if (!this.allFilesActive() || !this.visible || !this.roots[0]) return;
    const state = this.state;
    const read = async (node: NodeDesc): Promise<void> => {
      if (state !== this.state || node.kind === "file") return;
      const rows = await this.getChildren(node);
      if (state !== this.state) return;
      this.post();
      await Promise.all(rows.filter((r) => r.kind === "folder" && (r.changedCount ?? 0) > 0).map(read));
    };
    await read(this.roots[0]);
  }

  get showsAllFiles(): boolean {
    return this.allFiles;
  }

  setAllFiles(on: boolean): void {
    if (on === this.allFiles) return;
    this.allFiles = on;
    this.render();
  }

  /** All Files applies to a loaded commit (not to uncommitted work). */
  private allFilesActive(): boolean {
    return this.allFiles && this.runInRepo !== undefined && this.state?.status === "ready" && this.state.commit.sha !== UNCOMMITTED;
  }

  /** One folder of All Files (read once per commit): its listing at the commit, merged with the changes. */
  private async level(dir: string, parent: NodeDesc): Promise<NodeDesc[]> {
    const ready = this.loaded.get(dir);
    if (ready) return ready;
    const s = this.state!;
    const signal = this.allReads.signal;
    const out = await this.reads.run(dir, () => (signal.aborted ? Promise.resolve("") : this.runInRepo!(s.repoRoot, lsTreeArgs(s.commit.sha, dir), signal))).catch(() => "");
    if (this.loaded.get(dir)) return this.loaded.get(dir)!; // asked twice meanwhile: read once
    if (signal.aborted || this.state !== s) return [];
    const merged = mergeLevel(dir, parseLsTree(out), s.files);
    const owner: Owner = { repoId: s.commit.repoId, sha: s.commit.sha, parent: s.commit.parents[0] ?? null };
    const base = `${commitKey(s.commit)}/all`;
    const rows: NodeDesc[] = [
      ...merged.folders.map((f): NodeDesc => ({ kind: "folder", id: `${base}/d:${f.path}`, label: f.name, description: f.changedCount > 0 ? String(f.changedCount) : "", tooltip: f.path, path: f.path, children: [], changedCount: f.changedCount })),
      ...merged.files.map((f): NodeDesc => f.change
        ? { kind: "file", id: `${base}/f:${f.path}`, label: f.name, description: stat(f.change), tooltip: f.change.oldPath ? `${f.change.oldPath} → ${f.path}` : f.path, path: f.path, file: f.change, openable: f.change.added !== null, owner }
        : { kind: "file", id: `${base}/f:${f.path}`, label: f.name, description: f.submodule ? localize("submodule") : "", tooltip: f.path, path: f.path, file: { path: f.path, added: 0, deleted: 0 }, openable: !f.submodule, owner, unchanged: !f.submodule }),
    ];
    for (const r of rows) this.parents.set(r, parent);
    this.loaded.set(dir, rows);
    // File History in All Files: the file is found once its folder is read.
    const focus = rows.find((r) => r.kind === "file" && r.path === s.focusPath);
    if (focus) {
      this.focused = focus;
      this.revealSoon(focus);
    }
    return rows;
  }

  /** Opens an All Files folder (integration test seam: the tree view cannot be clicked from a test). */
  async expandPath(dir: string): Promise<void> {
    const parent = this.findFolder(dir);
    if (!parent) return;
    await this.level(dir, parent);
    this.emitter.fire(undefined);
    this.post();
  }

  private findFolder(dir: string): NodeDesc | undefined {
    for (const rows of this.loaded.values()) for (const r of rows) if (r.kind === "folder" && r.path === dir) return r;
    return undefined;
  }

  /** Expanded and on screen (integration test seam). */
  get visible(): boolean {
    return this.isVisible() || [...this.additionalViews].some((view) => view.visible());
  }

  set(state: ChangesState | null): void {
    this.state = state;
    this.combined = null;
    this.render();
  }

  /** Combined Changes: several commits' files, a root per repository. */
  setCombined(s: CombinedState | null): void {
    this.state = null;
    this.combined = s;
    this.render();
  }

  currentCombined(): CombinedState | null {
    return this.combined;
  }
  private combined: CombinedState | null = null;

  /** A fresh tree: All Files reads still running for the previous commit stop. */
  private resetAllFiles(): void {
    this.allReads.abort();
    this.allReads = new AbortController();
    this.reads = new Limiter(this.concurrency());
    this.loaded = new Map();
  }

  current(): ChangesState | null {
    return this.state;
  }

  /** References arrive independently; keep in-flight file reads and expanded folders intact. */
  setReferences(repoId: string, sha: string, references: CommitReferences): void {
    if (this.state?.commit.repoId !== repoId || this.state.commit.sha !== sha) return;
    this.state.references = references;
    this.post();
  }

  snapshot(): ChangesSnapshot {
    // All Files: the folders read so far (what is on screen).
    const kids = (n: NodeDesc): NodeDesc[] => (n.kind === "file" ? [] : this.allFilesActive() ? this.loaded.get(n.kind === "commit" || n.kind === "repo" ? "" : n.path) ?? [] : n.children);
    const walk = (nodes: NodeDesc[], depth: number): string[] =>
      nodes.flatMap((n) => [`${"  ".repeat(depth)}${n.label} | ${n.description}`, ...walk(kids(n), depth + 1)]);
    const all = (nodes: NodeDesc[]): NodeDesc[] => nodes.flatMap((n) => [n, ...all(kids(n))]);
    const schemes = all(this.roots).flatMap((n) => {
      const uri = this.getTreeItem(n).resourceUri;
      return uri ? [uri.scheme] : [];
    });
    const decorations = all(this.roots).flatMap((n) => {
      const uri = this.getTreeItem(n).resourceUri;
      const d = uri && this.provideFileDecoration(uri);
      const model = n.kind === "file" ? decorationFor(n.file.status) : undefined;
      return d && model ? [`${n.label} ${d.badge} ${model.color}`] : [];
    });
    return { presentation: this.presentation, message: this.message, description: this.description, items: walk(this.roots, 0), schemes, decorations, focused: this.focused?.label, selected: this.selection.map((n) => n.label),
      combined: all(this.roots).flatMap((n) => (n.kind === "file" && n.combined ? [n.combined] : [])) };
  }

  private render(): void {
    this.resetAllFiles();
    const combined = this.combined ? describeCombined(this.combined) : undefined;
    const d = combined ?? describeChanges(this.state, nowSec());
    this.roots = d.roots;
    this.message = d.message;
    // Next to the title: which repository and commit this is, or its uncommitted work.
    this.description = combined ? combined.description : viewDescription(this.state);
    void vscode.commands.executeCommand("setContext", "linyra.combined", combined !== undefined);
    this.decorations = new Map();
    const before = this.decorated;
    this.decorated = [];
    const files = (nodes: NodeDesc[]): void => nodes.forEach((n) => {
      if (n.kind !== "file") return files(n.children);
      const dec = decorationFor(n.file.status);
      if (!dec) return;
      const uri = this.uriFor(n.path, n.owner);
      this.decorations.set(uri.toString(), new vscode.FileDecoration(dec.badge, dec.tooltip, new vscode.ThemeColor(dec.color)));
      this.decorated.push(uri);
    });
    files(this.roots);
    this.parents = new Map();
    this.focused = undefined;
    const index = (nodes: NodeDesc[], parent?: NodeDesc): void => nodes.forEach((n) => {
      if (parent) this.parents.set(n, parent);
      if (n.kind === "file" && n.path === this.state?.focusPath) this.focused = n;
      if (n.kind !== "file") index(n.children, n);
    });
    index(this.roots);
    this.emitter.fire(undefined);
    const changed = [...before, ...this.decorated];
    if (changed.length > 0) this.decorationsChanged.fire(changed);
    // File history: select the file this history is about, without taking focus from the Log.
    const target = this.focused;
    this.selection = target ? [target] : [];
    this.selections.clear();
    this.selections.set("main", this.selection);
    this.post();
    void this.hydrate();
  }

  /** File History selects its file without moving focus away from the Log. */
  private revealSoon(target: NodeDesc): void {
    this.selection = [target];
  }

  /**
   * Scheme keeps live worktree decorations off; the commit in the query keeps
   * one commit's colors from ever landing on another commit's same path.
   */
  private uriFor(path: string, owner?: Owner): vscode.Uri {
    // The repository too: in Review Uncommitted, the same path can appear in several repos.
    const query = owner ? `${owner.sha}:${owner.repoId}` : this.state?.commit.sha ?? "";
    return vscode.Uri.from({ scheme: TREE_SCHEME, path: `/${path}`, query });
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    return uri.scheme === TREE_SCHEME ? this.decorations.get(uri.toString()) : undefined;
  }

  getParent(node: NodeDesc): NodeDesc | undefined {
    return this.parents.get(node);
  }

  getChildren(node?: NodeDesc): NodeDesc[] | Promise<NodeDesc[]> {
    if (!node) return this.roots;
    if (node.kind === "file") return [];
    if (this.allFilesActive()) return this.level(node.kind === "commit" || node.kind === "repo" ? "" : node.path, node);
    return node.children;
  }

  /** Uncommitted work under a folder ("" for all of it): ".staged" if part is staged, ".changed" if part is not. */
  private workFlags(folder: string): string {
    const s = this.state;
    const under = (s?.files ?? []).filter((f) => folder === "" || f.path.startsWith(`${folder}/`));
    const staged = under.some((f) => s?.stagedPaths?.includes(f.path));
    const changed = under.some((f) => !f.staged);
    return `${staged ? ".staged" : ""}${changed ? ".changed" : ""}`;
  }

  getTreeItem(node: NodeDesc): vscode.TreeItem {
    // All Files: folders holding changes open, the others wait to be opened (and read).
    const closed = node.kind === "folder" && node.changedCount === 0;
    const item = new vscode.TreeItem(node.label, node.kind === "file" ? vscode.TreeItemCollapsibleState.None : closed ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded);
    item.id = node.id;
    item.description = node.description;
    item.tooltip = node.tooltip;
    if (node.kind === "commit") {
      // A commit, or uncommitted work: different icons, so the root row says which at a glance.
      item.iconPath = new vscode.ThemeIcon(this.state?.commit.sha === UNCOMMITTED ? "diff-modified" : "git-commit");
      // Uncommitted work has no SHA or message to copy; it can be discarded instead.
      item.contextValue = this.state?.commit.sha !== UNCOMMITTED ? "commit" : this.state.discardable ? `uncommitted.discardable${this.workFlags("")}` : "uncommitted";
      return item;
    }
    if (node.kind === "repo") {
      // Combined Changes: the repository's own accent, as its chip has in the Log.
      item.iconPath = new vscode.ThemeIcon("repo", new vscode.ThemeColor(ACCENT_COLORS[node.accent % ACCENT_COLORS.length]));
      item.contextValue = "combinedRepo";
      return item;
    }
    // resourceUri lets the file-icon theme pick icons from the name. A private
    // scheme, not the worktree file: URI, so live git and Problems decorations
    // for today's files are not painted onto a historical commit.
    item.resourceUri = this.uriFor(node.path, node.kind === "file" ? node.owner : undefined);
    item.iconPath = node.kind === "folder" ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
    // A folder: Copy Path; on uncommitted work also Stage, Unstage and Discard for every file under it.
    if (node.kind === "folder") item.contextValue = this.state?.commit.sha === UNCOMMITTED && this.state.discardable ? `folder.discardable${this.workFlags(node.path)}` : "folder";
    // A deleted file has no working-tree copy to open: "fileDeleted" drops Open File from its menu.
    if (node.kind === "file") {
      // Uncommitted: .new for a new file (Delete…, not Discard), .staged when part of it is staged (Unstage), .changed when part is not (Stage).
      const s = this.state;
      const work = s?.discardable && !node.unchanged
        ? `.discardable${node.file.untracked ? ".new" : ""}${s.stagedPaths?.includes(node.path) ? ".staged" : ""}${node.file.staged ? "" : ".changed"}`
        : "";
      item.contextValue = `${node.file.status === "D" ? "fileDeleted" : "file"}${work}`;
    }
    if (node.kind === "file" && node.unchanged) {
      // Not changed by the commit: the file as it was then, read-only.
      item.command = { command: "linyra.openRevision", title: localize("Open File at Commit"), arguments: [{ repoId: node.owner.repoId, sha: node.owner.sha, path: node.path }] };
    } else if (node.kind === "file" && node.combined) {
      item.command = { command: "linyra.openCombinedDiff", title: localize("Open Diff"), arguments: [node.combined] };
    } else if (node.kind === "file" && node.openable) {
      const args: OpenDiffArgs = { repoId: node.owner.repoId, sha: node.owner.sha, parent: node.owner.parent, path: node.file.path, oldPath: node.file.oldPath, status: node.file.status };
      item.command = { command: "linyra.openDiff", title: localize("Open Diff"), arguments: [args] };
    }
    return item;
  }

  dispose(): void {
    this.resetAllFiles();
    this.send = undefined;
    this.additionalViews.clear();
    this.isVisible = () => false;
    this.emitter.dispose();
    this.decorationsChanged.dispose();
  }
}

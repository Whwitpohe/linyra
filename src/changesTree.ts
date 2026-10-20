import * as vscode from "vscode";
import { Limiter, lsTreeArgs, mergeLevel, parseLsTree } from "./allFiles";
import { decorationFor, describeChanges, describeCombined, stat, viewDescription, type ChangesState, type CombinedState, type NodeDesc, type Owner } from "./changesModel";
import { commitKey, UNCOMMITTED } from "./types";
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
}

const nowSec = () => Math.floor(Date.now() / 1000);
const TREE_SCHEME = "polylog-tree";

/** The native Changes view: a thin adapter from changesModel's descriptors to TreeItems. */
export class ChangesTree implements vscode.TreeDataProvider<NodeDesc>, vscode.FileDecorationProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<NodeDesc | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly decorationsChanged = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this.decorationsChanged.event;
  /** uri.toString() → decoration, for the files of the commit on screen. */
  private decorations = new Map<string, vscode.FileDecoration>();
  /** The URIs decorated now: a new commit tells VS Code about these and the new ones only. */
  private decorated: vscode.Uri[] = [];
  private readonly view: vscode.TreeView<NodeDesc>;
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

  constructor(private readonly runInRepo?: RunInRepo, allFiles = false, private readonly concurrency: () => number = () => 16) {
    this.reads = new Limiter(concurrency());
    this.allFiles = allFiles;
    this.view = vscode.window.createTreeView("polylog.changes", { treeDataProvider: this, showCollapseAll: true, canSelectMany: true });
    this.render();
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
        : { kind: "file", id: `${base}/f:${f.path}`, label: f.name, description: f.submodule ? "submodule" : "", tooltip: f.path, path: f.path, file: { path: f.path, added: 0, deleted: 0 }, openable: !f.submodule, owner, unchanged: !f.submodule }),
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
  }

  private findFolder(dir: string): NodeDesc | undefined {
    for (const rows of this.loaded.values()) for (const r of rows) if (r.kind === "folder" && r.path === dir) return r;
    return undefined;
  }

  /** Expanded and on screen (integration test seam). */
  get visible(): boolean {
    return this.view.visible;
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
    return { message: this.message, description: this.view.description ?? "", items: walk(this.roots, 0), schemes, decorations, focused: this.focused?.label, selected: this.view.selection.map((n) => n.label) };
  }

  private render(): void {
    this.resetAllFiles();
    const combined = this.combined ? describeCombined(this.combined) : undefined;
    const d = combined ?? describeChanges(this.state, nowSec());
    this.roots = d.roots;
    this.message = d.message;
    this.view.message = d.message;
    // Next to the title: which repository and commit this is, or its uncommitted work.
    this.view.description = combined ? combined.description : viewDescription(this.state);
    void vscode.commands.executeCommand("setContext", "polylog.combined", combined !== undefined);
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
    this.pendingReveal = target;
  }

  /**
   * Selects the File History file once VS Code has fetched the folder holding it: revealed any
   * earlier, or after the tree was redrawn (stepping through commits), VS Code cannot find the
   * node and logs an error.
   */
  private revealSoon(target: NodeDesc): void {
    this.pendingReveal = target;
  }
  private pendingReveal: NodeDesc | undefined;

  /** VS Code has these children: reveal the File History file if it is among them, and still the one shown. */
  private fetched(children: NodeDesc[]): NodeDesc[] {
    const target = this.pendingReveal;
    if (target && children.includes(target)) {
      this.pendingReveal = undefined;
      setTimeout(() => {
        if (this.focused === target) void this.view.reveal(target, { select: true, focus: false }).then(undefined, () => undefined);
      }, 0);
    }
    return children;
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
    if (!node) return this.fetched(this.roots);
    if (node.kind === "file") return [];
    if (this.allFilesActive()) return this.level(node.kind === "commit" || node.kind === "repo" ? "" : node.path, node).then((rows) => this.fetched(rows));
    return this.fetched(node.children);
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
      // Uncommitted: .staged when part of it is staged (Unstage), .changed when part is not (Stage).
      const s = this.state;
      const work = s?.discardable && !node.unchanged
        ? `.discardable${s.stagedPaths?.includes(node.path) ? ".staged" : ""}${node.file.staged ? "" : ".changed"}`
        : "";
      item.contextValue = `${node.file.status === "D" ? "fileDeleted" : "file"}${work}`;
    }
    if (node.kind === "file" && node.unchanged) {
      // Not changed by the commit: the file as it was then, read-only.
      item.command = { command: "polylog.openRevision", title: "Open File at Commit", arguments: [{ repoId: node.owner.repoId, sha: node.owner.sha, path: node.path }] };
    } else if (node.kind === "file" && node.combined) {
      item.command = { command: "polylog.openCombinedDiff", title: "Open Diff", arguments: [node.combined] };
    } else if (node.kind === "file" && node.openable) {
      const args: OpenDiffArgs = { repoId: node.owner.repoId, sha: node.owner.sha, parent: node.owner.parent, path: node.file.path, oldPath: node.file.oldPath, status: node.file.status };
      item.command = { command: "polylog.openDiff", title: "Open Diff", arguments: [args] };
    }
    return item;
  }

  dispose(): void {
    this.view.dispose();
    this.emitter.dispose();
    this.decorationsChanged.dispose();
  }
}

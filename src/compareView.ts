import * as path from "path";
import * as vscode from "vscode";
import { decorationFor, stat } from "./changesModel";
import type { OpenDiffArgs } from "./changesTree";
import { COMMIT_PAGE, shownFiles, sidePage, tipPaths, type RepoCompare, type Side, type SideCommit } from "./compareModel";
import type { CompareMode } from "./compareProtocol";
import type { CompareStore } from "./compareStore";
import { fileTree, type TreeNode } from "./fileTree";
import type { LogView } from "./logView";
import { isAbortError } from "./pool";
import type { FileChange, Repo } from "./types";

export const PAIR = "polylog.compare.pair";
export const RECENT = "polylog.compare.recent";
export const FAVORITES = "polylog.compare.favorites";
export const MODE = "polylog.compare.mode";
export const SHOWN = "polylog.compare.shown";
/** globalState: Hide Files Already on Both (on unless the user turned it off). Also a context key. */
export const HIDE_SAME = "polylog.compareHideSame";
const SCHEME = "polylog-compare";

export type { CompareMode };

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const short = (n: string) => n.replace(/^origin\//, "");
const labelOf = (item: vscode.TreeItem) => (typeof item.label === "string" ? item.label : item.label?.label ?? "");

/** Which repository the side views show. One emitter: both sides follow it. */
export class CompareSelection implements vscode.Disposable {
  repoId: string | undefined;
  /** Chosen for the user (the first listed repository), not by them: it may still move while the list is read. */
  auto = false;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  set(id: string | undefined, auto = false): void {
    this.auto = auto;
    if (id === this.repoId) return;
    this.repoId = id;
    this.emitter.fire();
  }
  /** The mode, the pair or the selected repository's branches changed: the sides read again. */
  touch(): void {
    this.emitter.fire();
  }
  dispose(): void {
    this.emitter.dispose();
  }
}

export interface Deps {
  context: vscode.ExtensionContext;
  store: CompareStore;
  log: LogView;
  selection: CompareSelection;
}

export const modeOf = (context: vscode.ExtensionContext): CompareMode => context.workspaceState.get<CompareMode>(MODE, "files");
export const hideSameOf = (context: vscode.ExtensionContext): boolean => context.globalState.get<boolean>(HIDE_SAME, true);
export const resultOf = (store: CompareStore, repoId: string): { repo: Repo; result: RepoCompare } | undefined => store.results().find((x) => x.repo.id === repoId);
/** The result a side's detail was read for: its two tips and their merge base. */
export const keyOf = (store: CompareStore, repoId: string): string => {
  const c = resultOf(store, repoId)?.result;
  return c?.kind === "differs" ? `${c.leftSha} ${c.rightSha} ${c.base}` : c?.kind ?? "";
};

type SNode =
  | { kind: "folder"; id: string; name: string; path: string; count: number; children: SNode[] }
  /** side and path: a right-click hands the row itself to the command. */
  | { kind: "file"; id: string; repoId: string; side: Side; path: string; name: string; file: FileChange; both: boolean; same?: boolean; commit?: { sha: string; parent: string | null } }
  | { kind: "commit"; id: string; repoId: string; commit: SideCommit }
  | { kind: "more"; id: string };

/** One side of the selected repository: its files since the split (Files) or its commits (Commits). */
export class CompareSide implements vscode.TreeDataProvider<SNode>, vscode.FileDecorationProvider, vscode.Disposable {
  private readonly view: vscode.TreeView<SNode>;
  private readonly emitter = new vscode.EventEmitter<SNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly decorationsChanged = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.decorationsChanged.event;
  private readonly decorations = new Map<string, vscode.FileDecoration>();
  /** The selected repository's detail, for the result it was read for (dropped when that moves). */
  private detail: { repoId: string; key: string; mode: CompareMode; limit: number; tip: string; files?: FileChange[]; both?: Set<string>; same?: Set<string>; commits?: SideCommit[]; more?: boolean } | undefined;
  private limit = COMMIT_PAGE;
  /** The read in flight, for what it was asked: asked again for the same, it is not started again. */
  private reading: { ask: string; read: Promise<NonNullable<CompareSide["detail"]> | undefined> } | undefined;
  /** What the tree last drew: a store change that leaves it the same redraws only the header. */
  private drawn: string | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly side: Side, private readonly deps: Deps) {
    this.view = vscode.window.createTreeView(side === "left" ? "polylog.compareLeft" : "polylog.compareRight", { treeDataProvider: this, showCollapseAll: true });
    this.disposables.push(
      this.view,
      deps.selection.onDidChange(() => {
        this.limit = COMMIT_PAGE;
        this.detail = undefined;
        // The detail is dropped: always redraw, even when what is asked is the same (Refresh).
        this.drawn = undefined;
        this.render();
      }),
      deps.store.onDidChange(() => this.render()),
      // Collapsed or hidden: nothing to read; shown again: the selection is read.
      this.view.onDidChangeVisibility(() => this.view.visible && this.render()),
    );
    this.render();
  }

  private get mode(): CompareMode {
    return modeOf(this.deps.context);
  }

  /** Files mode: the files listed (Hide Files Already on Both applied) and how many it left out. */
  private filesOf(d: NonNullable<CompareSide["detail"]>): { shown: FileChange[]; hidden: number } {
    return shownFiles(d.files ?? [], d.same ?? new Set(), hideSameOf(this.deps.context));
  }

  /** "acme-api · 3 files", and in Files mode the ones hidden as already on both. */
  private countText(): { n: number; text: string } | undefined {
    const d = this.detail;
    if (!d) return undefined;
    if (this.mode !== "files") return { n: d.commits?.length ?? 0, text: plural(d.commits?.length ?? 0, "commit") };
    const f = this.filesOf(d);
    return { n: f.shown.length, text: `${plural(f.shown.length, "file")}${f.hidden > 0 ? ` · ${f.hidden} already on both (hidden)` : ""}` };
  }

  /** The empty-side message: all hidden is not "no changes". */
  private emptyText(): string {
    const d = this.detail;
    return d && this.mode === "files" && this.filesOf(d).hidden > 0 ? "Every file this side changed is already on both branches (Show Files Already on Both in the title bar)." : "No changes on this side.";
  }

  /** Hide Files Already on Both was switched: the tree again, from the detail already read. */
  hideSameChanged(): void {
    this.render();
  }

  private render(): void {
    const pair = this.deps.store.pair;
    const repoId = this.deps.selection.repoId;
    // VS Code title-cases view titles: the branch name goes in the description, as typed.
    const only = pair ? `${short(pair[this.side])} only` : "";
    const hit = repoId ? resultOf(this.deps.store, repoId) : undefined;
    if (this.detail && (this.detail.repoId !== repoId || this.detail.key !== (repoId ? keyOf(this.deps.store, repoId) : "") || this.detail.mode !== this.mode)) this.detail = undefined;
    const count = this.countText();
    const n = count?.n;
    this.view.description = [only, hit ? `${hit.repo.name}${count ? ` · ${count.text}` : ""}` : ""].filter(Boolean).join(" · ");
    this.view.message = !pair || !repoId ? "Select a repository in Repositories."
      : hit?.result.kind === "nobase" ? `${hit.repo.name}: the two branches share no history, so there is no split point.`
      : hit?.result.kind === "error" ? `${hit.repo.name}: git could not compare the branches: ${hit.result.reason}`
      : n === 0 ? this.emptyText() : undefined;
    const ask = this.ask();
    // Hidden: left as drawn until shown. Emptied while hidden, VS Code keeps the rows it drew and
    // logs an error for each when a context key changes (the tab closing).
    if (!this.view.visible) {
      this.drawn = undefined;
      return;
    }
    if (ask === this.drawn) return;
    this.drawn = ask;
    this.emitter.fire(undefined);
  }

  /** What this side shows: the pair, the repository, its result, the mode and the page. */
  private ask(): string {
    const p = this.deps.store.pair;
    const repoId = this.deps.selection.repoId ?? "";
    return [p?.left, p?.right, repoId, repoId ? keyOf(this.deps.store, repoId) : "", this.mode, this.limit, this.waiting(), hideSameOf(this.deps.context)].join("\0");
  }

  /** The selection was made for the user while the list is still read: it may move, so wait for the list. */
  private waiting(): boolean {
    return this.deps.selection.auto && this.deps.store.reading;
  }

  /** The selected repository's detail, read once per result and mode. */
  private read(): Promise<NonNullable<CompareSide["detail"]> | undefined> {
    const repoId = this.deps.selection.repoId;
    const hit = repoId ? resultOf(this.deps.store, repoId) : undefined;
    if (!repoId || hit?.result.kind !== "differs" || this.waiting()) return Promise.resolve(undefined);
    const key = keyOf(this.deps.store, repoId);
    const mode = this.mode;
    const limit = this.limit;
    if (this.detail?.repoId === repoId && this.detail.key === key && this.detail.mode === mode && this.detail.limit === limit) return Promise.resolve(this.detail);
    const ask = this.ask();
    if (this.reading?.ask === ask) return this.reading.read;
    const tip = this.side === "left" ? hit.result.leftSha : hit.result.rightSha;
    const read = (async () => {
      let d: NonNullable<CompareSide["detail"]>;
      if (mode === "files") {
        const f = await this.deps.store.readFiles(repoId);
        d = { repoId, key, mode, limit, tip, files: f[this.side], both: new Set(f.both), same: new Set(f.same) };
      } else {
        const page = sidePage(await this.deps.store.readCommits(repoId, this.side, limit + 1), limit);
        d = { repoId, key, mode, limit, tip, commits: page.rows, more: page.more };
      }
      // Asked for something else meanwhile (another repository, pair, mode or result): dropped.
      if (this.ask() !== ask) return undefined;
      this.detail = d;
      this.newDecorations();
      // The description and "no changes" message need the count: draw them, not the rows again.
      queueMicrotask(() => this.renderHeader());
      return d;
    })();
    this.reading = { ask, read };
    void read.finally(() => {
      if (this.reading?.read === read) this.reading = undefined;
    }).catch(() => undefined);
    return read;
  }

  /** A new detail: the badges are its own (VS Code asks again for the URIs it is told changed). */
  private newDecorations(): void {
    const old = [...this.decorations.keys()].map((u) => vscode.Uri.parse(u));
    this.decorations.clear();
    if (old.length > 0) this.decorationsChanged.fire(old);
  }

  private renderHeader(): void {
    const before = this.view.message;
    const hit = this.detail ? resultOf(this.deps.store, this.detail.repoId) : undefined;
    const count = this.countText();
    const pair = this.deps.store.pair;
    if (hit && count) {
      this.view.description = `${pair ? `${short(pair[this.side])} only · ` : ""}${hit.repo.name} · ${count.text}`;
      const empty = this.emptyText();
      this.view.message = count.n === 0 ? empty : before === "No changes on this side." || before?.startsWith("Every file this side changed") ? undefined : before;
    }
  }

  async getChildren(node?: SNode): Promise<SNode[]> {
    try {
      if (!node) {
        if (!this.view.visible) return [];
        const d = await this.read();
        if (!d) return [];
        if (d.mode === "files") return this.tree(fileTree(this.filesOf(d).shown), `${d.repoId}/${this.side}`, d.repoId, d.both ?? new Set(), "", d.same ?? new Set());
        const rows = (d.commits ?? []).map((commit): SNode => ({ kind: "commit", id: `${d.repoId}/${this.side}/c:${commit.sha}`, repoId: d.repoId, commit }));
        return d.more ? [...rows, { kind: "more", id: "more" }] : rows;
      }
      if (node.kind === "folder") return node.children;
      if (node.kind === "commit") {
        const files = await this.deps.store.readCommitFiles(node.repoId, node.commit.sha);
        return files.map((file): SNode => ({ kind: "file", id: `${node.id}/f:${file.path}`, repoId: node.repoId, side: this.side, path: file.path, name: file.path, file, both: false, commit: { sha: node.commit.sha, parent: node.commit.parents[0] ?? null } }));
      }
      return [];
    } catch (e) {
      if (!isAbortError(e)) void vscode.window.showErrorMessage(`Polylog could not read ${this.side === "left" ? "the left" : "the right"} side: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }

  private tree(nodes: readonly TreeNode[], base: string, repoId: string, both: ReadonlySet<string>, parent: string, same: ReadonlySet<string>): SNode[] {
    return nodes.map((n): SNode => {
      if (n.kind === "folder") {
        const p = parent ? `${parent}/${n.name}` : n.name;
        return { kind: "folder", id: `${base}/d:${p}`, name: n.name, path: p, count: n.count, children: this.tree(n.children, base, repoId, both, p, same) };
      }
      return { kind: "file", id: `${base}/f:${n.file.path}`, repoId, side: this.side, path: n.file.path, name: n.name, file: n.file, both: both.has(n.file.path), same: same.has(n.file.path) };
    });
  }

  getTreeItem(node: SNode): vscode.TreeItem {
    const C = vscode.TreeItemCollapsibleState;
    switch (node.kind) {
      case "folder": {
        const item = new vscode.TreeItem(node.name, C.Expanded);
        item.id = node.id;
        item.description = String(node.count);
        item.resourceUri = vscode.Uri.from({ scheme: SCHEME, path: `/${node.path}`, query: `d:${this.side}` });
        item.iconPath = vscode.ThemeIcon.Folder;
        return item;
      }
      case "file": {
        const item = new vscode.TreeItem(node.name, C.None);
        item.id = node.id;
        item.description = node.same ? `${stat(node.file)} · already on both` : node.both ? `${stat(node.file)} · both` : stat(node.file);
        item.tooltip = node.same ? `${node.file.path}: changed on both sides since the split, and the two branches now have the same content — nothing to merge`
          : node.both ? `${node.file.path}: changed on both sides since the split — look at it before merging`
          : node.file.oldPath ? `${node.file.oldPath} → ${node.file.path}` : node.file.path;
        // A private scheme: the icon theme picks the icon from the name; nothing of today's working tree is painted on it.
        // The tip (Files) or commit (Commits) in the URI: another result is another URI, so its badge is asked for afresh.
        item.resourceUri = vscode.Uri.from({ scheme: SCHEME, path: `/${node.file.path}`, query: `${this.side}:${node.commit?.sha ?? this.detail?.tip ?? ""}:${node.repoId}` });
        item.iconPath = vscode.ThemeIcon.File;
        const dec = decorationFor(node.file.status);
        // Dimmed: the same at both tips, so it brings nothing to the merge.
        if (dec) this.decorations.set(item.resourceUri.toString(), new vscode.FileDecoration(dec.badge, dec.tooltip, new vscode.ThemeColor(node.same ? "disabledForeground" : dec.color)));
        item.command = node.commit
          ? { command: "polylog.openDiff", title: "Open Diff", arguments: [{ repoId: node.repoId, sha: node.commit.sha, parent: node.commit.parent, path: node.file.path, oldPath: node.file.oldPath, status: node.file.status } satisfies OpenDiffArgs] }
          : { command: "polylog.compareOpenFile", title: "Open Diff", arguments: [{ side: this.side, repoId: node.repoId, path: node.file.path }] };
        // Files mode adds Changes since the split; a deleted file has nothing to open in the workspace.
        item.contextValue = `${node.commit ? "compareCommitFile" : "compareFile"}${node.file.status === "D" ? ".deleted" : ""}`;
        return item;
      }
      case "commit": {
        const item = new vscode.TreeItem(node.commit.subject, C.Collapsed);
        item.id = node.id;
        item.description = `${node.commit.author} · ${node.commit.sha.slice(0, 7)}`;
        item.tooltip = `${node.commit.subject}\n${node.commit.author} · ${new Date(node.commit.time * 1000).toLocaleString()}`;
        item.iconPath = new vscode.ThemeIcon("git-commit");
        item.contextValue = "compareCommit";
        return item;
      }
      case "more": {
        const item = new vscode.TreeItem(`Show ${COMMIT_PAGE} more`, C.None);
        item.id = node.id;
        item.command = { command: "polylog.compareMore", title: "Show more", arguments: [this.side] };
        return item;
      }
    }
  }

  /** Show 500 more commits on this side. */
  more(): void {
    this.limit += COMMIT_PAGE;
    this.detail = undefined;
    this.render();
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    return uri.scheme === SCHEME ? this.decorations.get(uri.toString()) : undefined;
  }

  /**
   * A Files-mode file, as the two branches have it now: the right branch (the target) in the
   * left pane, the left branch in the right one — the same from either side view. Only a file
   * of the repository shown here opens.
   */
  async openFile(arg: unknown): Promise<void> {
    const t = this.fileTarget(arg);
    if (!t) return;
    const { f, hit, pair } = t;
    // Each tip's own copy of the file (an absent one is an empty side), under its name there.
    const at = tipPaths(this.side, f);
    await this.deps.log.openDiff({ repoId: hit.repo.id, sha: hit.result.leftSha, parent: hit.result.rightSha, path: at.left, ...(at.right !== at.left ? { oldPath: at.right } : {}) }, false,
      `${path.posix.basename(f.path)} (${short(pair.right)} ↔ ${short(pair.left)}) — ${hit.repo.name}`);
  }

  /** Right-click → Changes since the split: merge base ↔ this side's tip (what the merge brings). */
  async openSinceSplit(arg: unknown): Promise<void> {
    const t = this.fileTarget(arg);
    if (!t) return;
    const { f, hit, pair } = t;
    const tip = this.side === "left" ? hit.result.leftSha : hit.result.rightSha;
    await this.deps.log.openDiff({ repoId: hit.repo.id, sha: tip, parent: hit.result.base, path: f.path, oldPath: f.oldPath, status: f.status }, false,
      `${path.posix.basename(f.path)} (merge base ↔ ${short(pair[this.side])}) — ${hit.repo.name}`);
  }

  /** Only a file of the repository whose files are shown here. */
  private fileTarget(arg: unknown) {
    const a = arg as { repoId?: unknown; path?: unknown } | undefined;
    const d = this.detail;
    if (!d || d.mode !== "files" || a?.repoId !== d.repoId || typeof a.path !== "string") return undefined;
    const f = d.files?.find((x) => x.path === a.path);
    const hit = resultOf(this.deps.store, d.repoId);
    const pair = this.deps.store.pair;
    if (!f || !hit || hit.result.kind !== "differs" || !pair) return undefined;
    return { f, hit: { repo: hit.repo, result: hit.result }, pair };
  }

  async snapshot(): Promise<{ open: boolean; title: string; description: string; message: string | undefined; tree: string[]; files: string[]; dimmed: string[] }> {
    const lines: string[] = [];
    /** "<path> <resourceUri> <badge>" for every file row (test seam). */
    const files: string[] = [];
    /** File rows drawn dimmed (the same at both tips). */
    const dimmed: string[] = [];
    const walk = async (nodes: SNode[], depth: number): Promise<void> => {
      for (const n of nodes) {
        const kids = n.kind === "folder" || n.kind === "commit" ? await this.getChildren(n) : [];
        const item = this.getTreeItem(n);
        lines.push(`${"  ".repeat(depth)}${labelOf(item)} | ${item.description ?? ""}`);
        if (n.kind === "file" && item.resourceUri) {
          const dec = this.provideFileDecoration(item.resourceUri);
          files.push(`${n.file.path} ${item.resourceUri.toString()} ${dec?.badge ?? ""}`);
          if (dec?.color && (dec.color as { id?: string }).id === "disabledForeground") dimmed.push(n.file.path);
        }
        await walk(kids, depth + 1);
      }
    };
    await walk(await this.getChildren(), 0);
    this.renderHeader();
    return { open: this.view.visible, title: this.view.description?.split(" · ")[0] ?? "", description: this.view.description?.split(" · ").slice(1).join(" · ") ?? "", message: this.view.message, tree: lines, files, dimmed };
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.emitter.dispose();
    this.decorationsChanged.dispose();
  }
}

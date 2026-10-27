import { localize } from "./i18n";
import * as path from "path";
import * as vscode from "vscode";
import { decorationFor, stat } from "./changesModel";
import type { OpenDiffArgs } from "./changesTree";
import { COMMIT_PAGE, parseRevParse, revParseArgs, shownFiles, sidePage, tipPaths, type Pair, type RepoCompare, type Side, type SideCommit } from "./compareModel";
import type { CompareMode, CompareSidePage, CompareTreeRow } from "./compareProtocol";
import type { CompareStore } from "./compareStore";
import { fileTree, type TreeNode } from "./fileTree";
import type { LogView } from "./logView";
import { isAbortError, runPool } from "./pool";
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

export const plural = (n: number, one: string, many = `${one}s`) => localize("{0} {1}", n, localize(n === 1 ? one : many));
export const short = (n: string) => n.replace(/^refs\/(heads|remotes)\//, "").replace(/^origin\//, "");
const labelOf = (item: vscode.TreeItem) => (typeof item.label === "string" ? item.label : item.label?.label ?? "");

/** Which repository the side views show. One emitter: both sides follow it. */
export class CompareSelection implements vscode.Disposable {
  repoId: string | undefined;
  /** Chosen for the user (the first listed repository), not by them: it may still move while the list is read. */
  auto = false;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private openedFile: { repoId: string; path: string; original: string; modified: string } | undefined;
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

  /** The editor's left/right sides always match the branch boxes, including renames. */
  async openFile(deps: Deps, repo: Repo, tips: { leftSha: string; rightSha: string }, pair: Pair, side: Side, file: { path: string; oldPath?: string }, preserveFocus = false): Promise<void> {
    const at = tipPaths(side, file);
    const modified = await deps.log.openDiff({ repoId: repo.id, sha: tips.rightSha, parent: tips.leftSha, path: at.right, ...(at.left !== at.right ? { oldPath: at.left } : {}) }, preserveFocus,
      `${path.posix.basename(file.path)} (${short(pair.left)} ↔ ${short(pair.right)}) — ${repo.name}`);
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (input instanceof vscode.TabInputTextDiff && input.modified.toString() === modified) {
      this.openedFile = { repoId: repo.id, path: file.path, original: input.original.toString(), modified };
    }
  }

  /** Follow a changed pair only while the file we opened is still the active editor. */
  async syncFile(deps: Deps): Promise<void> {
    const opened = this.openedFile;
    const active = () => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      return input instanceof vscode.TabInputTextDiff && input.original.toString() === opened?.original && input.modified.toString() === opened?.modified;
    };
    if (!opened || !active()) return;
    const pair = deps.store.pair;
    const hit = resultOf(deps.store, opened.repoId);
    if (!pair || !hit || hit.result.kind === "missing" || hit.result.kind === "error") return;
    const key = keyOf(deps.store, opened.repoId);
    const files = hit.result.kind === "differs" ? await deps.store.readFiles(opened.repoId).catch(() => undefined) : { left: [], right: [] };
    // Identical/unrelated branches have no Files rows, but an already-open file can
    // still follow their tips. Resolve them only for this active diff.
    const ids = hit.result.kind === "differs" ? { left: hit.result.leftSha, right: hit.result.rightSha }
      : await deps.log.countedRun(hit.repo.root, revParseArgs(pair), new AbortController().signal).then(parseRevParse).catch(() => undefined);
    if (!files || !ids || this.openedFile !== opened || deps.store.pair !== pair || keyOf(deps.store, opened.repoId) !== key || !active()) return;
    const matches = (f: FileChange) => f.path === opened.path || f.oldPath === opened.path;
    const left = files.left.find(matches);
    const right = files.right.find(matches);
    await this.openFile(deps, hit.repo, { leftSha: ids.left, rightSha: ids.right }, pair, left ? "left" : "right", left ?? right ?? { path: opened.path }, true);
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
  private readonly view: { visible: boolean; description: string; message: string | undefined } = { visible: false, description: "", message: undefined };
  private send: ((message: CompareSidePage) => void) | undefined;
  private isVisible: () => boolean = () => false;
  private readonly nodes = new Map<string, SNode>();
  private readonly commitFiles = new Map<string, SNode[]>();
  private readonly expanding = new Map<string, Promise<void>>();
  private serial = 0;
  private scope = "";
  private presentation: CompareSidePage | undefined;
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
    this.disposables.push(
      deps.selection.onDidChange(() => {
        this.limit = COMMIT_PAGE;
        this.detail = undefined;
        this.commitFiles.clear();
        // The detail is dropped: always redraw, even when what is asked is the same (Refresh).
        this.drawn = undefined;
        this.render();
      }),
      deps.store.onDidChange(() => this.render()),
    );
    this.render();
  }

  attach(send: (message: CompareSidePage) => void, visible: () => boolean): void {
    this.send = send;
    this.isVisible = visible;
    this.visibilityChanged();
  }

  visibilityChanged(): void { this.render(); }

  commandArgument(arg: unknown): unknown {
    const id = (arg as { compareNodeId?: unknown } | undefined)?.compareNodeId;
    return typeof id === "string" ? this.nodes.get(id) : arg;
  }

  async openNode(id: string): Promise<void> {
    if (!this.view.visible) return;
    const node = this.nodes.get(id);
    if (!node || (node.kind !== "file" && node.kind !== "more")) return;
    const command = this.getTreeItem(node).command;
    if (command) await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
  }

  expandNode(id: string): Promise<void> {
    if (!this.view.visible) return Promise.resolve();
    const ready = this.expanding.get(id);
    if (ready) return ready;
    const node = this.nodes.get(id);
    if (!node || node.kind !== "commit") return Promise.resolve();
    const scope = this.scope;
    const work = (async () => {
      await this.getChildren(node);
      if (scope === this.scope) await this.postTree();
    })().finally(() => this.expanding.delete(id));
    this.expanding.set(id, work);
    return work;
  }

  async expandAll(): Promise<void> {
    await runPool([...this.nodes.values()].filter((node) => node.kind === "commit"), 4, (node) => this.expandNode(node.id), new AbortController().signal);
  }

  private async postTree(): Promise<void> {
    if (!this.view.visible) return;
    const serial = ++this.serial;
    const ask = this.ask();
    const roots = this.view.visible ? await this.getChildren() : [];
    if (serial !== this.serial || ask !== this.ask()) return;
    this.nodes.clear();
    const row = (node: SNode): CompareTreeRow => {
      this.nodes.set(node.id, node);
      const item = this.getTreeItem(node);
      const common = { id: node.id, kind: node.kind, label: labelOf(item), description: String(item.description ?? ""), tooltip: typeof item.tooltip === "string" ? item.tooltip : "", contextValue: item.contextValue ?? "" };
      if (node.kind === "folder") return { ...common, loaded: true, children: node.children.map(row) };
      if (node.kind === "commit") return { ...common, loaded: this.commitFiles.has(node.id), children: (this.commitFiles.get(node.id) ?? []).map(row) };
      return node.kind === "file" ? { ...common, status: node.file.status, same: node.same } : common;
    };
    this.presentation = { type: "side", side: this.side, key: this.scope, description: this.view.description, message: this.view.message, rows: roots.map(row) };
    this.send?.(this.presentation);
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
    return { n: f.shown.length, text: `${plural(f.shown.length, "file")}${f.hidden > 0 ? localize(" · {0} already on both (hidden)", f.hidden) : ""}` };
  }

  /** The empty-side message: all hidden is not "no changes". */
  private emptyText(): string {
    const d = this.detail;
    return d && this.mode === "files" && this.filesOf(d).hidden > 0 ? localize("Every file this side changed is already on both branches (Show Files Already on Both in the title bar).") : localize("No changes on this side.");
  }

  /** Hide Files Already on Both was switched: the tree again, from the detail already read. */
  hideSameChanged(): void {
    this.render();
  }

  private render(): void {
    this.view.visible = this.isVisible();
    const pair = this.deps.store.pair;
    const repoId = this.deps.selection.repoId;
    // VS Code title-cases view titles: the branch name goes in the description, as typed.
    const only = pair ? localize("{0} only", short(pair[this.side])) : "";
    const hit = repoId ? resultOf(this.deps.store, repoId) : undefined;
    if (this.detail && (this.detail.repoId !== repoId || this.detail.key !== (repoId ? keyOf(this.deps.store, repoId) : "") || this.detail.mode !== this.mode)) this.detail = undefined;
    const count = this.countText();
    const n = count?.n;
    this.view.description = [only, hit ? `${hit.repo.name}${count ? ` · ${count.text}` : ""}` : ""].filter(Boolean).join(" · ");
    this.view.message = !pair || !repoId ? localize("Select a repository in Repositories.")
      : hit?.result.kind === "nobase" ? localize("{0}: the two branches share no history, so there is no split point.", hit.repo.name)
      : hit?.result.kind === "error" ? localize("{0}: git could not compare the branches: {1}", hit.repo.name, hit.result.reason)
      : n === 0 ? this.emptyText() : undefined;
    const ask = this.ask();
    const scope = [pair?.left, pair?.right, repoId, repoId ? keyOf(this.deps.store, repoId) : "", this.mode].join("\0");
    if (scope !== this.scope) { this.scope = scope; this.commitFiles.clear(); this.nodes.clear(); }
    // Hidden: left as drawn until shown. Emptied while hidden, VS Code keeps the rows it drew and
    // logs an error for each when a context key changes (the tab closing).
    if (!this.view.visible) {
      this.drawn = undefined;
      return;
    }
    if (ask === this.drawn) { void this.postTree(); return; }
    this.drawn = ask;
    this.emitter.fire(undefined);
    void this.postTree();
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
      this.view.description = `${pair ? `${localize("{0} only", short(pair[this.side]))} · ` : ""}${hit.repo.name} · ${count.text}`;
      const empty = this.emptyText();
      this.view.message = count.n === 0 ? empty : before === localize("No changes on this side.") || before === localize("Every file this side changed is already on both branches (Show Files Already on Both in the title bar).") ? undefined : before;
    }
    void this.postTree();
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
        const cached = this.commitFiles.get(node.id);
        if (cached) return cached;
        const scope = this.scope;
        const files = await this.deps.store.readCommitFiles(node.repoId, node.commit.sha);
        const rows = files.map((file): SNode => ({ kind: "file", id: `${node.id}/f:${file.path}`, repoId: node.repoId, side: this.side, path: file.path, name: file.path, file, both: false, commit: { sha: node.commit.sha, parent: node.commit.parents[0] ?? null } }));
        if (scope === this.scope) this.commitFiles.set(node.id, rows);
        return rows;
      }
      return [];
    } catch (e) {
      if (!isAbortError(e)) void vscode.window.showErrorMessage(localize("Linyra could not read {0} side: {1}", this.side === "left" ? localize("the left") : localize("the right"), e instanceof Error ? e.message : String(e)));
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
        item.description = node.same ? localize("{0} · already on both", stat(node.file)) : node.both ? localize("{0} · both", stat(node.file)) : stat(node.file);
        item.tooltip = node.same ? localize("{0}: changed on both sides since the split, and the two branches now have the same content — nothing to merge", node.file.path)
          : node.both ? localize("{0}: changed on both sides since the split — look at it before merging", node.file.path)
          : node.file.oldPath ? `${node.file.oldPath} → ${node.file.path}` : node.file.path;
        // A private scheme: the icon theme picks the icon from the name; nothing of today's working tree is painted on it.
        // The tip (Files) or commit (Commits) in the URI: another result is another URI, so its badge is asked for afresh.
        item.resourceUri = vscode.Uri.from({ scheme: SCHEME, path: `/${node.file.path}`, query: `${this.side}:${node.commit?.sha ?? this.detail?.tip ?? ""}:${node.repoId}` });
        item.iconPath = vscode.ThemeIcon.File;
        const dec = decorationFor(node.file.status);
        // Dimmed: the same at both tips, so it brings nothing to the merge.
        if (dec) this.decorations.set(item.resourceUri.toString(), new vscode.FileDecoration(dec.badge, dec.tooltip, new vscode.ThemeColor(node.same ? "disabledForeground" : dec.color)));
        item.command = node.commit
          ? { command: "polylog.openDiff", title: localize("Open Diff"), arguments: [{ repoId: node.repoId, sha: node.commit.sha, parent: node.commit.parent, path: node.file.path, oldPath: node.file.oldPath, status: node.file.status } satisfies OpenDiffArgs] }
          : { command: "polylog.compareOpenFile", title: localize("Open Diff"), arguments: [{ side: this.side, repoId: node.repoId, path: node.file.path }] };
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
        const item = new vscode.TreeItem(localize("Show {0} more", COMMIT_PAGE), C.None);
        item.id = node.id;
        item.command = { command: "polylog.compareMore", title: localize("Show more"), arguments: [this.side] };
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
   * A Files-mode file, as the two branches have it now, in the branch boxes' order.
   * The same order from either side view. Only a file
   * of the repository shown here opens.
   */
  async openFile(arg: unknown): Promise<void> {
    const t = this.fileTarget(arg);
    if (!t) return;
    const { f, hit, pair } = t;
    await this.deps.selection.openFile(this.deps, hit.repo, hit.result, pair, this.side, f);
  }

  /** Right-click → Changes since the split: merge base ↔ this side's tip (what the merge brings). */
  async openSinceSplit(arg: unknown): Promise<void> {
    const t = this.fileTarget(arg);
    if (!t) return;
    const { f, hit, pair } = t;
    const tip = this.side === "left" ? hit.result.leftSha : hit.result.rightSha;
    await this.deps.log.openDiff({ repoId: hit.repo.id, sha: tip, parent: hit.result.base, path: f.path, oldPath: f.oldPath, status: f.status }, false,
      localize("{0} (merge base ↔ {1}) — {2}", path.posix.basename(f.path), short(pair[this.side]), hit.repo.name));
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

  async snapshot(): Promise<{ open: boolean; title: string; description: string; message: string | undefined; tree: string[]; files: string[]; dimmed: string[]; presentation?: CompareSidePage }> {
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
    await this.postTree();
    return { open: this.view.visible, title: this.view.description?.split(" · ")[0] ?? "", description: this.view.description?.split(" · ").slice(1).join(" · ") ?? "", message: this.view.message, tree: lines, files, dimmed, presentation: this.presentation };
  }

  dispose(): void {
    this.serial++;
    this.send = undefined;
    this.nodes.clear();
    for (const d of this.disposables) d.dispose();
    this.emitter.dispose();
    this.decorationsChanged.dispose();
  }
}

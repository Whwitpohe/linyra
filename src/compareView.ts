import { localize } from "./i18n";
import * as path from "path";
import * as vscode from "vscode";
import { agoText } from "./blameModel";
import { decorationFor, stat } from "./changesModel";
import type { OpenDiffArgs } from "./changesTree";
import { ALL_REPOS, candidates, COMMIT_PAGE, isGroupSelection, selectionIds, isConflict, parseResolve, resolveInput, shownFiles, sidePage, tipPaths, type RepoCompare, type Side, type SideCommit } from "./compareModel";
import type { CompareMode, CompareSidePage, CompareTreeRow } from "./compareProtocol";
import type { CompareStore } from "./compareStore";
import { fileTree, type TreeNode } from "./fileTree";
import type { LogView } from "./logView";
import { isAbortError, runPool } from "./pool";
import { encodeRevision, SCHEME as REVISION_SCHEME } from "./revisionUri";
import type { FileChange, Repo } from "./types";

export const PAIR = "linyra.compare.pair";
export const RECENT = "linyra.compare.recent";
export const FAVORITES = "linyra.compare.favorites";
export const MODE = "linyra.compare.mode";
export const SHOWN = "linyra.compare.shown";
/** globalState: Hide Files Already on Both (on unless the user turned it off). Also a context key. */
export const HIDE_SAME = "linyra.compareHideSame";
/** globalState: Files mode lists only the files a merge would leave conflicted. */
export const ONLY_CONFLICTS = "linyra.compareOnlyConflicts";
const SCHEME = "linyra-compare";

export type { CompareMode };
export { ALL_REPOS };
type Differs = Extract<RepoCompare, { kind: "differs" }>;

export const plural = (n: number, one: string, many = `${one}s`) => localize("{0} {1}", n, localize(n === 1 ? one : many));
export const short = (n: string) => n.replace(/^refs\/(heads|remotes)\//, "").replace(/^origin\//, "");
/** A side as it reads: its names, shortened ("develop, develop-k"). */
export const shortSide = (side: string) => candidates(side).map(short).join(", ");
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
  async openFile(deps: Deps, repo: Repo, tips: { leftSha: string; rightSha: string; leftName: string; rightName: string }, side: Side, file: { path: string; oldPath?: string }, preserveFocus = false): Promise<void> {
    const at = tipPaths(side, file);
    const modified = await deps.log.openDiff({ repoId: repo.id, sha: tips.rightSha, parent: tips.leftSha, path: at.right, ...(at.left !== at.right ? { oldPath: at.left } : {}) }, preserveFocus,
      `${path.posix.basename(file.path)} (${short(tips.leftName)} ↔ ${short(tips.rightName)}) — ${repo.name}`);
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
    const tips = hit.result.kind === "differs" ? hit.result
      : await deps.log.countedRun(hit.repo.root, ["cat-file", "--batch-check"], new AbortController().signal, { input: resolveInput(pair) }).then((out) => {
        const r = parseResolve(pair, out);
        return r.left && r.right ? { leftSha: r.left.sha, rightSha: r.right.sha, leftName: r.left.name, rightName: r.right.name } : undefined;
      }).catch(() => undefined);
    if (!files || !tips || this.openedFile !== opened || deps.store.pair !== pair || keyOf(deps.store, opened.repoId) !== key || !active()) return;
    const matches = (f: FileChange) => f.path === opened.path || f.oldPath === opened.path;
    const left = files.left.find(matches);
    const right = files.right.find(matches);
    await this.openFile(deps, hit.repo, tips, left ? "left" : "right", left ?? right ?? { path: opened.path }, true);
  }
  dispose(): void {
    this.emitter.dispose();
  }
}

/** Preview Merge Result: the merged file, held while its editor is open (it exists nowhere else). */
export class MergePreviewDocs implements vscode.TextDocumentContentProvider, vscode.Disposable {
  static readonly scheme = "linyra-merge";
  private readonly texts = new Map<string, string>();
  private n = 0;
  private readonly closed = vscode.workspace.onDidCloseTextDocument((doc) => this.texts.delete(doc.uri.toString()));

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.texts.get(uri.toString()) ?? "";
  }

  put(file: string, text: string): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: MergePreviewDocs.scheme, path: `/${file}`, query: String(++this.n) });
    this.texts.set(uri.toString(), text);
    return uri;
  }

  dispose(): void {
    this.closed.dispose();
    this.texts.clear();
  }
}

export interface Deps {
  context: vscode.ExtensionContext;
  store: CompareStore;
  log: LogView;
  selection: CompareSelection;
  mergeDocs: MergePreviewDocs;
}

export const modeOf = (context: vscode.ExtensionContext): CompareMode => context.workspaceState.get<CompareMode>(MODE, "files");
export const hideSameOf = (context: vscode.ExtensionContext): boolean => context.globalState.get<boolean>(HIDE_SAME, true);
export const onlyConflictsOf = (context: vscode.ExtensionContext): boolean => context.globalState.get<boolean>(ONLY_CONFLICTS, false);
export const resultOf = (store: CompareStore, repoId: string): { repo: Repo; result: RepoCompare } | undefined => store.results().find((x) => x.repo.id === repoId);
/** The repositories All repositories shows: every one whose files differ, in Repo List order. */
export const differing = (store: CompareStore): { repo: Repo; result: Differs }[] =>
  store.results().flatMap((x) => (x.result.kind === "differs" ? [{ repo: x.repo, result: x.result }] : []));
/** The repositories a group selection shows: every differing one (All repositories), or the ones picked that differ. */
export const groupOf = (store: CompareStore, selection: string): { repo: Repo; result: Differs }[] => {
  const ids = selectionIds(selection);
  return differing(store).filter((x) => ids === "all" || ids.includes(x.repo.id));
};
/** The result a side's detail was read for: its two tips (a group: each of its repositories'). */
export const keyOf = (store: CompareStore, repoId: string): string => {
  if (isGroupSelection(repoId)) return groupOf(store, repoId).map((x) => `${x.repo.id}:${x.result.leftSha} ${x.result.rightSha}`).join(",");
  const c = resultOf(store, repoId)?.result;
  return c?.kind === "differs" ? `${c.leftSha} ${c.rightSha}` : c?.kind ?? "";
};

type SNode =
  | { kind: "folder"; id: string; name: string; path: string; count: number; children: SNode[] }
  /** All repositories: one repository's rows under its name. */
  | { kind: "repo"; id: string; repoId: string; name: string; count: number; children: SNode[] }
  /** side and path: a right-click hands the row itself to the command. */
  | { kind: "file"; id: string; repoId: string; side: Side; path: string; name: string; file: FileChange; both: boolean; same?: boolean; conflict?: boolean; commit?: { sha: string; parent: string | null } }
  | { kind: "commit"; id: string; repoId: string; commit: SideCommit }
  | { kind: "more"; id: string };

/** One repository's part of a side: its files since the split (Files) or its commits (Commits). */
interface RepoDetail {
  repoId: string;
  tip: string;
  files?: FileChange[];
  both?: Set<string>;
  same?: Set<string>;
  commits?: SideCommit[];
  more?: boolean;
}

/** One side of the selected repository (or of every one): its files since the split (Files) or its commits (Commits). */
export class CompareSide implements vscode.TreeDataProvider<SNode>, vscode.FileDecorationProvider, vscode.Disposable {
  private readonly view: { visible: boolean; description: string; message: string | undefined } = { visible: false, description: "", message: undefined };
  private send: ((message: CompareSidePage) => void) | undefined;
  private isVisible: () => boolean = () => false;
  private readonly nodes = new Map<string, SNode>();
  private readonly commitFiles = new Map<string, SNode[]>();
  private readonly expanding = new Map<string, Promise<void>>();
  /** The rows selected together in the page (Ctrl/Shift-click): Cherry-Pick takes them all. */
  private selected = new Set<string>();
  private serial = 0;
  private scope = "";
  private presentation: CompareSidePage | undefined;
  private readonly emitter = new vscode.EventEmitter<SNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly decorationsChanged = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.decorationsChanged.event;
  private readonly decorations = new Map<string, vscode.FileDecoration>();
  /** The selection's detail, for the results it was read for (dropped when one of them moves). */
  private detail: { selection: string; key: string; mode: CompareMode; limit: number; repos: RepoDetail[] } | undefined;
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
        this.selected.clear();
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

  /** The page's selection: only rows it shows. */
  select(ids: readonly unknown[]): void {
    this.selected = new Set(ids.filter((id): id is string => typeof id === "string" && this.nodes.has(id)));
  }

  /**
   * Cherry-Pick: the commit right-clicked, or (right-clicked inside a selection of several) every
   * selected commit of its repository, newest first as listed.
   */
  cherryPickTargets(arg: unknown): { repo: Repo; commits: SideCommit[] } | undefined {
    const node = this.commandArgument(arg) as SNode | undefined;
    if (node?.kind !== "commit") return undefined;
    const repo = resultOf(this.deps.store, node.repoId)?.repo;
    if (!repo) return undefined;
    const many = this.selected.has(node.id) && this.selected.size > 1
      ? [...this.nodes.values()].filter((n): n is Extract<SNode, { kind: "commit" }> => n.kind === "commit" && n.repoId === node.repoId && this.selected.has(n.id))
      : [node];
    return { repo, commits: many.map((n) => n.commit) };
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
      if (node.kind === "folder" || node.kind === "repo") return { ...common, loaded: true, children: node.children.map(row) };
      if (node.kind === "commit") return { ...common, loaded: this.commitFiles.has(node.id), children: (this.commitFiles.get(node.id) ?? []).map(row) };
      return node.kind === "file" ? { ...common, status: node.file.status, same: node.same, conflict: node.conflict } : common;
    };
    this.presentation = { type: "side", side: this.side, key: this.scope, description: this.view.description, message: this.view.message, rows: roots.map(row) };
    this.send?.(this.presentation);
  }

  private get mode(): CompareMode {
    return modeOf(this.deps.context);
  }

  /** A repository's conflicted files as its merge check found them (it lands after the files: read live). */
  private conflictsOf(repoId: string): string[] | null | undefined {
    const c = resultOf(this.deps.store, repoId)?.result;
    return c?.kind === "differs" ? c.conflicts : undefined;
  }

  /** Files mode: a repository's files listed (Hide Files Already on Both and Only Conflicts applied) and how many were left out as already on both. */
  private filesOf(r: RepoDetail): { shown: FileChange[]; hidden: number } {
    const f = shownFiles(r.files ?? [], r.same ?? new Set(), hideSameOf(this.deps.context));
    const conflicts = this.conflictsOf(r.repoId);
    if (!onlyConflictsOf(this.deps.context) || !conflicts) return f;
    return { shown: f.shown.filter((x) => isConflict(conflicts, x)), hidden: f.hidden };
  }

  /** "3 files", and in Files mode the ones hidden as already on both. */
  private countText(): { n: number; text: string } | undefined {
    const d = this.detail;
    if (!d) return undefined;
    if (this.mode !== "files") {
      const n = d.repos.reduce((sum, r) => sum + (r.commits?.length ?? 0), 0);
      return { n, text: plural(n, "commit") };
    }
    const f = d.repos.map((r) => this.filesOf(r));
    const n = f.reduce((sum, x) => sum + x.shown.length, 0), hidden = f.reduce((sum, x) => sum + x.hidden, 0);
    return { n, text: `${plural(n, "file")}${hidden > 0 ? localize(" · {0} already on both (hidden)", hidden) : ""}` };
  }

  /** The empty-side message: all hidden (or no conflict) is not "no changes". */
  private emptyText(): string {
    const d = this.detail;
    if (d && this.mode === "files" && onlyConflictsOf(this.deps.context) && d.repos.some((r) => (r.files?.length ?? 0) > 0)) return localize("No file on this side would conflict (Only Conflicts in the toolbar).");
    return d && this.mode === "files" && d.repos.some((r) => this.filesOf(r).hidden > 0) ? localize("Every file this side changed is already on both branches (Show Files Already on Both in the title bar).") : localize("No changes on this side.");
  }

  /** Hide Files Already on Both or Only Conflicts was switched: the tree again, from the detail already read. */
  hideSameChanged(): void {
    this.render();
  }

  /** The repositories this side shows: the one selected, or (All repositories) every one whose files differ. */
  private shown(): { repo: Repo; result: Differs }[] {
    const id = this.deps.selection.repoId;
    if (!id) return [];
    return isGroupSelection(id) ? groupOf(this.deps.store, id) : differing(this.deps.store).filter((x) => x.repo.id === id);
  }

  /** "develop only": the name this repository uses, or (All repositories, nothing read yet) the side's names. */
  private onlyText(): string {
    const pair = this.deps.store.pair;
    if (!pair) return "";
    const id = this.deps.selection.repoId;
    const hit = id && !isGroupSelection(id) ? resultOf(this.deps.store, id)?.result : undefined;
    const name = hit?.kind === "differs" ? (this.side === "left" ? hit.leftName : hit.rightName) : undefined;
    return localize("{0} only", name ? short(name) : shortSide(pair[this.side]));
  }

  private render(): void {
    this.view.visible = this.isVisible();
    const pair = this.deps.store.pair;
    const repoId = this.deps.selection.repoId;
    const all = isGroupSelection(repoId);
    // VS Code title-cases view titles: the branch name goes in the description, as typed.
    const hit = repoId && !all ? resultOf(this.deps.store, repoId) : undefined;
    if (this.detail && (this.detail.selection !== repoId || this.detail.key !== (repoId ? keyOf(this.deps.store, repoId) : "") || this.detail.mode !== this.mode)) this.detail = undefined;
    const count = this.countText();
    const n = count?.n;
    const where = all ? plural(this.shown().length, "repository", "repositories") : hit?.repo.name;
    this.view.description = [this.onlyText(), where ? `${where}${count ? ` · ${count.text}` : ""}` : ""].filter(Boolean).join(" · ");
    this.view.message = !pair || !repoId ? localize("Select a repository in Repositories.")
      : hit?.result.kind === "nobase" ? localize("{0}: the two branches share no history, so there is no split point.", hit.repo.name)
      : hit?.result.kind === "error" ? localize("{0}: git could not compare the branches: {1}", hit.repo.name, hit.result.reason)
      : n === 0 ? this.emptyText() : undefined;
    const ask = this.ask();
    const scope = [pair?.left, pair?.right, repoId, repoId ? keyOf(this.deps.store, repoId) : "", this.mode].join("\0");
    if (scope !== this.scope) { this.scope = scope; this.commitFiles.clear(); this.nodes.clear(); this.selected.clear(); }
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

  /** What this side shows: the pair, the repository, its result, the mode, the page and the filters. */
  private ask(): string {
    const p = this.deps.store.pair;
    const repoId = this.deps.selection.repoId ?? "";
    // The merge checks land after the files: their answers redraw the rows, without reading them again.
    const checks = this.shown().map((x) => x.result.conflicts?.join("|") ?? String(x.result.conflicts)).join(",");
    return [p?.left, p?.right, repoId, repoId ? keyOf(this.deps.store, repoId) : "", this.mode, this.limit, this.waiting(), hideSameOf(this.deps.context), onlyConflictsOf(this.deps.context), checks].join("\0");
  }

  /** The selection was made for the user while the list is still read: it may move, so wait for the list. */
  private waiting(): boolean {
    return this.deps.store.reading && (this.deps.selection.auto || isGroupSelection(this.deps.selection.repoId));
  }

  /** The selection's detail, read once per result and mode. All repositories reads a few repositories at a time. */
  private read(): Promise<NonNullable<CompareSide["detail"]> | undefined> {
    const selection = this.deps.selection.repoId;
    const shown = this.shown();
    if (!selection || shown.length === 0 || this.waiting()) return Promise.resolve(undefined);
    const key = keyOf(this.deps.store, selection);
    const mode = this.mode;
    const limit = this.limit;
    if (this.detail?.selection === selection && this.detail.key === key && this.detail.mode === mode && this.detail.limit === limit) return Promise.resolve(this.detail);
    const ask = this.ask();
    if (this.reading?.ask === ask) return this.reading.read;
    const read = (async () => {
      const settled = await runPool(shown, 8, async ({ repo, result }): Promise<RepoDetail> => {
        const tip = this.side === "left" ? result.leftSha : result.rightSha;
        if (mode === "files") {
          const f = await this.deps.store.readFiles(repo.id);
          return { repoId: repo.id, tip, files: f[this.side], both: new Set(f.both), same: new Set(f.same) };
        }
        const page = sidePage(await this.deps.store.readCommits(repo.id, this.side, limit + 1), limit);
        return { repoId: repo.id, tip, commits: page.rows, more: page.more };
      }, new AbortController().signal);
      const failed = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
      // One repository on its own: its failure is the side's. All repositories: the others still show.
      if (failed && (shown.length === 1 || isAbortError(failed.reason))) throw failed.reason;
      const repos = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
      // Asked for something else meanwhile (another repository, pair, mode or result): dropped.
      if (this.ask() !== ask) return undefined;
      const d = { selection, key, mode, limit, repos };
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
    const count = this.countText();
    const repoId = this.deps.selection.repoId;
    const where = isGroupSelection(repoId) ? plural(this.detail?.repos.length ?? 0, "repository", "repositories") : repoId ? resultOf(this.deps.store, repoId)?.repo.name : undefined;
    if (where && count) {
      this.view.description = [this.onlyText(), `${where} · ${count.text}`].filter(Boolean).join(" · ");
      const empties = [localize("No changes on this side."), localize("Every file this side changed is already on both branches (Show Files Already on Both in the title bar)."),
        localize("No file on this side would conflict (Only Conflicts in the toolbar).")];
      this.view.message = count.n === 0 ? this.emptyText() : before !== undefined && empties.includes(before) ? undefined : before;
    }
    void this.postTree();
  }

  async getChildren(node?: SNode): Promise<SNode[]> {
    try {
      if (!node) {
        if (!this.view.visible) return [];
        const d = await this.read();
        if (!d) return [];
        const rowsOf = (r: RepoDetail): SNode[] => {
          if (d.mode === "files") return this.tree(fileTree(this.filesOf(r).shown), `${r.repoId}/${this.side}`, r.repoId, r.both ?? new Set(), "", r.same ?? new Set(), this.conflictsOf(r.repoId) ?? null);
          const rows = (r.commits ?? []).map((commit): SNode => ({ kind: "commit", id: `${r.repoId}/${this.side}/c:${commit.sha}`, repoId: r.repoId, commit }));
          return r.more ? [...rows, { kind: "more", id: `${r.repoId}/${this.side}/more` }] : rows;
        };
        if (!isGroupSelection(d.selection)) return d.repos[0] ? rowsOf(d.repos[0]) : [];
        // All repositories, or several picked: each one's rows under its name; a repository with none on this side is left out.
        return d.repos.flatMap((r) => {
          const children = rowsOf(r);
          const name = resultOf(this.deps.store, r.repoId)?.repo.name ?? r.repoId;
          const count = d.mode === "files" ? this.filesOf(r).shown.length : r.commits?.length ?? 0;
          return children.length === 0 ? [] : [{ kind: "repo", id: `${r.repoId}/${this.side}/repo`, repoId: r.repoId, name, count, children } satisfies SNode];
        });
      }
      if (node.kind === "folder" || node.kind === "repo") return node.children;
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

  private tree(nodes: readonly TreeNode[], base: string, repoId: string, both: ReadonlySet<string>, parent: string, same: ReadonlySet<string>, conflicts: readonly string[] | null): SNode[] {
    return nodes.map((n): SNode => {
      if (n.kind === "folder") {
        const p = parent ? `${parent}/${n.name}` : n.name;
        return { kind: "folder", id: `${base}/d:${p}`, name: n.name, path: p, count: n.count, children: this.tree(n.children, base, repoId, both, p, same, conflicts) };
      }
      return { kind: "file", id: `${base}/f:${n.file.path}`, repoId, side: this.side, path: n.file.path, name: n.name, file: n.file, both: both.has(n.file.path), same: same.has(n.file.path), conflict: isConflict(conflicts, n.file) };
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
      case "repo": {
        const item = new vscode.TreeItem(node.name, C.Expanded);
        item.id = node.id;
        item.description = String(node.count);
        item.iconPath = new vscode.ThemeIcon("repo");
        item.contextValue = "compareRepoGroup";
        return item;
      }
      case "file": {
        const item = new vscode.TreeItem(node.name, C.None);
        item.id = node.id;
        item.description = node.conflict ? localize("{0} · conflict", stat(node.file)) : node.same ? localize("{0} · already on both", stat(node.file)) : node.both ? localize("{0} · both", stat(node.file)) : stat(node.file);
        item.tooltip = node.conflict ? localize("{0}: merging the two branches would conflict here — Preview Merge Result shows how", node.file.path)
          : node.same ? localize("{0}: changed on both sides since the split, and the two branches now have the same content — nothing to merge", node.file.path)
          : node.both ? localize("{0}: changed on both sides since the split — look at it before merging", node.file.path)
          : node.file.oldPath ? `${node.file.oldPath} → ${node.file.path}` : node.file.path;
        // A private scheme: the icon theme picks the icon from the name; nothing of today's working tree is painted on it.
        // The tip (Files) or commit (Commits) in the URI: another result is another URI, so its badge is asked for afresh.
        const tip = node.commit?.sha ?? this.detail?.repos.find((r) => r.repoId === node.repoId)?.tip ?? "";
        item.resourceUri = vscode.Uri.from({ scheme: SCHEME, path: `/${node.file.path}`, query: `${this.side}:${tip}:${node.repoId}` });
        item.iconPath = vscode.ThemeIcon.File;
        const dec = decorationFor(node.file.status);
        // Dimmed: the same at both tips, so it brings nothing to the merge. A conflict: the theme's conflict color.
        if (dec) this.decorations.set(item.resourceUri.toString(), new vscode.FileDecoration(dec.badge, dec.tooltip,
          new vscode.ThemeColor(node.conflict ? "gitDecoration.conflictingResourceForeground" : node.same ? "disabledForeground" : dec.color)));
        item.command = node.commit
          ? { command: "linyra.openDiff", title: localize("Open Diff"), arguments: [{ repoId: node.repoId, sha: node.commit.sha, parent: node.commit.parent, path: node.file.path, oldPath: node.file.oldPath, status: node.file.status } satisfies OpenDiffArgs] }
          : { command: "linyra.compareOpenFile", title: localize("Open Diff"), arguments: [{ side: this.side, repoId: node.repoId, path: node.file.path }] };
        // Files mode adds Changes since the split (and, on a conflict, Preview Merge Result); a deleted file has nothing to open in the workspace.
        item.contextValue = `${node.commit ? "compareCommitFile" : "compareFile"}${node.file.status === "D" ? ".deleted" : ""}${node.conflict ? ".conflict" : ""}`;
        return item;
      }
      case "commit": {
        const item = new vscode.TreeItem(node.commit.subject, C.Collapsed);
        item.id = node.id;
        item.description = `${node.commit.author} · ${agoText(node.commit.time, Math.floor(Date.now() / 1000))} · ${node.commit.sha.slice(0, 7)}`;
        item.tooltip = `${node.commit.subject}\n${node.commit.author} · ${new Date(node.commit.time * 1000).toLocaleString()}`;
        item.iconPath = new vscode.ThemeIcon("git-commit");
        item.contextValue = "compareCommit";
        return item;
      }
      case "more": {
        const item = new vscode.TreeItem(localize("Show {0} more", COMMIT_PAGE), C.None);
        item.id = node.id;
        item.command = { command: "linyra.compareMore", title: localize("Show more"), arguments: [this.side] };
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
   * of a repository shown here opens.
   */
  async openFile(arg: unknown): Promise<void> {
    const t = this.fileTarget(arg);
    if (!t) return;
    await this.deps.selection.openFile(this.deps, t.repo, t.result, this.side, t.f);
  }

  /** Right-click → Changes since the split: merge base ↔ this side's tip (what the merge brings). */
  async openSinceSplit(arg: unknown): Promise<void> {
    const t = this.fileTarget(arg);
    if (!t) return;
    const { f, repo, result } = t;
    const base = await this.deps.store.base(repo.id);
    if (!base) return;
    const tip = this.side === "left" ? result.leftSha : result.rightSha;
    await this.deps.log.openDiff({ repoId: repo.id, sha: tip, parent: base, path: f.path, oldPath: f.oldPath, status: f.status }, false,
      localize("{0} (merge base ↔ {1}) — {2}", path.posix.basename(f.path), short(this.side === "left" ? result.leftName : result.rightName), repo.name));
  }

  /**
   * Right-click a conflict → Preview Merge Result: ▶ as it is now ↔ the file as merging ◀ into it
   * would leave it, conflict markers included. Done in memory: nothing is written to the repository.
   */
  async previewMerge(arg: unknown): Promise<void> {
    const t = this.fileTarget(arg);
    if (!t) return;
    const { f, repo, result } = t;
    const at = tipPaths(this.side, f);
    const text = await this.deps.store.mergePreview(repo.id, at.right).catch((e: unknown) => { if (!isAbortError(e)) throw e; return undefined; });
    if (text === undefined) {
      void vscode.window.showInformationMessage(localize("Linyra could not work out the merge of {0} (git 2.38 or later is needed).", f.path));
      return;
    }
    const now = vscode.Uri.from({ scheme: REVISION_SCHEME, ...encodeRevision({ root: repo.root, ref: result.rightSha, path: at.right }) });
    await vscode.commands.executeCommand("vscode.diff", now, this.deps.mergeDocs.put(at.right, text),
      localize("{0} ({1} ↔ merged with {2}) — {3}", path.posix.basename(f.path), short(result.rightName), short(result.leftName), repo.name), { preview: true });
  }

  /** Only a file of a repository whose files are shown here. */
  private fileTarget(arg: unknown) {
    const a = arg as { repoId?: unknown; path?: unknown } | undefined;
    const d = this.detail;
    if (!d || d.mode !== "files" || typeof a?.repoId !== "string" || typeof a.path !== "string") return undefined;
    const r = d.repos.find((x) => x.repoId === a.repoId);
    const f = r?.files?.find((x) => x.path === a.path);
    const hit = resultOf(this.deps.store, a.repoId);
    if (!r || !f || !hit || hit.result.kind !== "differs" || !this.deps.store.pair) return undefined;
    return { f, repo: hit.repo, result: hit.result };
  }

  async snapshot(): Promise<{ open: boolean; title: string; description: string; message: string | undefined; tree: string[]; files: string[]; dimmed: string[]; conflicts: string[]; presentation?: CompareSidePage }> {
    const lines: string[] = [];
    /** "<path> <resourceUri> <badge>" for every file row (test seam). */
    const files: string[] = [];
    /** File rows drawn dimmed (the same at both tips). */
    const dimmed: string[] = [];
    /** File rows a merge would leave conflicted. */
    const conflicts: string[] = [];
    const walk = async (nodes: SNode[], depth: number): Promise<void> => {
      for (const n of nodes) {
        const kids = n.kind === "folder" || n.kind === "commit" || n.kind === "repo" ? await this.getChildren(n) : [];
        const item = this.getTreeItem(n);
        lines.push(`${"  ".repeat(depth)}${labelOf(item)} | ${item.description ?? ""}`);
        if (n.kind === "file" && item.resourceUri) {
          const dec = this.provideFileDecoration(item.resourceUri);
          files.push(`${n.file.path} ${item.resourceUri.toString()} ${dec?.badge ?? ""}`);
          if (dec?.color && (dec.color as { id?: string }).id === "disabledForeground") dimmed.push(n.file.path);
          if (n.conflict) conflicts.push(n.file.path);
        }
        await walk(kids, depth + 1);
      }
    };
    await walk(await this.getChildren(), 0);
    this.renderHeader();
    await this.postTree();
    return { open: this.view.visible, title: this.view.description?.split(" · ")[0] ?? "", description: this.view.description?.split(" · ").slice(1).join(" · ") ?? "", message: this.view.message, tree: lines, files, dimmed, conflicts, presentation: this.presentation };
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


import { randomBytes } from "crypto";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { decorationFor } from "./changesModel";
import { checkedLabel, commitFiles, commitPlan, describeCommit, filesUnder, pruneChoices, rowsById, setChecked, type CommitPlan, type CommitRow } from "./commitModel";
import type { CommitHostMessage, CommitWebviewMessage } from "./commitProtocol";
import type { RunOptions } from "./git";
import { localize } from "./i18n";
import { runPool } from "./pool";
import { gitMessage, openHeadDiff, type Ask, type UncommittedActions } from "./uncommittedActions";
import { totals, viewLabel } from "./uncommittedModel";
import type { UncommittedStore } from "./uncommittedStore";
import { renderCommitHtml } from "./webview/commit/html";
import { ACCENT_COLORS } from "./webview/view";

const DRAFT_KEY = "linyra.commitDraft";
/** The tree's rows as resources: the file icon theme picks their icons, Linyra's provider their letters. */
const TREE_SCHEME = "linyra-commit";
/** A commit writes the index and runs hooks: never an editor, and the index lock is taken. */
const WRITE_ENV = { GIT_OPTIONAL_LOCKS: "1", GIT_EDITOR: "true" };
/** Commits in several repositories at once, but few: each writes and may run hooks. */
const WRITE_CONCURRENCY = 4;
const NEVER = new AbortController().signal;

export interface CommitPanelDeps {
  context: vscode.ExtensionContext;
  store: UncommittedStore;
  actions: UncommittedActions;
  run(cwd: string, args: string[], signal?: AbortSignal, opts?: RunOptions): Promise<string>;
  /** Each repository's color in the Log. */
  accents(): ReadonlyMap<string, number>;
  /** The repository has commits to pull (its row offers Pull). */
  behind(repoId: string): boolean;
  /** The view came on screen: its work is read if nothing has read it (the Log may never have opened). */
  shown(): void;
  /** A commit landed: the Log reads its first page again. */
  committed(): void;
  /** Commit and Push…: Push… for the repositories just committed in. */
  push(repoIds: ReadonlySet<string>): Promise<unknown>;
  ask: Ask;
}

/**
 * The Commit side bar, as the JetBrains IDEs' Commit tool window: the uncommitted work of every
 * ticked repository in a native tree with a checkbox on each row (so files carry the icon theme's
 * icons), and below it the message, Amend, and Commit (or Commit and Push…) of the checked files
 * only, in every repository that has some. Unchecked files stay as they are, staged or not: each
 * repository's commit is `git commit --only` with the checked paths.
 */
export class CommitPanel implements vscode.TreeDataProvider<CommitRow>, vscode.FileDecorationProvider, vscode.WebviewViewProvider, vscode.Disposable {
  static readonly treeId = "linyra.commit";
  static readonly messageId = "linyra.commitMessage";
  private readonly tree: vscode.TreeView<CommitRow>;
  private readonly treeChanged = new vscode.EventEmitter<CommitRow | undefined>();
  readonly onDidChangeTreeData = this.treeChanged.event;
  private readonly decorationsChanged = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this.decorationsChanged.event;
  /** Each file row's letter by its URI; `key` tells a changed one (only those are announced). */
  private decorations = new Map<string, { uri: vscode.Uri; decoration: vscode.FileDecoration; key: string }>();
  private message: vscode.WebviewView | undefined;
  private messageDisposables: vscode.Disposable[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  private choices = new Map<string, boolean>();
  private rows = new Map<string, CommitRow>();
  private parents = new Map<string, CommitRow>();
  private roots: CommitRow[] = [];
  private busy = false;
  private checked = { files: 0, repos: 0 };
  /** The last error shown (integration test seam). */
  private lastError: string | undefined;

  constructor(private readonly deps: CommitPanelDeps) {
    this.tree = vscode.window.createTreeView(CommitPanel.treeId, { treeDataProvider: this, canSelectMany: true, showCollapseAll: true, manageCheckboxStateManually: true });
    this.tree.title = localize("Commit");
    this.disposables.push(this.tree, this.treeChanged, this.decorationsChanged, deps.store.onDidChange(() => this.render()),
      this.tree.onDidChangeVisibility(() => { if (this.tree.visible) deps.shown(); }),
      this.tree.onDidChangeCheckboxState((e) => this.check(e.items.map(([row]) => row), e.items[0]?.[1] === vscode.TreeItemCheckboxState.Checked)));
    this.render();
    if (this.tree.visible) deps.shown();
  }

  get visible(): boolean {
    return this.tree.visible || this.message?.visible === true;
  }

  /** The message box below the tree. */
  resolveWebviewView(view: vscode.WebviewView): void {
    this.message = view;
    const out = vscode.Uri.joinPath(this.deps.context.extensionUri, "out");
    view.webview.options = { enableScripts: true, localResourceRoots: [out] };
    view.webview.html = renderCommitHtml({
      cspSource: view.webview.cspSource,
      nonce: randomBytes(16).toString("hex"),
      scriptUri: view.webview.asWebviewUri(vscode.Uri.joinPath(out, "commit.js")).toString(),
      styleUri: view.webview.asWebviewUri(vscode.Uri.joinPath(out, "commit.css")).toString(),
    });
    for (const d of this.messageDisposables) d.dispose();
    this.messageDisposables = [
      view.webview.onDidReceiveMessage((m: CommitWebviewMessage) => void this.onMessage(m)),
      view.onDidChangeVisibility(() => { if (view.visible) this.deps.shown(); }),
      view.onDidDispose(() => { if (this.message === view) this.message = undefined; }),
    ];
    if (view.visible) this.deps.shown();
  }

  /** Re-draw: VS Code's Git opened or closed a repository, ↓/↑ moved, the Log's colors changed. */
  refresh(): void {
    this.render();
  }

  private render(): void {
    const works = this.deps.store.works();
    this.choices = pruneChoices(works, this.choices);
    const d = describeCommit(works, this.choices, this.deps.accents(), (id) => this.deps.behind(id));
    this.roots = d.roots;
    this.rows = rowsById(d.roots);
    this.parents = new Map();
    const walk = (rows: readonly CommitRow[], parent?: CommitRow) => rows.forEach((r) => { if (parent) this.parents.set(r.id, parent); walk(r.children ?? [], r); });
    walk(d.roots);
    this.checked = d.checked;
    this.tree.message = !this.deps.store.started ? localize("Reading uncommitted changes…") : d.message;
    this.tree.description = viewLabel(totals(works));
    // Each file's letter and color, as Source Control shows them. Only rows whose letter came, went
    // or changed are announced: VS Code caps a provider that reports every row on each change.
    const before = this.decorations;
    this.decorations = new Map();
    for (const row of this.rows.values()) {
      if (row.kind !== "file") continue;
      const dec = row.untracked
        ? { badge: "U", tooltip: localize("Untracked"), color: "gitDecoration.untrackedResourceForeground" }
        : decorationFor(row.status);
      if (!dec) continue;
      const uri = this.uriFor(row);
      this.decorations.set(uri.toString(), { uri, decoration: new vscode.FileDecoration(dec.badge, dec.tooltip, new vscode.ThemeColor(dec.color)), key: `${dec.badge}|${dec.color}` });
    }
    this.treeChanged.fire(undefined);
    const changed = [...before].filter(([id, d]) => this.decorations.get(id)?.key !== d.key).map(([, d]) => d.uri);
    for (const [id, d] of this.decorations) if (!before.has(id)) changed.push(d.uri);
    if (changed.length > 0) this.decorationsChanged.fire(changed);
    this.postState();
  }

  private postState(): void {
    this.post({ type: "state", checkedLabel: checkedLabel(this.checked), checkedFiles: this.checked.files, busy: this.busy });
  }

  private post(m: CommitHostMessage): void {
    void this.message?.webview.postMessage(m);
  }

  private uriFor(row: CommitRow): vscode.Uri {
    return vscode.Uri.from({ scheme: TREE_SCHEME, path: `/${row.path ?? ""}`, query: row.id });
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    return uri.scheme === TREE_SCHEME ? this.decorations.get(uri.toString())?.decoration : undefined;
  }

  getChildren(row?: CommitRow): CommitRow[] {
    return row ? row.children ?? [] : this.roots;
  }

  getParent(row: CommitRow): CommitRow | undefined {
    return this.parents.get(row.id);
  }

  getTreeItem(row: CommitRow): vscode.TreeItem {
    // New files wait under a collapsed Unversioned Files, as in the JetBrains IDEs.
    const state = row.kind === "file" ? vscode.TreeItemCollapsibleState.None
      : row.id === "unversioned" ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded;
    const item = new vscode.TreeItem(row.label, state);
    item.id = row.id;
    item.description = row.description;
    item.tooltip = row.tooltip;
    item.contextValue = row.contextValue;
    item.checkboxState = {
      state: row.check === "on" ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked,
      tooltip: row.check === "mixed" ? localize("Some files checked") : undefined,
    };
    if (row.kind === "repo") {
      item.iconPath = new vscode.ThemeIcon("repo", new vscode.ThemeColor(ACCENT_COLORS[(row.accent ?? 0) % ACCENT_COLORS.length]));
    } else if (row.kind === "folder") {
      item.resourceUri = this.uriFor(row);
      item.iconPath = vscode.ThemeIcon.Folder;
    } else if (row.kind === "file") {
      item.resourceUri = this.uriFor(row);
      item.iconPath = vscode.ThemeIcon.File;
      item.command = { command: "linyra.commitPanel.diff", title: localize("Show Diff"), arguments: [row] };
    }
    return item;
  }

  /** A checkbox clicked: its files, or (several rows selected) all of theirs. */
  check(rows: readonly { id: string }[], on: boolean): void {
    this.choices = setChecked(this.deps.store.works(), this.choices, rows.flatMap((r) => this.rows.get(r.id) ?? []), on);
    this.render();
  }

  async onMessage(m: CommitWebviewMessage): Promise<void> {
    if (!m || typeof m !== "object") return; // webview input is untrusted
    switch (m.type) {
      case "ready": {
        const draft = this.deps.context.workspaceState.get<{ text?: unknown; amend?: unknown }>(DRAFT_KEY);
        this.post({ type: "draft", text: typeof draft?.text === "string" ? draft.text : "", amend: draft?.amend === true });
        this.postState();
        return;
      }
      case "draft":
        await this.deps.context.workspaceState.update(DRAFT_KEY, { text: String(m.text ?? ""), amend: m.amend === true });
        return;
      case "amend":
        if (m.on === true && String(m.text ?? "").trim() === "") await this.lastMessage();
        return;
      case "commit": await this.commit(String(m.message ?? ""), m.amend === true, m.push === true); return;
    }
  }

  /** A row a command names: the tree's own row, or { id } (a test, a keybinding with none). */
  private rowOf(arg: unknown): CommitRow | undefined {
    const id = (arg as { id?: unknown } | undefined)?.id;
    return typeof id === "string" ? this.rows.get(id) : undefined;
  }

  /** The rows a command takes: the selection when the row is in it (VS Code passes both), else the row; with neither, the selection. */
  private targets(arg: unknown, many?: unknown): CommitRow[] {
    const row = this.rowOf(arg);
    const selected = (Array.isArray(many) ? many : this.tree.selection).flatMap((r) => this.rowOf(r) ?? []);
    if (!row) return selected;
    return selected.some((r) => r.id === row.id) ? selected : [row];
  }

  /** Show Diff: the last commit ↔ the working tree. */
  async diff(arg: unknown): Promise<void> {
    const row = this.targets(arg).find((r) => r.kind === "file");
    if (!row) return;
    const work = this.deps.store.get(row.repoId!);
    const file = work && commitFiles(work).find((f) => f.path === row.path);
    if (work && file) await openHeadDiff(work, file, true);
  }

  /** Rollback…: the rows (or the selection), else every checked file. One prompt, as Discard asks. */
  async rollback(arg?: unknown, many?: unknown): Promise<void> {
    let rows = this.targets(arg, many);
    if (rows.length === 0) rows = [...this.rows.values()].filter((r) => r.kind === "file" && r.check === "on");
    const files = filesUnder(rows);
    if (files.length === 0) return;
    await this.deps.actions.discard(files[0], files);
  }

  /**
   * Add to VCS: the new files under the rows (or the selection) are added (git add), as the JetBrains
   * IDEs' Add to VCS does. They move to Changes, checked. (Checked and committed, they are added too.)
   */
  async addToVcs(arg?: unknown, many?: unknown): Promise<void> {
    const files = filesUnder(this.targets(arg, many)).filter((f) => this.rows.has(`unversioned:${f.repoId}:f:${f.path}`));
    const byRepo = new Map<string, string[]>();
    for (const f of files) byRepo.set(f.repoId, [...(byRepo.get(f.repoId) ?? []), f.path]);
    const failed: string[] = [];
    await Promise.all([...byRepo].map(async ([repoId, paths]) => {
      const work = this.deps.store.get(repoId);
      if (!work) return;
      try {
        await this.withPaths(work.root, paths, ["add"]);
      } catch (e) {
        failed.push(localize("{0}: {1}", work.name, gitMessage(e)));
      }
      await this.deps.store.readRepo(repoId);
    }));
    if (failed.length > 0) {
      this.lastError = failed.join("; ");
      void vscode.window.showErrorMessage(localize("Linyra could not add the files. {0}.", this.lastError.replace(/[.\s]+$/, "")));
    }
  }

  /** Amend ticked with an empty box, and its commit goes to one repository: that commit's message, to edit. */
  private async lastMessage(): Promise<void> {
    const works = this.deps.store.works();
    const plan = commitPlan(works, this.choices);
    const repos = plan.length > 0 ? plan.map((p) => p.root) : works.filter((w) => commitFiles(w).length > 0).map((w) => w.root);
    if (repos.length !== 1) return;
    try {
      const text = await this.deps.run(repos[0], ["log", "-1", "--format=%B"]);
      this.post({ type: "amendMessage", text: text.replace(/\s+$/, "") });
    } catch {
      // No commit yet: nothing to amend, the box stays empty.
    }
  }

  async commit(message: string, amend: boolean, push: boolean): Promise<void> {
    if (this.busy || message.trim() === "") return;
    const plan = commitPlan(this.deps.store.works(), this.choices);
    if (plan.length === 0) return;
    if (amend) {
      const pushed = (await Promise.all(plan.map(async (p) => ((await this.pushed(p.root)) ? p.name : undefined)))).filter((n): n is string => !!n);
      if (pushed.length > 0 && !(await this.deps.ask.warning(localize("The last commit is already pushed in {0}.", pushed.join(", ")),
        localize("Amending it rewrites history: pushing it again then needs --force."), localize("Amend Anyway")))) return;
    }
    this.busy = true;
    this.postState();
    const done: CommitPlan[] = [];
    const failed: string[] = [];
    try {
      await vscode.window.withProgress({ location: { viewId: CommitPanel.treeId } }, () => runPool(plan, WRITE_CONCURRENCY, async (p) => {
        try {
          await this.commitOne(p, message, amend);
          done.push(p);
        } catch (e) {
          failed.push(localize("{0}: {1}", p.name, gitMessage(e)));
        }
      }, NEVER));
    } finally {
      this.busy = false;
    }
    await Promise.all(plan.map((p) => this.deps.store.readRepo(p.repoId)));
    // Only a commit that landed changes the Log.
    if (done.length > 0) this.deps.committed();
    if (failed.length > 0) {
      // The message stays for another try; the repositories that did commit lost their checked files.
      this.lastError = failed.join("; ");
      void vscode.window.showErrorMessage(localize("Linyra could not commit. {0}.", this.lastError.replace(/[.\s]+$/, "")));
    } else {
      await this.deps.context.workspaceState.update(DRAFT_KEY, { text: "", amend: false });
      this.post({ type: "committed" });
    }
    this.render();
    if (push && done.length > 0) await this.deps.push(new Set(done.map((p) => p.repoId)));
  }

  /**
   * One repository's commit of its checked files: new ones are added first, then `git commit
   * --only` takes exactly those paths (whatever else is staged stays staged, out of this commit).
   * The paths go through a file, so no command line grows with the number of files.
   */
  private async commitOne(p: CommitPlan, message: string, amend: boolean): Promise<void> {
    if (p.add.length > 0) await this.withPaths(p.root, p.add, ["add"]);
    await this.withPaths(p.root, p.paths, ["commit", "--only", ...(amend ? ["--amend"] : []), "--file=-"], { input: message });
  }

  /** git with `paths` as its pathspec, given through a file: no command line grows with the number of files. */
  private async withPaths(root: string, paths: readonly string[], args: string[], opts: RunOptions = {}): Promise<void> {
    const list = path.join(os.tmpdir(), `linyra-paths-${randomBytes(8).toString("hex")}`);
    try {
      await fs.writeFile(list, paths.join("\0"));
      await this.deps.run(root, [...args, `--pathspec-from-file=${list}`, "--pathspec-file-nul"], undefined, { env: WRITE_ENV, ...opts });
    } finally {
      await fs.rm(list, { force: true });
    }
  }

  /** HEAD is on a remote-tracking branch: amending it rewrites what others may have. */
  private async pushed(root: string): Promise<boolean> {
    try {
      return (await this.deps.run(root, ["branch", "-r", "--contains", "HEAD", "--format=%(refname:short)"])).trim() !== "";
    } catch {
      return false;
    }
  }

  /** The tree as text, checks as [x] [-] [ ] (integration test seam). */
  snapshot(): { items: string[]; checked: string; busy: boolean; lastError: string | undefined; visible: boolean } {
    const walk = (rows: readonly CommitRow[], depth: number): string[] => rows.flatMap((r) => [
      `${"  ".repeat(depth)}${r.check === "on" ? "[x]" : r.check === "mixed" ? "[-]" : "[ ]"} ${r.label}${r.description ? ` | ${r.description}` : ""}`,
      ...walk(r.children ?? [], depth + 1),
    ]);
    return { items: walk(this.roots, 0), checked: checkedLabel(this.checked), busy: this.busy, lastError: this.lastError, visible: this.visible };
  }

  dispose(): void {
    for (const d of [...this.messageDisposables, ...this.disposables]) d.dispose();
  }
}

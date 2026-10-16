import * as path from "path";
import * as vscode from "vscode";
import { decorationFor } from "./changesModel";
import { errorLine } from "./git";
import type { RepoDiscovery } from "./repoDiscovery";
import { encodeRevision, INDEX, SCHEME, type RevisionRef } from "./revisionUri";
import type { FileChange } from "./types";
import { commitCount, commitStep, describeUncommitted, diffFor, discardPlan, discardPrompt, totals, viewLabel, type DiffSide, type Group, type RepoWork, type UNode } from "./uncommittedModel";
import type { UncommittedStore } from "./uncommittedStore";

/** A row's identity, as menus and inline buttons pass it (a node) or tests do (plain args). */
interface Target { repoId: string; group?: Group; path?: string }
/** What an action takes in one repository: its files, those of them from the Staged group, and whether it is one file. */
interface Pick { work: RepoWork; files: FileChange[]; staged: FileChange[]; one: boolean }

/** The accent each repository's chip has in the Log, as a theme color id (webview/styles.css). */
const ACCENT_COLORS = ["charts.red", "charts.blue", "charts.yellow", "charts.green", "charts.purple", "terminal.ansiCyan"];
const TREE_SCHEME = "polylog-tree";
/** vscode.git's errors say "Failed to execute git"; git's own words are in their stderr. */
function gitMessage(e: unknown): string {
  const stderr = (e as { stderr?: unknown } | undefined)?.stderr;
  const text = typeof stderr === "string" && stderr.trim() !== "" ? errorLine(stderr) : e instanceof Error ? e.message : String(e);
  // Put in a sentence that ends with its own period.
  return text.replace(/[.\s]+$/, "");
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * VS Code's prompts, in one place: the integration suite answers them through a queue
 * (POLYLOG_ITEST only), since a modal dialog cannot be clicked from a test.
 */
export class Ask {
  private readonly answers: (string | undefined)[] = [];
  private readonly testing = process.env.POLYLOG_ITEST === "1";
  /** Test seam: runs once, as if while the dialog is open, before a queued answer is given. */
  beforeAnswer: (() => Promise<void>) | undefined;
  /** Test seam: the last warning asked, and how many questions were asked. */
  lastWarning: string | undefined;
  asked = 0;

  queue(value: string | undefined): void {
    if (value === undefined) this.answers.length = 0;
    else this.answers.push(value);
  }

  async warning(message: string, detail: string, button: string): Promise<boolean> {
    this.asked++;
    if (this.testing && this.answers.length > 0) {
      const hook = this.beforeAnswer;
      this.beforeAnswer = undefined;
      if (hook) await hook();
      this.lastWarning = message;
      return this.answers.shift() === button;
    }
    return (await vscode.window.showWarningMessage(message, { modal: true, detail }, button)) === button;
  }

  async input(prompt: string, placeHolder: string): Promise<string | undefined> {
    this.asked++;
    if (this.testing && this.answers.length > 0) {
      const a = this.answers.shift();
      return a === "Cancel" ? undefined : a;
    }
    return vscode.window.showInputBox({ prompt, placeHolder, ignoreFocusOut: true });
  }
}

export interface UncommittedViewDeps {
  store: UncommittedStore;
  discovery: RepoDiscovery;
  /** Each repository's accent in the Log (the same color as its chip). */
  accents(): ReadonlyMap<string, number>;
  /** A commit landed: the Log reads its first page again. */
  committed(): void;
  /** The repository has commits to pull (its row offers Pull). */
  behind(repoId: string): boolean;
}

/** The native Uncommitted view: a thin adapter from uncommittedModel's descriptors to TreeItems. */
export class UncommittedView implements vscode.TreeDataProvider<UNode>, vscode.FileDecorationProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<UNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly decorationsChanged = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this.decorationsChanged.event;
  private decorations = new Map<string, vscode.FileDecoration>();
  private decorated: vscode.Uri[] = [];
  private readonly view: vscode.TreeView<UNode>;
  private roots: UNode[] = [];
  private parents = new Map<UNode, UNode>();
  private message: string | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  readonly ask = new Ask();
  /** The last error shown (integration test seam). */
  private lastError: string | undefined;

  private showError(text: string): void {
    this.lastError = text;
    void vscode.window.showErrorMessage(text);
  }

  /** Re-draw (vscode.git opened or closed a repository, ↓/↑ moved). */
  refresh(): void {
    this.render();
  }

  constructor(private readonly deps: UncommittedViewDeps) {
    this.view = vscode.window.createTreeView("polylog.uncommitted", { treeDataProvider: this, showCollapseAll: true, canSelectMany: true });
    this.disposables.push(this.view, deps.store.onDidChange(() => this.render()));
    this.render();
  }

  private render(): void {
    const d = describeUncommitted(this.deps.store.works());
    this.roots = d.roots;
    this.message = d.message;
    this.view.message = d.message;
    this.view.description = viewLabel(totals(this.deps.store.works()));
    this.parents = new Map();
    const before = this.decorated;
    this.decorated = [];
    this.decorations = new Map();
    const walk = (nodes: UNode[], parent?: UNode): void => nodes.forEach((n) => {
      if (parent) this.parents.set(n, parent);
      if (n.kind === "file" && n.file) {
        const dec = decorationFor(n.file.untracked ? "A" : n.file.status);
        if (dec) {
          const uri = this.uriFor(n);
          this.decorations.set(uri.toString(), new vscode.FileDecoration(dec.badge, dec.tooltip, new vscode.ThemeColor(dec.color)));
          this.decorated.push(uri);
        }
      }
      walk(n.children, n);
    });
    walk(this.roots);
    this.emitter.fire(undefined);
    const changed = [...before, ...this.decorated];
    if (changed.length > 0) this.decorationsChanged.fire(changed);
  }

  /** "label | description", indented, repo rows with their contextValue (integration test seam). */
  snapshot(): { message: string | undefined; description: string; items: string[]; lastError: string | undefined; visible: boolean } {
    const walk = (nodes: UNode[], depth: number): string[] => nodes.flatMap((n) => [
      `${"  ".repeat(depth)}${n.label} | ${n.description}${n.kind === "repo" ? ` [${n.contextValue}]` : ""}`,
      ...walk(n.children, depth + 1),
    ]);
    return { message: this.message, description: this.view.description ?? "", items: walk(this.roots, 0), lastError: this.lastError, visible: this.view.visible };
  }

  private uriFor(n: UNode): vscode.Uri {
    return vscode.Uri.from({ scheme: TREE_SCHEME, path: `/${n.path}`, query: `uncommitted:${n.group}:${n.repoId}` });
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    return uri.scheme === TREE_SCHEME ? this.decorations.get(uri.toString()) : undefined;
  }

  getParent(n: UNode): UNode | undefined {
    return this.parents.get(n);
  }

  getChildren(n?: UNode): UNode[] {
    return n ? n.children : this.roots;
  }

  getTreeItem(n: UNode): vscode.TreeItem {
    const item = new vscode.TreeItem(n.label, n.kind === "file" ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Expanded);
    item.id = n.id;
    item.description = n.description;
    item.tooltip = n.tooltip;
    // A repository row: Stage All (".hasChanges"), Unstage All (".hasStaged"), and Pull when behind (".behind", last).
    if (n.kind === "repo") {
      const w = this.deps.store.get(n.repoId);
      item.contextValue = `${n.contextValue}${w?.staged.length ? ".hasStaged" : ""}${w?.changes.length ? ".hasChanges" : ""}${this.deps.behind(n.repoId) ? ".behind" : ""}`;
    } else {
      item.contextValue = n.contextValue;
    }
    if (n.kind === "repo") {
      const accent = this.deps.accents().get(n.repoId) ?? 0;
      item.iconPath = new vscode.ThemeIcon("repo", new vscode.ThemeColor(ACCENT_COLORS[accent % ACCENT_COLORS.length]));
    } else if (n.kind === "folder") {
      item.resourceUri = this.uriFor(n);
      item.iconPath = vscode.ThemeIcon.Folder;
    } else if (n.kind === "file") {
      item.resourceUri = this.uriFor(n);
      item.iconPath = vscode.ThemeIcon.File;
      item.command = { command: "polylog.openUncommittedDiff", title: "Open Diff", arguments: [{ repoId: n.repoId, group: n.group, path: n.path }] };
    }
    return item;
  }

  /** The files a target means: one file, or every file of a group (or of the whole repository). */
  private resolve(arg: unknown): Pick | undefined {
    const t = arg as Partial<Target> | undefined;
    if (!t || typeof t.repoId !== "string") return undefined;
    const work = this.deps.store.get(t.repoId);
    if (!work) return undefined;
    const group = t.group === "staged" || t.group === "changes" ? t.group : undefined;
    const list = group === "staged" ? work.staged : group === "changes" ? work.changes : [...work.staged, ...work.changes];
    // A folder row stands for every file under it.
    const files = typeof t.path === "string" ? list.filter((f) => f.path === t.path || f.path.startsWith(`${t.path}/`)) : list;
    // Staged rows (the Staged group, or a whole repository) lose their staged change too on Discard.
    const staged = group === "changes" ? [] : files.filter((f) => work.staged.includes(f));
    // A file staged and changed again is in both groups: still one file.
    return { work, files, staged, one: files.length > 0 && files.every((f) => f.path === t.path) };
  }

  /**
   * The rows an action takes: the one right-clicked, or every selected row when it is among
   * them (VS Code passes the selection too). Merged by repository; only where VS Code's Git can act.
   */
  private picks(arg: unknown, many?: unknown): Pick[] {
    const rows = Array.isArray(many) && many.length > 1 ? many : [arg];
    const byRepo = new Map<string, Pick>();
    for (const row of rows) {
      const r = this.resolve(row);
      if (!r || r.files.length === 0 || !r.work.canStage) continue;
      const had = byRepo.get(r.work.repoId);
      if (!had) {
        byRepo.set(r.work.repoId, r);
        continue;
      }
      const add = (into: FileChange[], from: FileChange[]) => [...into, ...from.filter((f) => !into.includes(f))];
      const files = add(had.files, r.files);
      byRepo.set(r.work.repoId, { work: had.work, files, staged: add(had.staged, r.staged), one: new Set(files.map((f) => f.path)).size === 1 });
    }
    return [...byRepo.values()];
  }

  private async act(picks: readonly Pick[], verb: string, run: (r: Pick, paths: string[]) => Promise<void>): Promise<void> {
    // A confirmed action runs on the files the prompt listed, not on what is there after it closed.
    for (const r of picks) {
      try {
        await run(r, [...new Set(r.files.flatMap((f) => (f.oldPath ? [f.path, f.oldPath] : [f.path])))]);
      } catch (e) {
        this.showError(`Polylog could not ${verb} ${r.one ? r.files[0].path : plural(new Set(r.files.map((f) => f.path)).size, "file")} in ${r.work.name}: ${gitMessage(e)}.`);
      }
    }
    await Promise.all(picks.map((r) => this.deps.store.readRepo(r.work.repoId)));
  }

  stage(arg: unknown, many?: unknown): Promise<void> {
    return this.act(this.picks(arg, many), "stage", (r, paths) => this.deps.discovery.stage(r.work.root, paths));
  }

  unstage(arg: unknown, many?: unknown): Promise<void> {
    return this.act(this.picks(arg, many), "unstage", (r, paths) => this.deps.discovery.unstage(r.work.root, paths));
  }

  /** A file, a folder, a group, a repository row (all of its work), or several selected rows. Always asks, once. */
  async discard(arg: unknown, many?: unknown): Promise<void> {
    const picks = this.picks(arg, many);
    if (picks.length === 0) return;
    const p = picks.length === 1
      ? discardPrompt(picks[0].work.name, picks[0].files, picks[0].one, picks[0].staged)
      : discardPrompt(plural(picks.length, "repository", "repositories"), picks.flatMap((r) => r.files), false, picks.flatMap((r) => r.staged));
    if (!(await this.ask.warning(p.message, p.detail, p.button))) return;
    await this.act(picks, "discard", (r) => {
      const plan = discardPlan(r.files, r.staged);
      return this.deps.discovery.discard(r.work.root, plan.paths, plan.remove, plan.unstage);
    });
  }

  /** ✓ on a repository: its staged files, or (nothing staged) as VS Code's own commit does. */
  async commit(arg: unknown): Promise<void> {
    const r = this.resolve(arg && typeof arg === "object" ? { repoId: (arg as Target).repoId } : arg);
    if (!r || !r.work.canStage) return;
    const { work } = r;
    // vscode.git's settings are per folder (resource scope): this repository's folder decides.
    const git = vscode.workspace.getConfiguration("git", vscode.Uri.file(work.root));
    const smart = git.get<boolean>("enableSmartCommit", false) === true;
    const step = commitStep(work.staged.length, work.changes.length, smart);
    if (step === "nothing") return;
    if (step === "askStageAll" && !(await this.ask.warning(`There are no staged changes in ${work.name}.`, "Stage all changes and commit them?", "Stage All and Commit"))) return;
    // Commit all, as VS Code's own smart commit: git.smartCommitChanges "tracked" leaves new files out.
    const scope = git.get<string>("smartCommitChanges", "all") === "tracked" ? "tracked" : "all";
    const all: boolean | "tracked" = step === "message" ? false : scope === "tracked" ? "tracked" : true;
    const n = all ? commitCount(work, scope) : work.staged.length;
    if (n === 0) {
      // Smart commit of tracked files only, and only new files changed: git would say "nothing to commit".
      void vscode.window.showInformationMessage(`Nothing to commit in ${work.name}: only new files changed, and git.smartCommitChanges is "tracked".`);
      return;
    }
    // The Path box hides part of the repository; a commit takes all of it. Say so, with the true numbers.
    if (this.deps.store.filtered) {
      const w = await this.deps.store.whole(work.repoId);
      const real = !w ? n : !all ? w.staged : scope === "tracked" ? w.tracked : w.changes;
      if (real > n && !(await this.ask.warning(`The commit takes ${plural(real, "file")} in ${work.name}, not ${n}.`,
        `The Path box shows only part of the repository; ${plural(real - n, "file")} outside it would be committed too.`, `Commit ${plural(real, "File")}`))) return;
    }
    const message = await this.ask.input(`Commit message for ${work.name}`, `Message (${plural(n, "file")} ${all ? "to commit" : "staged"})`);
    if (!message || message.trim() === "") return;
    let ok = true;
    try {
      await this.deps.discovery.commit(work.root, message, all);
    } catch (e) {
      ok = false;
      this.showError(`Polylog could not commit ${work.name}: ${gitMessage(e)}.`);
    }
    await this.deps.store.readRepo(work.repoId);
    // Only a commit that landed changes the Log.
    if (ok) this.deps.committed();
  }

  /** The diff a row opens, as Source Control: Staged is HEAD ↔ index; Changes is index (or HEAD) ↔ file. */
  async openDiff(arg: unknown, preserveFocus = false): Promise<void> {
    const t = arg as Partial<Target> | undefined;
    const work = t && typeof t.repoId === "string" ? this.deps.store.get(t.repoId) : undefined;
    if (!work || typeof t?.path !== "string") return;
    const group: Group = t.group === "staged" ? "staged" : "changes";
    const file = (group === "staged" ? work.staged : work.changes).find((f) => f.path === t.path);
    if (!file) return;
    await openWorkDiff(work, group, file, preserveFocus);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.emitter.dispose();
    this.decorationsChanged.dispose();
  }
}

const revisionUri = (r: RevisionRef) => vscode.Uri.from({ scheme: SCHEME, ...encodeRevision(r) });

function side(work: RepoWork, file: FileChange, s: DiffSide, before: boolean): vscode.Uri {
  const at = before ? file.oldPath ?? file.path : file.path;
  if (s === "worktree") return vscode.Uri.file(path.join(work.root, ...at.split("/")));
  if (s === "index") {
    // The staged blob in the URI: a new staged version is a new document, never a stale one.
    const blob = file.blob ?? work.staged.find((f) => f.path === file.path)?.blob;
    return revisionUri({ root: work.root, ref: INDEX, path: at, ...(blob ? { blob } : {}) });
  }
  return revisionUri({ root: work.root, ref: s === "head" ? work.head : null, path: at });
}

/** Opens one uncommitted file's diff (the Uncommitted view, and the Log's Uncommitted side). */
export async function openWorkDiff(work: RepoWork, group: Group, file: FileChange, preserveFocus = false): Promise<void> {
  const alsoStaged = group === "changes" && work.staged.some((f) => f.path === file.path);
  const d = diffFor(group, file, alsoStaged);
  const title = `${path.posix.basename(file.path)} (${group === "staged" ? "Index" : "Working Tree"}) — ${work.name}`;
  await vscode.commands.executeCommand("vscode.diff", side(work, file, d.left, true), side(work, file, d.right, false), title, { preview: true, preserveFocus });
}

import { randomBytes } from "crypto";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { checkedLabel, commitFiles, commitPlan, describeCommit, filesUnder, pruneChoices, rowsById, setChecked, type CommitPlan, type CommitRow } from "./commitModel";
import type { CommitHostMessage, CommitWebviewMessage } from "./commitProtocol";
import type { RunOptions } from "./git";
import { localize } from "./i18n";
import { runPool } from "./pool";
import { gitMessage, openHeadDiff, type Ask, type UncommittedActions } from "./uncommittedActions";
import { totals, viewLabel } from "./uncommittedModel";
import type { UncommittedStore } from "./uncommittedStore";
import { renderCommitHtml } from "./webview/commit/html";

const DRAFT_KEY = "linyra.commitDraft";
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
 * ticked repository with a checkbox on each row, one message, and Commit (or Commit and Push…)
 * of the checked files only, in every repository that has some. Unchecked files stay as they
 * are, staged or not: each repository's commit is `git commit --only` with the checked paths.
 */
export class CommitPanel implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = "linyra.commit";
  private view: vscode.WebviewView | undefined;
  private viewDisposables: vscode.Disposable[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  private choices = new Map<string, boolean>();
  private rows = new Map<string, CommitRow>();
  private roots: CommitRow[] = [];
  private selection: string[] = [];
  private busy = false;
  /** The last error shown (integration test seam). */
  private lastError: string | undefined;

  constructor(private readonly deps: CommitPanelDeps) {
    this.disposables.push(deps.store.onDidChange(() => this.render()));
    this.render();
  }

  get visible(): boolean {
    return this.view?.visible === true;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const out = vscode.Uri.joinPath(this.deps.context.extensionUri, "out");
    view.webview.options = { enableScripts: true, localResourceRoots: [out] };
    view.webview.html = renderCommitHtml({
      cspSource: view.webview.cspSource,
      nonce: randomBytes(16).toString("hex"),
      scriptUri: view.webview.asWebviewUri(vscode.Uri.joinPath(out, "commit.js")).toString(),
      styleUri: view.webview.asWebviewUri(vscode.Uri.joinPath(out, "commit.css")).toString(),
    });
    for (const d of this.viewDisposables) d.dispose();
    this.viewDisposables = [
      view.webview.onDidReceiveMessage((m: CommitWebviewMessage) => void this.onMessage(m)),
      view.onDidChangeVisibility(() => { if (view.visible) this.deps.shown(); }),
      view.onDidDispose(() => { if (this.view === view) this.view = undefined; }),
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
    this.selection = this.selection.filter((id) => this.rows.has(id));
    const notice = !this.deps.store.started ? localize("Reading uncommitted changes…") : d.message;
    this.post({ type: "state", roots: d.roots, ...(notice ? { notice } : {}), summary: viewLabel(totals(works)), checkedLabel: checkedLabel(d.checked),
      checkedFiles: d.checked.files, busy: this.busy });
  }

  private post(m: CommitHostMessage): void {
    void this.view?.webview.postMessage(m);
  }

  async onMessage(m: CommitWebviewMessage): Promise<void> {
    if (!m || typeof m !== "object") return; // webview input is untrusted
    switch (m.type) {
      case "ready": {
        const draft = this.deps.context.workspaceState.get<{ text?: unknown; amend?: unknown }>(DRAFT_KEY);
        this.post({ type: "draft", text: typeof draft?.text === "string" ? draft.text : "", amend: draft?.amend === true });
        this.render();
        return;
      }
      case "check": {
        const rows = (Array.isArray(m.ids) ? m.ids : []).flatMap((id) => this.rows.get(String(id)) ?? []);
        this.choices = setChecked(this.deps.store.works(), this.choices, rows, m.on === true);
        this.render();
        return;
      }
      case "selection":
        this.selection = (Array.isArray(m.ids) ? m.ids : []).map(String).filter((id) => this.rows.has(id));
        return;
      case "diff": await this.diff(this.rows.get(String(m.id)), m.preview === true); return;
      case "openFile": {
        const row = this.rows.get(String(m.id));
        if (row?.kind === "file") await vscode.commands.executeCommand("linyra.openWorkingFile", row.context);
        return;
      }
      case "rollback": await this.rollback(); return;
      case "refresh": await this.deps.store.readAll(true); return;
      case "draft":
        await this.deps.context.workspaceState.update(DRAFT_KEY, { text: String(m.text ?? ""), amend: m.amend === true });
        return;
      case "amend":
        if (m.on === true && String(m.text ?? "").trim() === "") await this.lastMessage();
        return;
      case "commit": await this.commit(String(m.message ?? ""), m.amend === true, m.push === true); return;
    }
  }

  /** A right-click names its row: the selection when the row is in it, else that row alone. */
  private targets(arg: unknown): CommitRow[] {
    const id = (arg as { commitRowId?: unknown } | undefined)?.commitRowId;
    const ids = typeof id === "string" ? (this.selection.includes(id) ? this.selection : [id]) : this.selection;
    return ids.flatMap((x) => this.rows.get(x) ?? []);
  }

  /** Show Diff from a right-click or a row: the last commit ↔ the working tree. */
  async diff(arg: unknown, preserveFocus = false): Promise<void> {
    const row = arg && typeof arg === "object" && "kind" in arg && "check" in arg ? (arg as CommitRow) : this.targets(arg)[0];
    if (row?.kind !== "file") return;
    const work = this.deps.store.get(row.repoId!);
    const file = work && commitFiles(work).find((f) => f.path === row.path);
    if (work && file) await openHeadDiff(work, file, preserveFocus);
  }

  /** Rollback…: the right-clicked rows (or the selection), else every checked file. One prompt, as Discard asks. */
  async rollback(arg?: unknown): Promise<void> {
    let rows = this.targets(arg);
    if (rows.length === 0) rows = [...this.rows.values()].filter((r) => r.kind === "file" && r.check === "on");
    const files = filesUnder(rows);
    if (files.length === 0) return;
    await this.deps.actions.discard(files[0], files);
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
    this.render();
    const done: CommitPlan[] = [];
    const failed: string[] = [];
    try {
      await vscode.window.withProgress({ location: { viewId: CommitPanel.viewType } }, () => runPool(plan, WRITE_CONCURRENCY, async (p) => {
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
    const list = path.join(os.tmpdir(), `linyra-commit-${randomBytes(8).toString("hex")}`);
    const fromList = [`--pathspec-from-file=${list}`, "--pathspec-file-nul"];
    try {
      if (p.add.length > 0) {
        await fs.writeFile(list, p.add.join("\0"));
        await this.deps.run(p.root, ["add", ...fromList], undefined, { env: WRITE_ENV });
      }
      await fs.writeFile(list, p.paths.join("\0"));
      await this.deps.run(p.root, ["commit", "--only", ...(amend ? ["--amend"] : []), "--file=-", ...fromList], undefined, { input: message, env: WRITE_ENV });
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
  snapshot(): { items: string[]; checked: string; busy: boolean; lastError: string | undefined; visible: boolean; selection: string[] } {
    const walk = (rows: readonly CommitRow[], depth: number): string[] => rows.flatMap((r) => [
      `${"  ".repeat(depth)}${r.check === "on" ? "[x]" : r.check === "mixed" ? "[-]" : "[ ]"} ${r.label}${r.description ? ` | ${r.description}` : ""}`,
      ...walk(r.children ?? [], depth + 1),
    ]);
    const d = describeCommit(this.deps.store.works(), this.choices);
    return { items: walk(this.roots, 0), checked: checkedLabel(d.checked), busy: this.busy, lastError: this.lastError, visible: this.visible, selection: [...this.selection] };
  }

  dispose(): void {
    for (const d of [...this.viewDisposables, ...this.disposables]) d.dispose();
  }
}

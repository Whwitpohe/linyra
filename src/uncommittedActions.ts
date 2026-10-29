import { localize } from "./i18n";
import { promises as fs } from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { errorLine } from "./git";
import type { RepoDiscovery } from "./repoDiscovery";
import { encodeRevision, INDEX, SCHEME, type RevisionRef } from "./revisionUri";
import type { FileChange } from "./types";
import { addedPaths, commitCount, commitStep, deletePrompt, describeUncommitted, diffFor, discardPlan, discardPrompt, rollbackPlan, rollbackPrompt, totals, viewLabel, type DiffSide, type Group, type RepoWork, type UNode } from "./uncommittedModel";
import type { UncommittedStore } from "./uncommittedStore";

/** A row's identity, as menus and inline buttons pass it (a node) or tests do (plain args). */
interface Target { repoId: string; group?: Group; path?: string }
/** What an action takes in one repository: its files, those of them from the Staged group, and whether it is one file. */
interface Pick { work: RepoWork; files: FileChange[]; staged: FileChange[]; one: boolean }

/** vscode.git's errors say "Failed to execute git"; git's own words are in their stderr. */
export function gitMessage(e: unknown): string {
  const stderr = (e as { stderr?: unknown } | undefined)?.stderr;
  const text = typeof stderr === "string" && stderr.trim() !== "" ? errorLine(stderr) : e instanceof Error ? e.message : String(e);
  // Put in a sentence that ends with its own period.
  return text.replace(/[.\s]+$/, "");
}
const plural = (n: number, one: string, many = `${one}s`) => localize("{0} {1}", n, localize(n === 1 ? one : many));

/**
 * VS Code's prompts, in one place: the integration suite answers them through a queue
 * (LINYRA_ITEST only), since a modal dialog cannot be clicked from a test.
 */
export class Ask {
  private readonly answers: (string | undefined)[] = [];
  private readonly testing = process.env.LINYRA_ITEST === "1";
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

  async input(prompt: string, placeHolder: string, opts: { value?: string; validate?: (v: string) => string | vscode.InputBoxValidationMessage | undefined } = {}): Promise<string | undefined> {
    this.asked++;
    if (this.testing && this.answers.length > 0) {
      const a = this.answers.shift();
      return a === "Cancel" ? undefined : a;
    }
    return vscode.window.showInputBox({ prompt, placeHolder, value: opts.value, validateInput: opts.validate, ignoreFocusOut: true });
  }

  /** One item; its index. Testing: the queued answer is the item's label. */
  async pick(items: readonly vscode.QuickPickItem[], placeHolder: string): Promise<number | undefined> {
    this.asked++;
    if (this.testing && this.answers.length > 0) {
      const answer = this.answers.shift();
      const i = items.findIndex((x) => x.label === answer);
      return i < 0 ? undefined : i;
    }
    const chosen = await vscode.window.showQuickPick([...items], { placeHolder });
    return chosen ? items.indexOf(chosen) : undefined;
  }

  /** Ticked items (those with `picked` start ticked); their indexes. Testing: a JSON array of labels. */
  async pickMany(items: readonly vscode.QuickPickItem[], placeHolder: string): Promise<number[] | undefined> {
    this.asked++;
    if (this.testing && this.answers.length > 0) {
      const a = this.answers.shift();
      if (a === undefined || a === "Cancel") return undefined;
      const labels = JSON.parse(a) as string[];
      return items.flatMap((x, i) => (labels.includes(x.label) ? [i] : []));
    }
    const chosen = await vscode.window.showQuickPick([...items], { placeHolder, canPickMany: true });
    return chosen ? chosen.map((c) => items.indexOf(c)) : undefined;
  }

}

export interface UncommittedActionsDeps {
  store: UncommittedStore;
  discovery: RepoDiscovery;
  /** A commit landed: the Log reads its first page again. */
  committed(): void;
  /** VS Code's prompts, shared with the Log (one queue for the integration suite). */
  ask: Ask;
}

/**
 * Stage, Unstage, Discard and Commit for the Log's Uncommitted side, the Changes view and the
 * Commit side bar (CommitPanel, which commits through git itself).
 */
export class UncommittedActions {
  readonly ask: Ask;
  /** The last error shown (integration test seam). */
  private lastError: string | undefined;

  private showError(text: string): void {
    this.lastError = text;
    void vscode.window.showErrorMessage(text);
  }

  constructor(private readonly deps: UncommittedActionsDeps) {
    this.ask = deps.ask;
  }

  /**
   * The uncommitted work as uncommittedModel describes it: "label | description", indented, repo
   * rows with their contextValue (integration test seam).
   */
  snapshot(): { message: string | undefined; description: string; items: string[]; lastError: string | undefined } {
    const works = this.deps.store.works();
    const d = describeUncommitted(works);
    const walk = (nodes: UNode[], depth: number): string[] => nodes.flatMap((n) => [
      `${"  ".repeat(depth)}${n.label} | ${n.description}${n.kind === "repo" ? ` [${n.contextValue}]` : ""}`,
      ...walk(n.children, depth + 1),
    ]);
    return { message: d.message, description: viewLabel(totals(works)), items: walk(d.roots, 0), lastError: this.lastError };
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
        this.showError(localize("Linyra could not {0} {1} in {2}: {3}.", localize(verb), r.one ? r.files[0].path : plural(new Set(r.files.map((f) => f.path)).size, "file"), r.work.name, gitMessage(e)));
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

  /**
   * The Commit side bar's Rollback, as the JetBrains IDEs': tracked files back to the last commit,
   * an added file only out of version control (unstaged, kept on disk). Unversioned files are
   * left alone: Delete… is the command that removes files.
   */
  async rollback(arg: unknown, many?: unknown): Promise<void> {
    const picks = this.picks(arg, many).filter((r) => r.files.some((f) => !f.untracked));
    if (picks.length === 0) return;
    const p = picks.length === 1
      ? rollbackPrompt(picks[0].work.name, picks[0].files, picks[0].one, picks[0].staged)
      : rollbackPrompt(plural(picks.length, "repository", "repositories"), picks.flatMap((r) => r.files), false, picks.flatMap((r) => r.staged));
    if (!(await this.ask.warning(p.message, p.detail, p.button))) return;
    await this.act(picks, "roll back", async (r) => {
      const plan = rollbackPlan(r.files, r.staged);
      if (plan.unadd.length > 0) await this.deps.discovery.unstage(r.work.root, plan.unadd);
      if (plan.paths.length > 0) await this.deps.discovery.discard(r.work.root, plan.paths, plan.remove, plan.unstage);
    });
  }

  /**
   * Delete… in the Commit side bar: new files only (unversioned, or added and never committed),
   * from the disk, after one prompt. An added file is unstaged first. Folders left empty go too.
   */
  async deleteNew(arg: unknown, many?: unknown): Promise<void> {
    const picks = this.picks(arg, many).flatMap((r): Pick[] => {
      const added = addedPaths(r.staged);
      const files = r.files.filter((f) => f.untracked || added.has(f.path));
      const paths = new Set(files.map((f) => f.path));
      return files.length === 0 ? [] : [{ work: r.work, files, staged: r.staged.filter((f) => added.has(f.path)), one: paths.size === 1 }];
    });
    if (picks.length === 0) return;
    const paths = (r: Pick) => [...new Set(r.files.map((f) => f.path))];
    const p = picks.length === 1
      ? deletePrompt(picks[0].work.name, paths(picks[0]), picks[0].one)
      : deletePrompt(plural(picks.length, "repository", "repositories"), picks.flatMap(paths), false);
    if (!(await this.ask.warning(p.message, p.detail, p.button))) return;
    await this.act(picks, "delete", async (r) => {
      if (r.staged.length > 0) await this.deps.discovery.unstage(r.work.root, r.staged.map((f) => f.path));
      for (const file of paths(r)) await removeFile(r.work.root, file);
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
    if (step === "askStageAll" && !(await this.ask.warning(localize("There are no staged changes in {0}.", work.name), localize("Stage all changes and commit them?"), localize("Stage All and Commit")))) return;
    // Commit all, as VS Code's own smart commit: git.smartCommitChanges "tracked" leaves new files out.
    const scope = git.get<string>("smartCommitChanges", "all") === "tracked" ? "tracked" : "all";
    const all: boolean | "tracked" = step === "message" ? false : scope === "tracked" ? "tracked" : true;
    const n = all ? commitCount(work, scope) : work.staged.length;
    if (n === 0) {
      // Smart commit of tracked files only, and only new files changed: git would say "nothing to commit".
      void vscode.window.showInformationMessage(localize("Nothing to commit in {0}: only new files changed, and git.smartCommitChanges is \"tracked\".", work.name));
      return;
    }
    // The Path box hides part of the repository; a commit takes all of it. Say so, with the true numbers.
    if (this.deps.store.filtered) {
      const w = await this.deps.store.whole(work.repoId);
      const real = !w ? n : !all ? w.staged : scope === "tracked" ? w.tracked : w.changes;
      if (real > n && !(await this.ask.warning(localize("The commit takes {0} in {1}, not {2}.", plural(real, "file"), work.name, n),
        localize("The Path box shows only part of the repository; {0} outside it would be committed too.", plural(real - n, "file")), localize("Commit {0}", plural(real, "File"))))) return;
    }
    const message = await this.ask.input(localize("Commit message for {0}", work.name), localize("Message ({0} {1})", plural(n, "file"), all ? localize("to commit") : localize("staged")));
    if (!message || message.trim() === "") return;
    let ok = true;
    try {
      await this.deps.discovery.commit(work.root, message, all);
    } catch (e) {
      ok = false;
      this.showError(localize("Linyra could not commit {0}: {1}.", work.name, gitMessage(e)));
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

}

/** A new file goes from the disk, and the folders it leaves empty with it (never the repository's root). */
async function removeFile(root: string, file: string): Promise<void> {
  const parts = file.split("/");
  await fs.rm(path.join(root, ...parts), { force: true });
  for (let n = parts.length - 1; n > 0; n--) {
    try {
      await fs.rmdir(path.join(root, ...parts.slice(0, n)));
    } catch {
      return; // not empty: the rest of the way up is not either
    }
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

/**
 * The Commit side bar's diff: the last commit ↔ the working tree, whatever is staged (its commit
 * takes the file as it is). A new file's left side is empty, a deleted file's right side.
 */
export async function openHeadDiff(work: RepoWork, file: { path: string; oldPath?: string; status?: FileChange["status"]; untracked: boolean }, preserveFocus = false): Promise<void> {
  const change: FileChange = { path: file.path, ...(file.oldPath ? { oldPath: file.oldPath } : {}), added: null, deleted: null, status: file.status, untracked: file.untracked };
  const left = file.untracked || file.status === "A" ? "empty" : "head";
  const right = file.status === "D" ? "empty" : "worktree";
  const title = `${path.posix.basename(file.path)} (${localize("Working Tree")}) — ${work.name}`;
  await vscode.commands.executeCommand("vscode.diff", side(work, change, left, true), side(work, change, right, false), title, { preview: true, preserveFocus });
}

/** Opens one uncommitted file's diff (the Log's Uncommitted side and the Changes view). */
export async function openWorkDiff(work: RepoWork, group: Group, file: FileChange, preserveFocus = false): Promise<void> {
  const alsoStaged = group === "changes" && work.staged.some((f) => f.path === file.path);
  const d = diffFor(group, file, alsoStaged);
  const title = `${path.posix.basename(file.path)} (${group === "staged" ? localize("Index") : localize("Working Tree")}) — ${work.name}`;
  await vscode.commands.executeCommand("vscode.diff", side(work, file, d.left, true), side(work, file, d.right, false), title, { preview: true, preserveFocus });
}

import { localize } from "./i18n";
import * as path from "path";
import * as vscode from "vscode";
import type { RunGit } from "./logQuery";
import { runPool } from "./pool";
import { abortAllPrompt, abortArgs, abortPrompt, continueArgs, NO_EDITOR_ENV, operationName, unmergedArgs, type Operation, type RepoMark } from "./repoMarkModel";
import type { Repo } from "./types";
import { gitMessage, type Ask } from "./uncommittedActions";

export interface OperationHost {
  repos(): readonly Repo[];
  /** The repository a Repo List right-click was on. */
  contextRepo(arg: unknown): Repo | undefined;
  mark(repoId: string): RepoMark | undefined;
  run: RunGit;
  ask: Ask;
  /** These repositories changed: the Log, their uncommitted work and their marks are read again. */
  changed(repoIds: readonly string[]): Promise<void>;
}

const parseNames = (out: string) => out.split("\0").filter(Boolean);

/**
 * A merge, rebase, cherry-pick or revert that stopped, from the Repo List's right-click: open its
 * conflicts in the merge editor, Continue it (git's own --continue, with the message git prepared),
 * or Abort it — in one repository, or in every repository in the middle of one.
 */
export class OperationActions {
  /** The last error shown (integration test seam). */
  lastError: string | undefined;

  constructor(private readonly host: OperationHost) {}

  /** The right-clicked repository and what it is in the middle of, if it still is. */
  private target(arg: unknown, op?: Operation): { repo: Repo; op: Operation } | undefined {
    const repo = this.host.contextRepo(arg);
    const current = repo ? this.host.mark(repo.id)?.operation : undefined;
    if (!repo || !current || (op && op !== current)) return undefined;
    return { repo, op: current };
  }

  private async conflicted(repo: Repo): Promise<string[]> {
    return parseNames(await this.host.run(repo.root, unmergedArgs(), new AbortController().signal));
  }

  /**
   * Resolve Conflicts…: each conflicted file opens in VS Code's merge editor (the file itself, with
   * its markers, where VS Code's Git does not have the repository open). Several: pick one. A
   * stash applied with conflicts has them too, with no operation to continue.
   */
  async resolve(arg: unknown): Promise<void> {
    const repo = this.host.contextRepo(arg);
    if (!repo) return;
    const op = this.host.mark(repo.id)?.operation;
    let files: string[];
    try {
      files = await this.conflicted(repo);
    } catch (e) {
      return this.fail(localize("Linyra could not list the conflicts in {0}: {1}.", repo.name, gitMessage(e)));
    }
    if (files.length === 0) {
      void vscode.window.showInformationMessage(op
        ? localize("{0}: no file has conflicts left. Continue the {1} when you are ready.", repo.name, operationName(op))
        : localize("{0}: no file has conflicts.", repo.name));
      return;
    }
    const t = { repo };
    let file = files[0];
    if (files.length > 1) {
      const i = await this.host.ask.pick(files.map((f) => ({ label: path.posix.basename(f), description: path.posix.dirname(f) === "." ? "" : path.posix.dirname(f) })), localize("{0} files in {1} have conflicts: open one in the merge editor", files.length, t.repo.name));
      if (i === undefined) return;
      file = files[i];
    }
    const uri = vscode.Uri.file(path.join(t.repo.root, ...file.split("/")));
    try {
      await vscode.commands.executeCommand("git.openMergeEditor", uri);
    } catch {
      await vscode.commands.executeCommand("vscode.open", uri);
    }
  }

  /** Continue: only once no file has conflicts; git uses the message it prepared. */
  async continue(arg: unknown, op: Operation): Promise<void> {
    const t = this.target(arg, op);
    if (!t) return;
    let left: string[];
    try {
      left = await this.conflicted(t.repo);
    } catch (e) {
      return this.fail(localize("Linyra could not list the conflicts in {0}: {1}.", t.repo.name, gitMessage(e)));
    }
    if (left.length > 0) {
      const resolve = localize("Resolve Conflicts…");
      this.lastError = localize("{0} files in {1} still have conflicts. Resolve them (and stage them) before the {2} can continue.", left.length, t.repo.name, operationName(t.op));
      void vscode.window.showWarningMessage(this.lastError, resolve).then((answer) => (answer === resolve ? this.resolve(arg) : undefined));
      return;
    }
    try {
      await this.host.run(t.repo.root, continueArgs(t.op), new AbortController().signal, { env: NO_EDITOR_ENV });
    } catch (e) {
      // A rebase that stops again on the next commit fails here too: the marks show where it is.
      this.fail(localize("Linyra could not continue the {0} in {1}: {2}.", operationName(t.op), t.repo.name, gitMessage(e)));
    }
    await this.host.changed([t.repo.id]);
  }

  /** Abort: the branch and the working tree go back to before the operation (asked first). */
  async abort(arg: unknown, op: Operation): Promise<void> {
    const t = this.target(arg, op);
    if (!t) return;
    const p = abortPrompt(t.op, [t.repo.name]);
    if (!(await this.host.ask.warning(p.message, p.detail, p.button))) return;
    await this.abortEach([t]);
  }

  /** Abort in All Repositories…: a checklist of every repository in the middle of something. */
  async abortAll(): Promise<void> {
    const busy = this.host.repos().flatMap((repo) => {
      const op = this.host.mark(repo.id)?.operation;
      return op ? [{ repo, op }] : [];
    });
    if (busy.length === 0) {
      void vscode.window.showInformationMessage(localize("Linyra: no repository is in the middle of a merge, rebase, cherry-pick or revert."));
      return;
    }
    const picked = await this.host.ask.pickMany(busy.map((b) => ({
      label: b.repo.name, description: operationName(b.op), picked: true,
      detail: (this.host.mark(b.repo.id)?.work?.conflicts ?? 0) > 0 ? localize("{0} files with conflicts", this.host.mark(b.repo.id)!.work!.conflicts) : undefined,
    })), localize("Abort in these repositories"));
    if (!picked || picked.length === 0) return;
    const chosen = picked.map((i) => busy[i]);
    const p = abortAllPrompt(chosen.length);
    if (!(await this.host.ask.warning(p.message, p.detail, p.button))) return;
    await this.abortEach(chosen);
  }

  private async abortEach(targets: readonly { repo: Repo; op: Operation }[]): Promise<void> {
    // Never killed halfway: an abort rewrites the working tree.
    const settled = await runPool([...targets], 4, (t) => this.host.run(t.repo.root, abortArgs(t.op), new AbortController().signal, { env: NO_EDITOR_ENV }), new AbortController().signal);
    const failed = targets.flatMap((t, i) => {
      const s = settled[i];
      return s.status === "rejected" ? [`${t.repo.name} (${gitMessage(s.reason)})`] : [];
    });
    if (failed.length > 0) this.fail(localize("Linyra could not abort in {0}.", failed.join(", ")));
    else if (targets.length > 1) vscode.window.setStatusBarMessage(localize("Linyra: aborted in {0} repositories.", targets.length), 8000);
    await this.host.changed(targets.map((t) => t.repo.id));
  }

  private fail(message: string): void {
    this.lastError = message;
    void vscode.window.showErrorMessage(message);
  }
}

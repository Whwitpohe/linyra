import { localize } from "./i18n";
import * as vscode from "vscode";
import { readText } from "./clipboard";
import type { RunGit } from "./logQuery";
import { promises as fsp } from "fs";
import * as path from "path";
import { amArgs, applyArgs, isMailbox, looksLikePatch, mailboxCommits, patchFiles, patchFit, patchSources } from "./patchModel";
import type { Repo } from "./types";
import { gitMessage, type Ask } from "./uncommittedActions";
import { readHead } from "./repoHead";
import { operationName } from "./repoMarkModel";

export interface PatchHost {
  /** The repositories to choose from when the command did not come from one (the ticked ones). */
  repos(): readonly Repo[];
  contextRepo(arg: unknown): Repo | undefined;
  run: RunGit;
  ask: Ask;
  /** The repository changed: its uncommitted work, the Log, its marks. */
  changed(repoIds: readonly string[]): Promise<void>;
}

/** Never killed halfway: git apply and git am write the working tree. */
const WRITE_SIGNAL = new AbortController().signal;
const ENV = { LC_ALL: "C", GIT_EDITOR: ":" };

/**
 * Apply Patch…, as the JetBrains IDEs offer it: a patch from a file or the clipboard (Create
 * Patch…'s output, a diff from anywhere) applied to a repository's working tree; git
 * format-patch's mailbox can become its commits instead (git am).
 */
export class PatchActions {
  /** The last error or note shown (integration test seam). */
  lastMessage: string | undefined;

  constructor(private readonly host: PatchHost) {}

  /**
   * The patch first (a file or the clipboard), then where it goes: the repository it came from
   * (a right-click on one), else the one ticked repository that has every file the patch changes;
   * asked only when none or several do.
   */
  async apply(arg?: unknown): Promise<void> {
    const fixed = this.host.contextRepo(arg);
    const source = await this.host.ask.pick([{ label: localize("From File…") }, { label: localize("From Clipboard") }], fixed ? localize("Apply a patch to {0}", fixed.name) : localize("Apply a patch"));
    if (source === undefined) return;
    const text = source === 0 ? await this.readFile(fixed) : await readText();
    if (text === undefined) return;
    if (!looksLikePatch(text)) return this.fail(localize("That is not a patch: no diff in it."));
    const repo = fixed ?? (await this.repoFor(text));
    if (!repo) return;
    const files = patchFiles(text);
    let asCommits = false;
    if (isMailbox(text)) {
      const n = mailboxCommits(text);
      const i = await this.host.ask.pick([
        { label: localize("Apply as Changes"), description: localize("to the working tree, to review and commit") },
        { label: localize("Apply as Commits"), description: localize("{0} commits with their messages and authors (git am)", n) },
      ], localize("{0} files from {1} commits", files.length, n));
      if (i === undefined) return;
      asCommits = i === 1;
    }
    try {
      if (asCommits) await this.applyCommits(repo, text);
      else if (!(await this.applyChanges(repo, text, files))) return;
    } finally {
      await this.host.changed([repo.id]);
    }
  }

  /**
   * The ticked repository the patch fits: the files it changes are there (`stat`, no git process).
   * Exactly one: that one. None or several: asked, the best fits first.
   */
  private async repoFor(text: string): Promise<Repo | undefined> {
    const repos = this.host.repos();
    if (repos.length <= 1) return repos[0];
    const expected = patchSources(text).slice(0, 50);
    const exists = (root: string, file: string) => fsp.stat(path.join(root, ...file.split("/"))).then(() => 1, () => 0);
    const found = new Map(await Promise.all(repos.map(async (r) => [r.id, (await Promise.all(expected.map((f) => exists(r.root, f)))).reduce<number>((n, x) => n + x, 0)] as const)));
    const fit = patchFit(repos, expected.length, found);
    if (fit.sure) return fit.sure;
    const several = fit.offer.length < repos.length;
    const i = await this.host.ask.pick(fit.offer.map((r) => ({ label: r.name, description: expected.length > 0 ? localize("{0} of the {1} files it changes", found.get(r.id) ?? 0, expected.length) : r.root })),
      several ? localize("Several repositories have the files this patch changes: which one?") : expected.length > 0 ? localize("No ticked repository has every file this patch changes: which one?") : localize("Repository to apply the patch to"));
    return i === undefined ? undefined : fit.offer[i];
  }

  private async readFile(repo: Repo | undefined): Promise<string | undefined> {
    const home = repo?.root ?? this.host.repos()[0]?.root;
    const picked = process.env.LINYRA_ITEST === "1" && this.testFile ? [vscode.Uri.file(this.testFile)]
      : await vscode.window.showOpenDialog({ defaultUri: home ? vscode.Uri.file(home) : undefined, canSelectMany: false, filters: { [localize("Patch")]: ["patch", "diff"], [localize("All Files")]: ["*"] }, title: repo ? localize("Apply a patch to {0}", repo.name) : localize("Apply a patch") });
    if (!picked?.[0]) return undefined;
    return Buffer.from(await vscode.workspace.fs.readFile(picked[0])).toString("utf8");
  }
  /** Test seam: the file From File… opens. */
  testFile: string | undefined;

  /** git apply; when the context no longer matches, a three-way merge is offered. false: declined. */
  private async applyChanges(repo: Repo, text: string, files: readonly string[]): Promise<boolean> {
    let threeWay = false;
    try {
      await this.host.run(repo.root, applyArgs({ check: true }), WRITE_SIGNAL, { input: text, env: ENV });
    } catch (e) {
      if (!(await this.host.ask.warning(localize("The patch does not apply cleanly to {0}.", repo.name),
        localize("{0}\n\nApply it with a three-way merge? Where it does not fit, the files get conflict markers to resolve.", gitMessage(e)), localize("Apply with Merge")))) return false;
      threeWay = true;
    }
    try {
      await this.host.run(repo.root, applyArgs({ threeWay }), WRITE_SIGNAL, { input: text, env: ENV });
      this.note(localize(files.length === 1 ? "Linyra: applied the patch to {0} (1 file)." : "Linyra: applied the patch to {0} ({1} files).", repo.name, files.length));
    } catch (e) {
      // A three-way apply that left conflicts exits non-zero; the files are there to resolve.
      this.fail(threeWay ? localize("The patch was applied to {0} with conflicts: {1}. Resolve them, then commit.", repo.name, gitMessage(e))
        : localize("Linyra could not apply the patch to {0}: {1}.", repo.name, gitMessage(e)));
    }
    return true;
  }

  /** git am; stopped on a commit, its own session is aborted so nothing is left half applied. */
  private async applyCommits(repo: Repo, text: string): Promise<void> {
    // A merge, rebase or patch series already in progress is the user's: refused, never aborted.
    const busy = (await readHead(repo.root).catch(() => undefined))?.operation;
    if (busy) return this.fail(localize("{0} is in the middle of a {1}: finish or abort it first.", repo.name, operationName(busy).toLowerCase()));
    try {
      await this.host.run(repo.root, amArgs(), WRITE_SIGNAL, { input: text, env: ENV });
      this.note(localize("Linyra: applied {0} commits to {1}.", mailboxCommits(text), repo.name));
    } catch (e) {
      await this.host.run(repo.root, ["am", "--abort"], WRITE_SIGNAL, { env: ENV }).catch(() => undefined);
      this.fail(localize("The commits do not apply to {0}: {1}. Nothing was applied; try Apply as Changes.", repo.name, gitMessage(e)));
    }
  }

  private note(message: string): void {
    this.lastMessage = message;
    vscode.window.setStatusBarMessage(message, 8000);
  }

  private fail(message: string): void {
    this.lastMessage = message;
    void vscode.window.showErrorMessage(message);
  }
}

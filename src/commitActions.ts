import * as vscode from "vscode";
import { commitCommands, newRefProblem, parseRefNames, rewordMessage, stoppedReason, type CommitAction, type ResetMode } from "./commitActionModel";
import { localize } from "./i18n";
import type { RunGit } from "./logQuery";
import type { RepoDiscovery } from "./repoDiscovery";
import type { Commit, Repo } from "./types";
import type { Ask } from "./uncommittedView";

/** A write must finish once started: a cherry-pick killed halfway leaves the working tree mid-change. */
const WRITE_SIGNAL = new AbortController().signal;
/** Writes may take the index lock; git's words stay English for stoppedReason; never an editor. */
const WRITE_ENV = { GIT_OPTIONAL_LOCKS: "1", LC_ALL: "C", GIT_EDITOR: "true" };

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const short = (sha: string) => sha.slice(0, 7);

/** What the commit actions need from the Log. */
export interface CommitActionHost {
  /** The listed commit a right-click was on, and its repository. */
  commit(arg: unknown): { repo: Repo; commit: Commit } | undefined;
  run: RunGit;
  discovery: RepoDiscovery;
  ask: Ask;
  /** The repository changed: the Log, its uncommitted work, its upstream distance and its branches. */
  changed(repoId: string): Promise<void>;
}

/**
 * The Log's commit-row actions that change a repository, as the JetBrains Log offers them:
 * cherry-pick, revert, reset the current branch, check out the revision, new branch, new tag.
 * Each runs in the commit's own repository, through VS Code's Git where its API has the
 * operation, and asks before moving a branch or HEAD.
 */
export class CommitActions {
  /** Repositories with an action running: a second one waits for nothing and does nothing. */
  private readonly busy = new Set<string>();

  constructor(private readonly host: CommitActionHost) {}

  async run(action: CommitAction, arg: unknown): Promise<void> {
    const found = this.host.commit(arg);
    if (!found) return;
    const { repo, commit } = found;
    if (this.busy.has(repo.id)) {
      void vscode.window.showInformationMessage(localize("A Git operation is already running in {0}.", repo.name));
      return;
    }
    this.busy.add(repo.id);
    let wrote = false;
    try {
      const done = await this.perform(action, repo, commit);
      if (done) {
        wrote = true;
        vscode.window.setStatusBarMessage(done, 8000);
      }
    } catch (e) {
      wrote = true; // a stopped cherry-pick or revert still changed the working tree
      const reason = stoppedReason(action, messageOf(e));
      if (reason && /already on the checked-out branch/.test(reason)) await this.skip(repo, action);
      void vscode.window.showErrorMessage(localize("Commit action failed in {0}: {1}", repo.name, reason ? localize(reason) : messageOf(e)));
    } finally {
      try {
        if (wrote) {
          await this.host.discovery.branchRepository(repo.root)?.status?.();
          await this.host.changed(repo.id);
        }
      } finally {
        this.busy.delete(repo.id);
      }
    }
  }

  /** The status-bar line for what was done, or undefined when the user cancelled. */
  private async perform(action: CommitAction, repo: Repo, commit: Commit): Promise<string | undefined> {
    const git = (args: string[]) => this.host.run(repo.root, args, WRITE_SIGNAL, { env: WRITE_ENV });
    const native = this.host.discovery.branchRepository(repo.root);
    const merge = commit.parents.length > 1;
    switch (action) {
      case "cherryPick":
        await git(commitCommands.cherryPick(commit.sha, merge));
        return localize("Cherry-picked {0} in {1}.", short(commit.sha), repo.name);
      case "revert":
        await git(commitCommands.revert(commit.sha, merge));
        return localize("Reverted {0} in {1}.", short(commit.sha), repo.name);
      case "reset": {
        const branch = await this.currentBranch(repo);
        const modes: { mode: ResetMode; label: string; description: string }[] = [
          { mode: "soft", label: localize("Soft"), description: localize("Keep every change, staged") },
          { mode: "mixed", label: localize("Mixed"), description: localize("Keep every change, unstaged") },
          { mode: "hard", label: localize("Hard"), description: localize("Discard every change, uncommitted work included") },
        ];
        const i = await this.host.ask.pick(modes, localize("Reset {0} to {1}", branch, short(commit.sha)));
        if (i === undefined) return undefined;
        const { mode } = modes[i];
        const detail = mode === "hard"
          ? localize("Uncommitted changes in {0} are discarded. This cannot be undone.", repo.name)
          : localize("Commits after {0} leave the branch; the files keep their changes.", short(commit.sha));
        if (!(await this.host.ask.warning(localize("Reset {0} to {1} in {2}?", branch, short(commit.sha), repo.name), detail, localize("Reset")))) return undefined;
        await git(commitCommands.reset(commit.sha, mode));
        return localize("Reset {0} to {1} in {2}.", branch, short(commit.sha), repo.name);
      }
      case "checkout": {
        if (!(await this.host.ask.warning(localize("Check out {0} in {1}?", short(commit.sha), repo.name),
          localize("HEAD is detached there: new commits belong to no branch until you create one."), localize("Check Out")))) return undefined;
        if (native?.checkout) await native.checkout(commit.sha);
        else await git(commitCommands.checkout(commit.sha));
        return localize("Checked out {0} in {1}.", short(commit.sha), repo.name);
      }
      case "newBranch": {
        const taken = parseRefNames(await this.host.run(repo.root, ["for-each-ref", "--format=%(refname:short)", "refs/heads"], WRITE_SIGNAL));
        const name = await this.askName(localize("New branch at {0}", short(commit.sha)), localize("Branch name"), taken, "branch");
        if (!name) return undefined;
        if (native?.createBranch) await native.createBranch(name, true, commit.sha);
        else await git(commitCommands.newBranch(commit.sha, name));
        return localize("Created branch {0} at {1} in {2}.", name, short(commit.sha), repo.name);
      }
      case "undo": case "reword": {
        // Both rewrite HEAD only: the row must still be HEAD (the Log may be a moment old).
        const head = (await this.host.run(repo.root, ["rev-parse", "HEAD"], WRITE_SIGNAL)).trim();
        if (head !== commit.sha) throw new Error(localize("Only the checked-out commit can be changed here; it is no longer {0}.", short(commit.sha)));
        if (action === "undo" && commit.parents.length !== 1) throw new Error(localize("Only a commit with one parent can be undone here."));
        const pushed = parseRefNames(await this.host.run(repo.root, commitCommands.pushedTo(commit.sha), WRITE_SIGNAL));
        const warning = pushed.length ? localize("It is already on {0}: changing it rewrites history others may have.", pushed.join(", ")) : undefined;
        if (action === "undo") {
          if (!(await this.host.ask.warning(localize("Undo commit {0} in {1}?", short(commit.sha), repo.name),
            [localize("The branch steps back one commit; its changes stay staged."), warning].filter(Boolean).join("\n\n"), localize("Undo Commit")))) return undefined;
          await git(commitCommands.undo(commit.sha));
          return localize("Undid {0} in {1}; its changes are staged.", short(commit.sha), repo.name);
        }
        const message = await this.host.run(repo.root, ["show", "-s", "--format=%B", commit.sha, "--"], WRITE_SIGNAL);
        const subject = await this.host.ask.input(localize("New subject for {0} (the body is kept)", short(commit.sha)), localize("Commit subject"),
          { value: commit.subject, validate: (v) => (v.trim() ? undefined : localize("Enter a subject.")) });
        if (!subject?.trim() || subject.trim() === commit.subject) return undefined;
        if (warning && !(await this.host.ask.warning(localize("Edit the message of {0} in {1}?", short(commit.sha), repo.name), warning, localize("Edit Message")))) return undefined;
        await this.host.run(repo.root, commitCommands.reword(), WRITE_SIGNAL, { env: WRITE_ENV, input: rewordMessage(message, subject) });
        return localize("Edited the message of {0} in {1}.", short(commit.sha), repo.name);
      }
      case "newTag": {
        const taken = parseRefNames(await this.host.run(repo.root, ["for-each-ref", "--format=%(refname:short)", "refs/tags"], WRITE_SIGNAL));
        const name = await this.askName(localize("New tag at {0}", short(commit.sha)), localize("Tag name"), taken, "tag");
        if (!name) return undefined;
        await git(commitCommands.newTag(commit.sha, name));
        return localize("Created tag {0} at {1} in {2}.", name, short(commit.sha), repo.name);
      }
    }
  }

  private async askName(prompt: string, placeHolder: string, taken: readonly string[], kind: "branch" | "tag"): Promise<string | undefined> {
    const answer = await this.host.ask.input(prompt, placeHolder, { validate: (v) => {
      const problem = newRefProblem(v, taken, kind);
      return problem ? localize(problem) : undefined;
    } });
    if (answer === undefined || newRefProblem(answer, taken, kind)) return undefined;
    return answer.trim();
  }

  /** The checked-out branch's name, or HEAD when it is detached. */
  private async currentBranch(repo: Repo): Promise<string> {
    const name = await this.host.run(repo.root, ["branch", "--show-current"], WRITE_SIGNAL).catch(() => "");
    return name.trim() || "HEAD";
  }

  /** An empty cherry-pick or revert leaves itself in progress; there is nothing to apply, so skip it. */
  private async skip(repo: Repo, action: CommitAction): Promise<void> {
    await this.host.run(repo.root, [action === "revert" ? "revert" : "cherry-pick", "--skip"], WRITE_SIGNAL, { env: WRITE_ENV }).catch(() => undefined);
  }
}

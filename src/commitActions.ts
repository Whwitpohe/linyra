import * as path from "path";
import * as vscode from "vscode";
import { copyText } from "./clipboard";
import { commitCommands, newRefProblem, parseRefNames, rewordMessage, stoppedReason, type CommitAction, type ResetMode } from "./commitActionModel";
import { localize } from "./i18n";
import type { RunGit } from "./logQuery";
import type { RepoDiscovery } from "./repoDiscovery";
import type { Commit, Repo } from "./types";
import type { Ask } from "./uncommittedActions";
import { compareWithWorkingTree } from "./workingTreeDiff";

/** A write must finish once started: a cherry-pick killed halfway leaves the working tree mid-change. */
const WRITE_SIGNAL = new AbortController().signal;
/** Writes may take the index lock; git's words stay English for stoppedReason; never an editor. */
const WRITE_ENV = { GIT_OPTIONAL_LOCKS: "1", LC_ALL: "C", GIT_EDITOR: "true" };

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const short = (sha: string) => sha.slice(0, 7);
const plural = (n: number, one: string, many = `${one}s`) => localize("{0} {1}", n, localize(n === 1 ? one : many));

/** What the commit actions need from the Log. */
export interface CommitActionHost {
  /** The listed commit a right-click was on, and its repository. */
  commit(arg: unknown): { repo: Repo; commit: Commit } | undefined;
  /** The commits selected together in the Log (Ctrl/Shift-click), in Log order: newest first. */
  selection?(): { repo: Repo; commit: Commit }[];
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
    // Right-click inside a selection of several: cherry-pick or revert all of them, as the JetBrains Log does.
    if (action === "cherryPick" || action === "revert") {
      const many = this.host.selection?.() ?? [];
      if (many.length > 1 && many.some((x) => x.repo.id === repo.id && x.commit.sha === commit.sha)) return this.runMany(action, many);
    }
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

  /**
   * Several commits, repository by repository: cherry-picks oldest first (each lands on the one
   * before it), reverts newest first. A repository stops at its first conflict; the others go on.
   */
  private async runMany(action: "cherryPick" | "revert", selected: readonly { repo: Repo; commit: Pick<Commit, "sha" | "parents"> }[]): Promise<void> {
    const byRepo = new Map<string, { repo: Repo; commits: Pick<Commit, "sha" | "parents">[] }>();
    for (const { repo, commit } of selected) (byRepo.get(repo.id) ?? byRepo.set(repo.id, { repo, commits: [] }).get(repo.id)!).commits.push(commit);
    const done: string[] = [], stopped: string[] = [];
    for (const { repo, commits } of byRepo.values()) {
      if (this.busy.has(repo.id)) { stopped.push(`${repo.name} (${localize("busy")})`); continue; }
      this.busy.add(repo.id);
      const ordered = action === "cherryPick" ? [...commits].reverse() : commits;
      let applied = 0;
      try {
        for (const c of ordered) {
          await this.host.run(repo.root, action === "cherryPick" ? commitCommands.cherryPick(c.sha, c.parents.length > 1) : commitCommands.revert(c.sha, c.parents.length > 1), WRITE_SIGNAL, { env: WRITE_ENV });
          applied++;
        }
        done.push(`${repo.name} (${applied})`);
      } catch (e) {
        const reason = stoppedReason(action, messageOf(e));
        if (reason && /already on the checked-out branch/.test(reason)) await this.skip(repo, action);
        stopped.push(`${repo.name} (${localize("{0} of {1} done", applied, ordered.length)}: ${reason ? localize(reason) : messageOf(e)})`);
      } finally {
        try {
          await this.host.discovery.branchRepository(repo.root)?.status?.();
          await this.host.changed(repo.id);
        } finally {
          this.busy.delete(repo.id);
        }
      }
    }
    const what = localize(action === "cherryPick" ? "Cherry-picked {0} commits" : "Reverted {0} commits", selected.length);
    if (stopped.length) void vscode.window.showWarningMessage(`${what}: ${[...done, ...stopped].join(", ")}`);
    else vscode.window.setStatusBarMessage(`${what}: ${done.join(", ")}`, 8000);
  }

  /** Compare's Cherry-Pick: commits of one repository (newest first, as listed) onto its checked-out branch, oldest first. */
  cherryPickCommits(repo: Repo, commits: readonly Pick<Commit, "sha" | "parents">[]): Promise<void> {
    return this.runMany("cherryPick", commits.map((commit) => ({ repo, commit })));
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
      case "pushUpTo": {
        // The JetBrains Log's Push All up to Here: the checked-out branch's commits up to this one, not the ones after it.
        const branch = await this.currentBranch(repo);
        if (branch === "HEAD") throw new Error(localize("HEAD is detached in {0}: there is no branch to push.", repo.name));
        if (!(await this.succeeds(repo, ["merge-base", "--is-ancestor", commit.sha, "HEAD"]))) throw new Error(localize("{0} is not on {1}, the checked-out branch.", short(commit.sha), branch));
        const remote = (await this.config(repo, `branch.${branch}.remote`)) ?? (await this.pickRemote(repo));
        if (!remote) return undefined;
        const merge = await this.config(repo, `branch.${branch}.merge`);
        const target = merge?.startsWith("refs/heads/") ? merge.slice("refs/heads/".length) : branch;
        const tracking = `refs/remotes/${remote}/${target}`;
        const known = await this.succeeds(repo, ["rev-parse", "--verify", "--quiet", tracking]);
        const count = (sinceArgs: string[]) => this.host.run(repo.root, ["rev-list", "--count", ...sinceArgs], WRITE_SIGNAL).then((n) => Number(n.trim()) || 0);
        const outgoing = await count([commit.sha, ...(known ? [`^${tracking}`] : ["--not", `--remotes=${remote}`])]);
        if (outgoing === 0) {
          void vscode.window.showInformationMessage(localize("{0} is already on {1}.", short(commit.sha), `${remote}/${target}`));
          return undefined;
        }
        const after = await count([`${commit.sha}..HEAD`]);
        if (!(await this.host.ask.warning(localize("Push {0} of {1} up to {2} to {3}?", plural(outgoing, "commit"), branch, short(commit.sha), `${remote}/${target}`),
          after > 0 ? localize("{0} after it stay local.", plural(after, "commit")) : "", localize("Push")))) return undefined;
        const refspec = `${commit.sha}:refs/heads/${target}`;
        if (native?.push) await native.push(remote, refspec, false);
        else await this.host.run(repo.root, ["push", "--", remote, refspec], WRITE_SIGNAL, { env: WRITE_ENV, tree: true });
        return localize("Pushed {0} up to {1} to {2}.", branch, short(commit.sha), `${remote}/${target}`);
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

  /** Compare with Working Tree (the JetBrains Log's Compare with Local): the files that differ from the commit, one as a diff. */
  async compareLocal(arg: unknown): Promise<void> {
    const found = this.host.commit(arg);
    if (found) await compareWithWorkingTree(this.host.run, this.host.ask, found.repo, found.commit.sha, short(found.commit.sha), WRITE_SIGNAL);
  }

  /**
   * Create Patch…: the commit, or the commits selected with it (one repository), oldest first, as
   * git format-patch writes them; saved to a file or copied. A merge commit has no patch of its own.
   */
  async createPatch(arg: unknown): Promise<void> {
    const found = this.host.commit(arg);
    if (!found) return;
    const many = this.host.selection?.() ?? [];
    const picked = many.length > 1 && many.some((x) => x.repo.id === found.repo.id && x.commit.sha === found.commit.sha) ? many : [found];
    if (new Set(picked.map((x) => x.repo.id)).size > 1) {
      void vscode.window.showInformationMessage(localize("A patch takes the commits of one repository: select commits of one repository only."));
      return;
    }
    const { repo } = found;
    const commits = picked.map((x) => x.commit).reverse().filter((c) => c.parents.length < 2);
    if (commits.length === 0) {
      void vscode.window.showInformationMessage(localize("A merge commit has no patch of its own."));
      return;
    }
    const patch = (await Promise.all(commits.map((c) => this.host.run(repo.root, ["format-patch", "--stdout", "-1", c.sha, "--"], WRITE_SIGNAL)))).join("");
    const what = commits.length === 1 ? short(commits[0].sha) : localize("{0} in {1}", plural(commits.length, "commit"), repo.name);
    const items = [{ label: localize("Save to File…") }, { label: localize("Copy to Clipboard") }];
    const i = await this.host.ask.pick(items, localize("Create a patch of {0}", what));
    if (i === 1) {
      await copyText(patch);
      vscode.window.setStatusBarMessage(localize("Copied the patch of {0}.", what), 5000);
    } else if (i === 0) {
      const name = commits.length === 1 ? `${repo.name}-${short(commits[0].sha)}.patch` : `${repo.name}-${short(commits[0].sha)}..${short(commits[commits.length - 1].sha)}.patch`;
      const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(repo.root, name)), filters: { [localize("Patch")]: ["patch", "diff"] }, title: localize("Create a patch of {0}", what) });
      if (!uri) return;
      await vscode.workspace.fs.writeFile(uri, Buffer.from(patch, "utf8"));
      vscode.window.setStatusBarMessage(localize("Saved the patch of {0} to {1}.", what, path.basename(uri.fsPath)), 5000);
    }
  }

  private succeeds(repo: Repo, args: string[]): Promise<boolean> {
    return this.host.run(repo.root, args, WRITE_SIGNAL).then(() => true, () => false);
  }

  private async config(repo: Repo, key: string): Promise<string | undefined> {
    const value = await this.host.run(repo.root, ["config", "--get", key], WRITE_SIGNAL).catch(() => "");
    return value.trim() || undefined;
  }

  /** No upstream: the only remote, or the one picked. */
  private async pickRemote(repo: Repo): Promise<string | undefined> {
    const remotes = (await this.host.run(repo.root, ["remote"], WRITE_SIGNAL)).split("\n").map((r) => r.trim()).filter(Boolean);
    if (remotes.length === 0) throw new Error(localize("{0} has no remote to push to.", repo.name));
    if (remotes.length === 1) return remotes[0];
    const i = await this.host.ask.pick(remotes.map((label) => ({ label })), localize("Remote to push to"));
    return i === undefined ? undefined : remotes[i];
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

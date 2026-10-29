import * as path from "path";
import * as vscode from "vscode";
import { copyText } from "./clipboard";
import { Limiter } from "./allFiles";
import { branchArgs, branchCommands, branchKey, branchRevision, DEFAULT_BRANCH_SIDEBAR, newBranchProblem, parseBranches, sidebarState, type Branch, type Branches, type BranchSidebarState } from "./branchModel";
import { errorLine } from "./git";
import { parseShow } from "./commitDetail";
import { localize } from "./i18n";
import type { RunGit } from "./logQuery";
import type { HostMessage, WebviewMessage } from "./protocol";
import type { RepoDiscovery } from "./repoDiscovery";
import { encodeRevision, SCHEME } from "./revisionUri";
import type { Repo } from "./types";
import type { Ask } from "./uncommittedActions";
import { isStashRef, parseStashes, stashCommands, stashListArgs, stashStopped, type Stash } from "./stashModel";
import { compareWithWorkingTree } from "./workingTreeDiff";
import { guardCheckout } from "./smartCheckout";
import { readWorktrees } from "./repoHead";
import { folderName, hasLocalChanges, worktreeCommands } from "./worktreeModel";
import { droppedArgs, forcePushPrompt, isProtected, parseDropped } from "./multiRepoModel";
import { gitText, whyOf } from "./actionErrors";
import { branchDone, branchFailed, deleteAnywayPrompt, deletePrompt, distanceArgs, integratePrompt, parseDistance, stashFailed, unmergedArgs } from "./branchPrompts";

const STATE = "linyra.branchSidebar";
const WRITE_SIGNAL = new AbortController().signal;
export type StashAction = "show" | "apply" | "pop" | "drop";
export type BranchAction = "view" | "copy" | "favorite" | "compare" | "worktreeDiff" | "checkout" | "create" | "rename" | "delete" | "fetch" | "pull" | "push" | "merge" | "rebase" | "worktree" | "pullMerge" | "pullRebase" | "upstream";
type SidebarPost = Extract<HostMessage, { type: "sidebarState" | "branchTree" }>;
interface Deps {
  repos(): readonly Repo[];
  run: RunGit;
  discovery: RepoDiscovery;
  ask: Ask;
  post(message: SidebarPost): void;
  view(repoId: string, branch: string): Promise<void>;
  compare(repoId: string, branch: string, current: string): Promise<void>;
  changed(repoId: string): Promise<void>;
  concurrency(): number;
  /** Stash Changes…'s ✨: AI writes the message into Linyra's own box (with its Include new files switch). */
  stashWriter?(): StashWriter | undefined;
}

/** Writes a stash message for a repository's uncommitted work (new files too when untracked), streaming it through onText. */
export interface StashWriter {
  write(repo: Repo, untracked: boolean, signal: AbortSignal, onText: (text: string) => void): Promise<string | undefined>;
}

/** Stash Changes…'s Include new files, as last chosen. */
const STASH_UNTRACKED = "linyra.stash.untracked";

/** Branch metadata is read on expansion; writes happen only through explicit commands. */
export class BranchController implements vscode.Disposable {
  private state: BranchSidebarState;
  private readonly shown = new Map<string, Branches>();
  private readonly reading = new Map<string, Promise<Branches | undefined>>();
  private readonly busy = new Set<string>();
  private readonly ctl = new AbortController();
  private readonly limiter: Limiter;
  /** Integration-only answer for the native folder picker. */
  worktreePath: string | undefined;

  constructor(private readonly context: vscode.ExtensionContext, private readonly deps: Deps) {
    this.state = sidebarState(context.workspaceState.get(STATE, DEFAULT_BRANCH_SIDEBAR));
    // A few repositories at a time: Refresh reloads every expanded repository's branches beside the
    // Log's own reads, and starting git processes, not running them, is what they would compete for.
    this.limiter = new Limiter(Math.max(1, Math.min(4, deps.concurrency())));
  }

  ready(): void {
    this.deps.post({ type: "sidebarState", state: this.state });
    for (const [repoId, data] of this.shown) this.deps.post({ type: "branchTree", repoId, data });
  }

  snapshot(): { state: BranchSidebarState; repos: Record<string, Branches> } {
    return { state: this.state, repos: Object.fromEntries(this.shown) };
  }

  private async save(next: BranchSidebarState): Promise<void> {
    this.state = sidebarState(next);
    await this.context.workspaceState.update(STATE, this.state);
    this.deps.post({ type: "sidebarState", state: this.state });
  }

  async handle(m: Extract<WebviewMessage, { type: "branchSidebar" }>): Promise<void> {
    if (m.action === "state") { await this.save(sidebarState(m.state)); return; }
    if (m.action === "refresh") { await this.refresh(m.repoId); return; }
    if (typeof m.repoId !== "string") return;
    if (m.action === "load") { await this.load(m.repoId); return; }
    if (m.action === "stashShow") { await this.stash("show", m); return; }
    if (m.action === "select" || m.action === "favorite") await this.action(m.action === "select" ? "view" : "favorite", m);
  }

  async load(repoId: string): Promise<Branches | undefined> {
    const repo = this.deps.repos().find((r) => r.id === repoId);
    if (!repo || this.ctl.signal.aborted) return;
    const inFlight = this.reading.get(repoId);
    if (inFlight) return inFlight;
    this.deps.post({ type: "branchTree", repoId, loading: true });
    const read = this.limiter.run(repoId, async () => {
      // A git process costs more than its work: one listing (refs/stash says whether there are
      // stashes), remote names from VS Code's Git when it watches the repository, and the stash
      // list only where there is one.
      const known = this.deps.discovery.remotes(repo.root);
      const [output, remoteList, worktrees] = await Promise.all([
        this.deps.run(repo.root, [...branchArgs(), "refs/stash"], this.ctl.signal),
        known ? Promise.resolve(known.join("\n")) : this.deps.run(repo.root, ["remote"], this.ctl.signal),
        // Its worktrees: the git dir's files, no process.
        readWorktrees(repo.root).catch(() => []),
      ]);
      const data = parseBranches(output, remoteList.split(/\r?\n/).filter(Boolean));
      const hasStash = output.split("\n").some((line) => line.startsWith("refs/stash\0"));
      data.stashes = hasStash ? parseStashes(await this.deps.run(repo.root, stashListArgs(), this.ctl.signal).catch(() => "")) : [];
      if (worktrees.length > 0) data.worktrees = worktrees;
      if (this.ctl.signal.aborted) return;
      this.shown.set(repoId, data);
      this.deps.post({ type: "branchTree", repoId, data });
      return data;
    }).catch((e: unknown) => {
      if (!this.ctl.signal.aborted) this.deps.post({ type: "branchTree", repoId, error: e instanceof Error ? e.message : String(e) });
      return undefined;
    }).finally(() => this.reading.delete(repoId));
    this.reading.set(repoId, read);
    return read;
  }

  /**
   * A checkout. When git refuses it because local changes would be overwritten, Smart Checkout is
   * offered: stash them, check out, put them back. false: declined (nothing changed).
   */
  private smart(repo: Repo, target: string, run: (args: string[]) => Promise<string>, checkout: () => Promise<unknown>): Promise<boolean> {
    return guardCheckout(repo.name, target, run, checkout, (p) => this.deps.ask.warning(p.message, p.detail, p.button), (report) => {
      if (report) void vscode.window.showWarningMessage(report);
      else vscode.window.setStatusBarMessage(localize("Linyra: checked out {0} in {1} and put your changes back.", target, repo.name), 8000);
    });
  }

  async refresh(repoId?: string): Promise<void> {
    const ids = repoId ? [repoId] : [...this.shown.keys()];
    await Promise.all(ids.filter((id) => this.shown.has(id)).map(async (id) => { await this.reading.get(id); await this.load(id); }));
  }

  async action(action: BranchAction, arg: unknown): Promise<void> {
    const a = arg as { repoId?: unknown; ref?: unknown } | undefined;
    const repo = this.deps.repos().find((r) => r.id === a?.repoId);
    if (!repo || typeof a?.ref !== "string") return;
    if (this.busy.has(repo.id)) { void vscode.window.showInformationMessage(localize("A Git operation is already running in {0}.", repo.name)); return; }
    const writes = !["view", "copy", "favorite", "compare", "worktreeDiff"].includes(action);
    if (writes) this.busy.add(repo.id);
    // The branch's name for the error, and the status-bar line once it worked.
    let label = a.ref.replace(/^refs\/(heads|remotes|tags)\//, "");
    let done: string | undefined;
    try {
      const data = await this.load(repo.id);
      const branch = data?.branches.find((b) => b.ref === a.ref);
      if (!data || !branch) return;
      const b = branch;
      label = b.name;
      // git's own words in English: a checkout refused for local changes is recognized whatever the system's language.
      const run = (args: string[]) => this.deps.run(repo.root, args, WRITE_SIGNAL, { env: { GIT_OPTIONAL_LOCKS: "1", LC_ALL: "C" } });
      const native = this.deps.discovery.branchRepository(repo.root);
      const current = data.current ?? "HEAD";
      const name = async (prompt: string, initial = "", except?: string) => {
        const answer = await this.deps.ask.input(prompt, localize("Branch name"), { value: initial, validate: (v) => {
          const problem = newBranchProblem(v, data.branches, except);
          return problem ? localize(problem) : undefined;
        } });
        if (answer === undefined || newBranchProblem(answer, data.branches, except)) return;
        await this.deps.run(repo.root, ["check-ref-format", "--branch", answer.trim()], this.ctl.signal);
        return answer.trim();
      };
      const ensureCurrent = async () => {
        if (!data.current) throw new Error(localize("Check out a local branch first."));
        const latest = await this.deps.run(repo.root, ["symbolic-ref", "--short", "HEAD"], this.ctl.signal);
        if (latest.trim() !== data.current) throw new Error(localize("The current branch changed. Run the action again."));
      };
      const integrate = async (method: "merge" | "rebase") => {
        await ensureCurrent();
        if (native?.[method]) await native[method]!(b.ref);
        else await run(branchCommands[method](b));
      };
      switch (action) {
        case "view": await this.deps.view(repo.id, branchRevision(b, data)); return;
        case "copy": await copyText(b.name); return;
        case "favorite": {
          const key = branchKey(repo.id, b.ref), favorites = new Set(this.state.favorites);
          if (favorites.has(key)) favorites.delete(key); else favorites.add(key);
          await this.save({ ...this.state, favorites: [...favorites] }); return;
        }
        case "compare": await this.deps.compare(repo.id, branchRevision(b, data), current); return;
        case "worktreeDiff": await this.diffWorkingTree(repo, b); return;
        case "upstream": {
          if (b.kind !== "local") return;
          // The remote branches it can track (from the listing already read: no git), and Stop Tracking when it tracks one.
          const remotes = data.branches.filter((x) => x.kind === "remote" && x.remoteBranch !== "HEAD");
          const items: vscode.QuickPickItem[] = [
            ...remotes.map((x) => ({ label: x.name, description: x.name === b.upstream ? localize("current upstream") : undefined })),
            ...(b.upstream ? [{ label: localize("Stop Tracking"), description: localize("{0} pulls and pushes nowhere until it tracks a branch again", b.name) }] : []),
          ];
          if (items.length === 0) throw new Error(localize("{0} has no remote branches yet: fetch, or publish the branch.", repo.name));
          const i = await this.deps.ask.pick(items, localize("The remote branch {0} pulls from and pushes to", b.name));
          if (i === undefined || remotes[i]?.name === b.upstream) return;
          if (i >= remotes.length) await run(branchCommands.unsetUpstream(b));
          else if (native?.setBranchUpstream) await native.setBranchUpstream(b.name, remotes[i].ref);
          else await run(branchCommands.setUpstream(b, remotes[i].ref));
          break;
        }
        case "checkout": {
          if (b.current) return;
          // Refused for local changes: offered as a Smart Checkout (stash, check out, put back).
          const guard = (target: string, checkout: () => Promise<unknown>) => this.smart(repo, target, run, checkout);
          if (b.kind === "tag") {
            // A tag is not a branch: its commit is checked out with HEAD detached, as the JetBrains Log does.
            if (!(await this.deps.ask.warning(localize("Check out tag {0} in {1}?", b.name, repo.name),
              localize("HEAD is detached there: new commits belong to no branch until you create one."), localize("Check Out")))) return;
            if (!(await guard(b.name, () => (native?.checkout ? native.checkout(b.sha) : run(branchCommands.checkoutTag(b)))))) return;
            done = branchDone("checkout", { name: b.name, repo: repo.name });
            break;
          }
          let local = b.name;
          if (b.kind === "remote") {
            // The same name as on the remote, as git switch does; New Branch from Here… is there for another name.
            local = b.remoteBranch ?? b.name;
            const existing = data.branches.find((x) => x.kind === "local" && x.name === local);
            if (existing) {
              if (existing.upstream !== b.name) throw new Error(localize("{0} already exists here and tracks {1}: New Branch from Here… on {2} checks it out under another name", local, existing.upstream || localize("no remote branch"), b.name));
              if (!(await guard(local, () => (native?.checkout ? native.checkout(local) : run(branchCommands.checkout(existing)))))) return;
            } else {
              if (newBranchProblem(local, data.branches)) throw new Error(localize("Enter a valid branch name."));
              await this.deps.run(repo.root, ["check-ref-format", "--branch", local], this.ctl.signal);
              if (!(await guard(local, async () => {
                if (native?.createBranch) { await native.createBranch(local, true, b.ref); await native.setBranchUpstream?.(local, b.ref); }
                else await run(branchCommands.track(b, local));
              }))) return;
            }
          } else if (!(await guard(local, () => (native?.checkout ? native.checkout(local) : run(branchCommands.checkout(b)))))) return;
          done = branchDone("checkout", { name: local, repo: repo.name });
          await this.deps.view(repo.id, local); break;
        }
        case "create": {
          const next = await name(localize("Create and check out a branch from {0}", b.name));
          if (!next) return;
          // It checks the new branch out: Smart Checkout when local changes are in the way, as every checkout.
          if (!(await this.smart(repo, next, run, () => (native?.createBranch ? native.createBranch(next, true, b.ref) : run(branchCommands.create(b, next)))))) return;
          done = branchDone("create", { name: b.name, to: next, repo: repo.name });
          await this.deps.view(repo.id, next); break;
        }
        case "rename": {
          if (b.kind !== "local") return;
          const next = await name(localize("Rename branch {0}", b.name), b.name, b.name);
          if (!next || next === b.name) return;
          await run(branchCommands.rename(b, next));
          done = branchDone("rename", { name: b.name, to: next, repo: repo.name });
          await this.deps.view(repo.id, next); break;
        }
        case "delete": {
          if (b.current) throw new Error(localize("The current branch cannot be deleted."));
          if (b.kind === "tag") {
            if (!(await this.deps.ask.warning(localize("Delete tag {0} in {1}?", b.name, repo.name), localize("Only the local tag is deleted; a pushed copy stays on its remote."), localize("Delete")))) return;
            await run(branchCommands.deleteTag(b));
            done = branchDone("delete", { name: b.name, repo: repo.name });
            break;
          }
          const p = deletePrompt({ name: b.name, kind: b.kind, upstream: b.upstream, remote: b.remote, remoteBranch: b.remoteBranch }, repo.name);
          if (!(await this.deps.ask.warning(p.message, p.detail, p.button))) return;
          if (b.kind === "remote") {
            if (!b.remote || !b.remoteBranch) return;
            if (native?.push) await native.push(b.remote, `:refs/heads/${b.remoteBranch}`);
            else await run(["push", "--delete", "--", b.remote, b.remoteBranch]);
          } else if (!(await this.deleteLocal(repo, b, b.upstream || current, run))) return;
          done = branchDone("delete", { name: b.name, repo: repo.name });
          break;
        }
        case "fetch": {
          if (native?.fetch) await native.fetch(b.remote); else await run(["fetch", ...(b.remote ? ["--", b.remote] : [])]);
          done = branchDone("fetch", { name: b.remote ?? b.name, repo: repo.name });
          break;
        }
        case "pull": {
          if (!b.current) throw new Error(localize("Only the checked-out branch can be pulled."));
          await ensureCurrent();
          if (native?.pull) await native.pull(); else await run(["pull", "--ff-only"]);
          done = branchDone("pull", { name: b.name, repo: repo.name });
          break;
        }
        case "push": {
          if (b.kind === "tag") {
            const index = await this.deps.ask.pick(data.remotes.map((label) => ({ label })), localize("Remote to push tag {0} to", b.name));
            if (index === undefined || index < 0 || !data.remotes[index]) return;
            await run(["push", "--", data.remotes[index], `${b.ref}:${b.ref}`]);
            done = branchDone("push", { name: b.name, to: data.remotes[index], repo: repo.name });
            break;
          }
          if (b.kind !== "local") return;
          const upstreamRemote = data.remotes.find((r) => b.upstream?.startsWith(`${r}/`));
          const index = upstreamRemote ? data.remotes.indexOf(upstreamRemote) : await this.deps.ask.pick(data.remotes.map((label) => ({ label })), localize("Remote to push to"));
          if (index === undefined || index < 0 || !data.remotes[index]) return;
          const remote = data.remotes[index];
          const destination = upstreamRemote ? b.upstream!.slice(remote.length + 1) : b.name;
          const refspec = `${b.ref}:refs/heads/${destination}`;
          // Diverged from its upstream: a plain push is rejected. Usually someone else pushed (a pull keeps
          // their commits); after an amend, undo or rebase of pushed commits, a force push is what is meant.
          // The question names the commits the remote loses and whose they are; never a protected branch.
          const lease = upstreamRemote && b.ahead > 0 && b.behind > 0 ? data.branches.find((x) => x.kind === "remote" && x.name === b.upstream)?.sha : undefined;
          if (lease) {
            const guarded = vscode.workspace.getConfiguration("git", vscode.Uri.file(repo.root)).get<string[]>("branchProtection", []);
            if (isProtected(destination, Array.isArray(guarded) ? guarded : [])) {
              throw new Error(localize("{0} diverged from {1}/{2}: a protected branch is never force pushed; pull it first", b.name, remote, destination));
            }
            const [log, me] = await Promise.all([run(droppedArgs(b.name, `${remote}/${destination}`)).catch(() => ""), run(["config", "user.email"]).catch(() => "")]);
            const p = forcePushPrompt([{ repo: repo.name, branch: b.name, target: `${remote}/${destination}`, behind: b.behind, dropped: parseDropped(log), me: me.trim() }]);
            if (!(await this.deps.ask.warning(p.message, p.detail, p.button))) return;
            await run(["push", `--force-with-lease=refs/heads/${destination}:${lease}`, "--", remote, refspec]);
            done = branchDone("push", { name: b.name, to: `${remote}/${destination}`, repo: repo.name });
            break;
          }
          if (native?.push) await native.push(remote, refspec, true); else await run(["push", "--set-upstream", "--", remote, refspec]);
          done = branchDone("push", { name: b.name, to: `${remote}/${destination}`, repo: repo.name });
          break;
        }
        case "merge": case "rebase": case "pullMerge": case "pullRebase": {
          if (b.current) return;
          const method = action === "rebase" || action === "pullRebase" ? "rebase" : "merge";
          // Pull into Current: the remote branch fetched first, so the question counts what is there now.
          if (action === "pullMerge" || action === "pullRebase") {
            if (!b.remote || !b.remoteBranch) return;
            await ensureCurrent();
            const refspec = `refs/heads/${b.remoteBranch}:${b.ref}`;
            if (native?.fetch) await native.fetch(b.remote, refspec); else await run(["fetch", "--", b.remote, refspec]);
          }
          // What moves, in counts, and the button says the action.
          const p = integratePrompt(method, current, b.name, repo.name, parseDistance(await run(distanceArgs(b.ref)).catch(() => "")));
          if ("nothing" in p) { void vscode.window.showInformationMessage(p.nothing); return; }
          if (!(await this.deps.ask.warning(p.message, p.detail, p.button))) return;
          await integrate(method);
          done = branchDone(action, { name: b.name, current, repo: repo.name });
          break;
        }
        case "worktree": {
          const next = await name(localize("New branch for the worktree based on {0}", b.name));
          if (!next) return;
          const folder = process.env.LINYRA_ITEST === "1" && this.worktreePath ? vscode.Uri.file(this.worktreePath)
            : await vscode.window.showSaveDialog({ title: localize("Folder for the new worktree"), saveLabel: localize("Create Worktree"),
              defaultUri: vscode.Uri.file(path.join(path.dirname(repo.root), `${path.basename(repo.root)}-${next.replace(/\//g, "-")}`)) });
          if (!folder || folder.scheme !== "file") return;
          if (native?.createWorktree) await native.createWorktree({ path: folder.fsPath, branch: next, commitish: b.ref });
          else await run(branchCommands.worktree(b, next, folder.fsPath));
          void vscode.window.showInformationMessage(localize("Worktree created at {0}.", folder.fsPath)); break;
        }
      }
      if (done) vscode.window.setStatusBarMessage(done, 8000);
    } catch (e) {
      this.lastError = branchFailed(action, label, repo.name, whyOf(e));
      void vscode.window.showErrorMessage(this.lastError);
    } finally {
      if (writes) {
        try { await this.deps.discovery.branchRepository(repo.root)?.status?.(); await this.deps.changed(repo.id); await this.refresh(repo.id); }
        catch (e) { void vscode.window.showErrorMessage(localize("Linyra could not read {0} again: {1}", repo.name, e instanceof Error ? e.message : String(e))); }
        finally { this.busy.delete(repo.id); }
      }
    }
  }

  /** The last error a branch or stash action showed (integration test seam). */
  lastError: string | undefined;

  /**
   * Delete a local branch. git refuses one that is not merged (the normal case after a squash
   * merge): asked once more, with how many of its commits are on nothing else, then `git branch -D`.
   * false: declined.
   */
  private async deleteLocal(repo: Repo, b: Branch, into: string, run: (args: string[]) => Promise<string>): Promise<boolean> {
    const native = this.deps.discovery.branchRepository(repo.root);
    try {
      if (native?.deleteBranch) await native.deleteBranch(b.name, false); else await run(branchCommands.delete(b));
      return true;
    } catch (e) {
      if (!/not fully merged/i.test(gitText(e)) && (e as { gitErrorCode?: unknown }).gitErrorCode !== "BranchNotFullyMerged") throw e;
    }
    const unmerged = Number((await run(unmergedArgs(b.name)).catch(() => "")).trim()) || 0;
    const p = deleteAnywayPrompt(b.name, into, repo.name, unmerged);
    if (!(await this.deps.ask.warning(p.message, p.detail, p.button))) return false;
    if (native?.deleteBranch) await native.deleteBranch(b.name, true); else await run(branchCommands.forceDelete(b));
    return true;
  }

  /**
   * A worktree row: Open in New Window, Reveal in the file explorer, Copy Path, or Remove (asks; a
   * worktree with local changes asks again before --force; one whose folder is gone is pruned).
   * The worktree is found again in a fresh read, so a list that moved meanwhile is not acted on blind.
   */
  async worktree(action: "open" | "reveal" | "copyPath" | "remove", arg: unknown): Promise<void> {
    const a = arg as { repoId?: unknown; path?: unknown } | undefined;
    const repo = this.deps.repos().find((r) => r.id === a?.repoId);
    if (!repo || typeof a?.path !== "string") return;
    const w = (await readWorktrees(repo.root)).find((x) => x.path === a.path);
    if (!w) return;
    const uri = vscode.Uri.file(w.path);
    if (action === "open") { await vscode.commands.executeCommand("vscode.openFolder", uri, { forceNewWindow: true }); return; }
    if (action === "reveal") { await vscode.commands.executeCommand("revealFileInOS", uri); return; }
    if (action === "copyPath") { await copyText(w.path); return; }
    if (w.main) return;
    if (this.busy.has(repo.id)) { void vscode.window.showInformationMessage(localize("A Git operation is already running in {0}.", repo.name)); return; }
    this.busy.add(repo.id);
    const git = (args: string[]) => this.deps.run(repo.root, args, WRITE_SIGNAL, { env: { GIT_OPTIONAL_LOCKS: "1", LC_ALL: "C" } });
    try {
      const name = folderName(w.path);
      if (w.missing) {
        if (!(await this.deps.ask.warning(localize("Forget worktree {0} of {1}?", name, repo.name), localize("Its folder {0} is gone. git worktree prune forgets it, and any other worktree of {1} whose folder is gone; their branches stay.", w.path, repo.name), localize("Forget")))) return;
        await git(worktreeCommands.prune());
        return;
      }
      if (!(await this.deps.ask.warning(localize("Remove worktree {0} of {1}?", name, repo.name),
        localize("Its folder {0} is deleted. Its branch {1} stays.", w.path, w.branch ?? w.detached ?? "HEAD"), localize("Remove")))) return;
      try {
        await git(worktreeCommands.remove(w.path, false));
      } catch (e) {
        const stderr = (e as { stderr?: unknown } | undefined)?.stderr;
        if (!hasLocalChanges(typeof stderr === "string" ? stderr : String(e))) throw e;
        if (!(await this.deps.ask.warning(localize("Worktree {0} has changes that are not committed.", name),
          localize("Remove it anyway? Its uncommitted changes and untracked files are lost."), localize("Remove Anyway")))) return;
        await git(worktreeCommands.remove(w.path, true));
      }
    } catch (e) {
      const stderr = (e as { stderr?: unknown } | undefined)?.stderr;
      void vscode.window.showErrorMessage(localize("Linyra could not remove the worktree in {0}: {1}", repo.name, typeof stderr === "string" && stderr.trim() ? errorLine(stderr) : e instanceof Error ? e.message : String(e)));
    } finally {
      try { await this.refresh(repo.id); } finally { this.busy.delete(repo.id); }
    }
  }

  /**
   * A stash row: Show its changes, Apply or Pop it (keeping its staged state), or Drop it (asks).
   * The stash is found again by its ref in a fresh listing, so a list that moved meanwhile is not
   * acted on blind.
   */
  async stash(action: StashAction, arg: unknown): Promise<void> {
    const a = arg as { repoId?: unknown; ref?: unknown } | undefined;
    const repo = this.deps.repos().find((r) => r.id === a?.repoId);
    if (!repo || !isStashRef(a?.ref)) return;
    if (action !== "show" && this.busy.has(repo.id)) { void vscode.window.showInformationMessage(localize("A Git operation is already running in {0}.", repo.name)); return; }
    const data = await this.load(repo.id);
    const s = data?.stashes?.find((x) => x.ref === a.ref);
    if (!s) return;
    if (action === "show") { await this.showStash(repo, s); return; }
    this.busy.add(repo.id);
    try {
      if (action === "drop" && !(await this.deps.ask.warning(localize("Drop stash {0} in {1}?", s.ref, repo.name), s.subject, localize("Drop")))) return;
      await this.deps.run(repo.root, stashCommands[action](s.ref), WRITE_SIGNAL, { env: { GIT_OPTIONAL_LOCKS: "1", LC_ALL: "C" } });
    } catch (e) {
      const message = gitText(e);
      const reason = stashStopped(message);
      this.lastError = stashFailed(action, s.ref, repo.name, reason ? localize(reason) : whyOf(e));
      void vscode.window.showErrorMessage(this.lastError);
    } finally {
      try { await this.deps.discovery.branchRepository(repo.root)?.status?.(); await this.deps.changed(repo.id); await this.refresh(repo.id); }
      finally { this.busy.delete(repo.id); }
    }
  }

  /**
   * Stash Changes… on a repository: one box, the message and an "Include new files" switch in its
   * title (remembered). ✨ writes the message with AI where it is set up. `preset`: both already
   * chosen and confirmed (Ask AI), so nothing is asked.
   */
  async stashCreate(arg: unknown, preset?: { message: string; untracked: boolean }): Promise<void> {
    const id = (arg as { repoId?: unknown } | undefined)?.repoId;
    const repo = this.deps.repos().find((r) => r.id === id);
    if (!repo || this.busy.has(repo.id)) return;
    const answer = preset ? { message: preset.message, untracked: preset.untracked } : await this.stashBox(repo);
    if (!answer || !answer.message.trim()) return;
    if (!preset) await this.context.globalState.update(STASH_UNTRACKED, answer.untracked);
    this.busy.add(repo.id);
    try {
      await this.deps.run(repo.root, stashCommands.push(answer.message, answer.untracked), WRITE_SIGNAL, { env: { GIT_OPTIONAL_LOCKS: "1", LC_ALL: "C" } });
      vscode.window.setStatusBarMessage(localize(answer.untracked ? "Linyra: stashed the changes in {0}, new files included." : "Linyra: stashed the changes in {0}.", repo.name), 8000);
    } catch (e) {
      this.lastError = stashFailed("push", "", repo.name, whyOf(e));
      void vscode.window.showErrorMessage(this.lastError);
    } finally {
      try { await this.deps.discovery.branchRepository(repo.root)?.status?.(); await this.deps.changed(repo.id); await this.refresh(repo.id); }
      finally { this.busy.delete(repo.id); }
    }
  }

  /** Stash Changes…'s one box: the message, the Include new files switch (last choice), and ✨ when AI can write it. */
  private async stashBox(repo: Repo): Promise<{ message: string; untracked: boolean } | undefined> {
    const writer = this.deps.stashWriter?.();
    const r = await this.deps.ask.inputWithToggle({
      title: localize("Stash Changes in {0}", repo.name),
      prompt: (on) => localize(on ? "Stashes every change, new files included. Enter to stash." : "Stashes the changes to tracked files; new files stay. Enter to stash."),
      placeHolder: localize("Stash message"), value: "WIP",
      toggle: { on: this.context.globalState.get<boolean>(STASH_UNTRACKED, false), icon: (on) => (on ? "files" : "file"),
        tooltip: (on) => localize(on ? "Include new files: on (click to leave them out)" : "Include new files: off (click to include them)") },
      extra: writer ? { icon: "sparkle", tooltip: localize("Write the stash message with AI"), run: async (box, on) => {
        const ctl = new AbortController();
        const before = box.value;
        box.busy = true;
        box.validationMessage = undefined;
        try { box.value = (await writer.write(repo, on, ctl.signal, (text) => { box.value = text; })) ?? before; }
        // The writer's errors already say "Linyra AI: …" in the user's words.
        catch (e) { box.value = before; box.validationMessage = e instanceof Error ? e.message : String(e); }
        finally { box.busy = false; }
      } } : undefined,
    });
    return r ? { message: r.value, untracked: r.on } : undefined;
  }

  /** Show Stash Changes…: pick one of its files, opened as a diff of the stash's base against it. */
  private async showStash(repo: Repo, s: Stash): Promise<void> {
    const files = parseShow(await this.deps.run(repo.root, stashCommands.files(s.sha), this.ctl.signal)).files;
    if (files.length === 0) { void vscode.window.showInformationMessage(localize("Stash {0} has no changes to show.", s.ref)); return; }
    const index = await this.deps.ask.pick(files.map((file) => ({ label: file.path, description: file.status })), localize("File to compare in {0}", s.ref));
    if (index === undefined) return;
    const file = files[index];
    const base = (await this.deps.run(repo.root, ["rev-parse", "--verify", `${s.sha}^1`], this.ctl.signal)).trim();
    const uri = (ref: string | null, at: string) => vscode.Uri.from({ scheme: SCHEME, ...encodeRevision({ root: repo.root, ref, path: at }) });
    const before = uri(file.status === "A" ? null : base, file.oldPath ?? file.path);
    const after = uri(file.status === "D" ? null : s.sha, file.path);
    await vscode.commands.executeCommand("vscode.diff", before, after, localize("{0} ({1}) — {2}", path.posix.basename(file.path), s.ref, repo.name), { preview: true });
  }

  private diffWorkingTree(repo: Repo, branch: Branch): Promise<void> {
    return compareWithWorkingTree(this.deps.run, this.deps.ask, repo, branch.sha, branch.name, this.ctl.signal);
  }

  dispose(): void { this.ctl.abort(); }
}

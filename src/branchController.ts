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

const STATE = "linyra.branchSidebar";
const WRITE_SIGNAL = new AbortController().signal;
export type StashAction = "show" | "apply" | "pop" | "drop";
export type BranchAction = "view" | "copy" | "favorite" | "compare" | "worktreeDiff" | "checkout" | "create" | "rename" | "delete" | "fetch" | "pull" | "push" | "merge" | "rebase" | "worktree" | "pullMerge" | "pullRebase";
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
  /** Stash Changes…'s message box when AI can write it (a ✨ button); else VS Code's plain input box. */
  stashInput?(repo: Repo, untracked: boolean, prompt: string, placeHolder: string, value: string): Promise<string | undefined>;
}

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
      const [output, remoteList] = await Promise.all([
        this.deps.run(repo.root, [...branchArgs(), "refs/stash"], this.ctl.signal),
        known ? Promise.resolve(known.join("\n")) : this.deps.run(repo.root, ["remote"], this.ctl.signal),
      ]);
      const data = parseBranches(output, remoteList.split(/\r?\n/).filter(Boolean));
      const hasStash = output.split("\n").some((line) => line.startsWith("refs/stash\0"));
      data.stashes = hasStash ? parseStashes(await this.deps.run(repo.root, stashListArgs(), this.ctl.signal).catch(() => "")) : [];
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
    try {
      const data = await this.load(repo.id);
      const branch = data?.branches.find((b) => b.ref === a.ref);
      if (!data || !branch) return;
      const b = branch;
      const run = (args: string[]) => this.deps.run(repo.root, args, WRITE_SIGNAL, { env: { GIT_OPTIONAL_LOCKS: "1" } });
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
        case "checkout": {
          if (b.current) return;
          if (b.kind === "tag") {
            // A tag is not a branch: its commit is checked out with HEAD detached, as the JetBrains Log does.
            if (!(await this.deps.ask.warning(localize("Check out tag {0} in {1}?", b.name, repo.name),
              localize("HEAD is detached there: new commits belong to no branch until you create one."), localize("Check Out")))) return;
            if (native?.checkout) await native.checkout(b.sha); else await run(branchCommands.checkoutTag(b));
            break;
          }
          let local = b.name;
          if (b.kind === "remote") {
            local = (await this.deps.ask.input(localize("Local branch to track {0}", b.name), localize("Branch name"), { value: b.remoteBranch ?? b.name,
              validate: (v) => {
                const existing = data.branches.find((x) => x.kind === "local" && x.name === v.trim());
                const problem = newBranchProblem(v, data.branches);
                return existing?.upstream === b.name ? undefined : problem ? localize(problem) : undefined;
              } }))?.trim() ?? "";
            if (!local) return;
            const existing = data.branches.find((x) => x.kind === "local" && x.name === local);
            if (existing) {
              if (existing.upstream !== b.name) throw new Error(localize("A local branch with this name already exists."));
              if (native?.checkout) await native.checkout(local); else await run(branchCommands.checkout(existing));
            } else {
              if (newBranchProblem(local, data.branches)) throw new Error(localize("Enter a valid branch name."));
              await this.deps.run(repo.root, ["check-ref-format", "--branch", local], this.ctl.signal);
              if (native?.createBranch) { await native.createBranch(local, true, b.ref); await native.setBranchUpstream?.(local, b.ref); }
              else await run(branchCommands.track(b, local));
            }
          } else if (native?.checkout) await native.checkout(local);
          else await run(branchCommands.checkout(b));
          await this.deps.view(repo.id, local); break;
        }
        case "create": {
          const next = await name(localize("Create and check out a branch from {0}", b.name));
          if (!next) return;
          if (native?.createBranch) await native.createBranch(next, true, b.ref); else await run(branchCommands.create(b, next));
          await this.deps.view(repo.id, next); break;
        }
        case "rename": {
          if (b.kind !== "local") return;
          const next = await name(localize("Rename branch {0}", b.name), b.name, b.name);
          if (!next || next === b.name) return;
          await run(branchCommands.rename(b, next));
          await this.deps.view(repo.id, next); break;
        }
        case "delete": {
          if (b.current) throw new Error(localize("The current branch cannot be deleted."));
          if (b.kind === "tag") {
            if (!(await this.deps.ask.warning(localize("Delete tag {0} in {1}?", b.name, repo.name), localize("Only the local tag is deleted; a pushed copy stays on its remote."), localize("Delete")))) return;
            await run(branchCommands.deleteTag(b));
            break;
          }
          if (!(await this.deps.ask.warning(localize("Delete branch {0} in {1}?", b.name, repo.name),
            localize(b.kind === "remote" ? "This deletes the branch on the remote server." : "Only a merged local branch can be deleted here."), localize("Delete")))) return;
          if (b.kind === "remote") {
            if (!b.remote || !b.remoteBranch) return;
            if (native?.push) await native.push(b.remote, `:refs/heads/${b.remoteBranch}`);
            else await run(["push", "--delete", "--", b.remote, b.remoteBranch]);
          } else if (native?.deleteBranch) await native.deleteBranch(b.name, false); else await run(branchCommands.delete(b));
          break;
        }
        case "fetch": if (native?.fetch) await native.fetch(b.remote); else await run(["fetch", ...(b.remote ? ["--", b.remote] : [])]); break;
        case "pull": {
          if (!b.current) throw new Error(localize("Only the checked-out branch can be pulled."));
          await ensureCurrent();
          if (native?.pull) await native.pull(); else await run(["pull", "--ff-only"]);
          break;
        }
        case "push": {
          if (b.kind === "tag") {
            const index = await this.deps.ask.pick(data.remotes.map((label) => ({ label })), localize("Remote to push tag {0} to", b.name));
            if (index === undefined || index < 0 || !data.remotes[index]) return;
            await run(["push", "--", data.remotes[index], `${b.ref}:${b.ref}`]);
            break;
          }
          if (b.kind !== "local") return;
          const upstreamRemote = data.remotes.find((r) => b.upstream?.startsWith(`${r}/`));
          const index = upstreamRemote ? data.remotes.indexOf(upstreamRemote) : await this.deps.ask.pick(data.remotes.map((label) => ({ label })), localize("Remote to push to"));
          if (index === undefined || index < 0 || !data.remotes[index]) return;
          const remote = data.remotes[index];
          const destination = upstreamRemote ? b.upstream!.slice(remote.length + 1) : b.name;
          const refspec = `${b.ref}:refs/heads/${destination}`;
          if (native?.push) await native.push(remote, refspec, true); else await run(["push", "--set-upstream", "--", remote, refspec]);
          break;
        }
        case "merge": case "rebase": case "pullMerge": case "pullRebase": {
          if (b.current) return;
          const method = action === "rebase" || action === "pullRebase" ? "rebase" : "merge";
          if (!(await this.deps.ask.warning(localize(method === "merge" ? "Merge {0} into {1} in {2}?" : "Rebase {1} onto {0} in {2}?", b.name, current, repo.name),
            localize("The checked-out branch is {0}.", current), localize("Continue")))) return;
          if (action === "pullMerge" || action === "pullRebase") {
            if (!b.remote || !b.remoteBranch) return;
            await ensureCurrent();
            const refspec = `refs/heads/${b.remoteBranch}:${b.ref}`;
            if (native?.fetch) await native.fetch(b.remote, refspec); else await run(["fetch", "--", b.remote, refspec]);
          }
          await integrate(method); break;
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
    } catch (e) {
      const stderr = (e as { stderr?: unknown } | undefined)?.stderr;
      void vscode.window.showErrorMessage(localize("Branch action failed in {0}: {1}", repo.name, typeof stderr === "string" && stderr.trim() ? errorLine(stderr) : e instanceof Error ? e.message : String(e)));
    } finally {
      if (writes) {
        try { await this.deps.discovery.branchRepository(repo.root)?.status?.(); await this.deps.changed(repo.id); await this.refresh(repo.id); }
        catch (e) { void vscode.window.showErrorMessage(localize("Branch action failed in {0}: {1}", repo.name, e instanceof Error ? e.message : String(e))); }
        finally { this.busy.delete(repo.id); }
      }
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
      const message = e instanceof Error ? e.message : String(e);
      const reason = stashStopped(message);
      void vscode.window.showErrorMessage(localize("Stash action failed in {0}: {1}", repo.name, reason ? localize(reason) : message));
    } finally {
      try { await this.deps.discovery.branchRepository(repo.root)?.status?.(); await this.deps.changed(repo.id); await this.refresh(repo.id); }
      finally { this.busy.delete(repo.id); }
    }
  }

  /**
   * Stash Changes… on a repository: its uncommitted work under a message, untracked files if asked.
   * `preset`: both already chosen and confirmed (Ask AI), so nothing is asked.
   */
  async stashCreate(arg: unknown, preset?: { message: string; untracked: boolean }): Promise<void> {
    const id = (arg as { repoId?: unknown } | undefined)?.repoId;
    const repo = this.deps.repos().find((r) => r.id === id);
    if (!repo || this.busy.has(repo.id)) return;
    const choice = preset ? (preset.untracked ? 1 : 0) : await this.deps.ask.pick([{ label: localize("Stash tracked changes") }, { label: localize("Stash including untracked files") }], localize("Stash changes in {0}", repo.name));
    if (choice === undefined) return;
    const message = preset?.message ?? await (this.deps.stashInput
      ? this.deps.stashInput(repo, choice === 1, localize("Message for the stash in {0}", repo.name), localize("Stash message"), "WIP")
      : this.deps.ask.input(localize("Message for the stash in {0}", repo.name), localize("Stash message"), { value: "WIP" }));
    if (message === undefined || !message.trim()) return;
    this.busy.add(repo.id);
    try {
      await this.deps.run(repo.root, stashCommands.push(message, choice === 1), WRITE_SIGNAL, { env: { GIT_OPTIONAL_LOCKS: "1", LC_ALL: "C" } });
    } catch (e) {
      void vscode.window.showErrorMessage(localize("Stash action failed in {0}: {1}", repo.name, e instanceof Error ? e.message : String(e)));
    } finally {
      try { await this.deps.discovery.branchRepository(repo.root)?.status?.(); await this.deps.changed(repo.id); await this.refresh(repo.id); }
      finally { this.busy.delete(repo.id); }
    }
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

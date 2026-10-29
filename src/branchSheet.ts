import * as path from "path";
import * as vscode from "vscode";
import { debounce } from "./debounce";
import { acrossRow, parseSheetRef, sheetRefArgs, type AcrossRow, type BranchSheetData, type SheetAction } from "./branchSheetModel";
import { Limiter } from "./allFiles";
import { countArgs, parseCounts, pickMergeTarget, remoteHeadArgs, shortRemoteRef, showsMergeTarget } from "./hoverModel";
import type { RunGit } from "./logQuery";
import { conflictCount } from "./mergeCheck";
import { isAbortError } from "./pool";
import type { HostMessage } from "./protocol";
import type { Repo } from "./types";
import type { MessageRoutes } from "./messageRoutes";

export interface BranchSheetHost {
  repos(): readonly Repo[];
  run: RunGit;
  post(m: HostMessage): void;
  /** Linyra AI is on (its Explain commands are registered). */
  ai(): boolean;
  /** The repository's checked-out branch (Review of a remote branch compares against it). */
  currentBranch(repoId: string): string | undefined;
  /** Compare Branches with ◀ left and ▶ right in this repository. */
  compare(repoId: string, left: string, right: string): unknown;
  /** Runs a command (the Repo List's branch commands, Linyra AI's). */
  execute(command: string, arg: unknown): PromiseLike<unknown>;
  /** The ticked repositories (Across repositories reads each). */
  ticked(): readonly Repo[];
  /** How many git processes at once (linyra.maxConcurrency). */
  concurrency(): number;
}

const samePath = (a: string, b: string) => {
  const norm = (p: string) => (process.platform === "win32" || process.platform === "darwin" ? path.resolve(p).toLowerCase() : path.resolve(p));
  return norm(a) === norm(b);
};
const REF = /^refs\/(heads|remotes|tags)\/[^\s\0~^:?*[\\]+$/;

/**
 * A branch pill's sheet: what the branch is (its tip, upstream and merge target, with a merge
 * check when it is behind) and what to do next, each a command Linyra already has. Read when it
 * opens and after each of its actions (at most four git processes); a new open aborts the last read.
 */
export class BranchSheet implements vscode.Disposable {
  private ctl = new AbortController();
  private shown: { repoId: string; ref: string } | undefined;
  /** The last data sent, and the last Across repositories read (integration test seams). */
  last: BranchSheetData | undefined;
  lastAcross: AcrossRow[] | undefined;
  /** Branch events and the sheet's own actions come in bursts: one read again for all of them. */
  private readonly reopenSoon = debounce(() => { if (this.shown) void this.open(this.shown.repoId, this.shown.ref); }, 250);

  constructor(private readonly host: BranchSheetHost) {}

  /** Opens (or reads again) the sheet of `ref` in the repository. */
  async open(repoId: unknown, ref: unknown): Promise<void> {
    const repo = this.host.repos().find((r) => r.id === repoId);
    if (!repo || typeof ref !== "string" || !REF.test(ref) || ref.includes("..")) return;
    this.ctl.abort();
    const ctl = this.ctl = new AbortController();
    this.shown = { repoId: repo.id, ref };
    try {
      const data = await this.read(repo, ref, ctl.signal);
      if (ctl.signal.aborted) return;
      this.last = data;
      this.host.post(data ? { type: "branchSheet", repoId: repo.id, ref, data } : { type: "branchSheet", repoId: repo.id, ref, missing: true });
    } catch (e) {
      if (!isAbortError(e) && !ctl.signal.aborted) this.host.post({ type: "branchSheet", repoId: repo.id, ref, error: e instanceof Error ? e.message : String(e) });
    }
  }

  close(): void {
    this.ctl.abort();
    this.reopenSoon.cancel();
    this.shown = undefined;
  }

  /** Branches moved (an action of the sheet's, a fetch, a checkout): the open sheet is read again. */
  refsChanged(repoId: string | undefined): void {
    if (this.shown && (repoId === undefined || repoId === this.shown.repoId)) this.reopenSoon();
  }

  private async read(repo: Repo, ref: string, signal: AbortSignal): Promise<BranchSheetData | undefined> {
    const r = parseSheetRef(await this.host.run(repo.root, sheetRefArgs(ref), signal), ref);
    if (!r) return undefined;
    const data: BranchSheetData = {
      repoId: repo.id, repoName: repo.name, ref, name: r.name, kind: r.kind, current: r.current,
      tip: { sha: r.sha, subject: r.subject, author: r.author, time: r.time }, ai: this.host.ai(),
      ...(r.worktree && !samePath(r.worktree, repo.root) ? { worktree: r.worktree } : {}),
    };
    if (r.kind !== "local") return data;
    data.upstream = { name: r.upstream, ref: r.upstreamRef, ahead: r.ahead, behind: r.behind, gone: r.gone };
    // Where it merges: the upstream remote's default branch (the hover card's rule), unless it is that branch.
    const target = pickMergeTarget(await this.host.run(repo.root, remoteHeadArgs(r.name), signal), r.name);
    if (!target) return data;
    const counts = parseCounts(await this.host.run(repo.root, countArgs(r.sha, target), signal));
    if (!counts || !showsMergeTarget({ name: shortRemoteRef(target), branch: r.name, ...counts })) return data;
    data.target = { name: shortRemoteRef(target), ...counts };
    // Behind with commits of its own: would bringing the target in conflict? Checked in memory.
    if (counts.ahead > 0 && counts.behind > 0) data.target.conflicts = await conflictCount(this.host.run, repo.root, r.sha, target, signal);
    return data;
  }

  /**
   * Across repositories: the same ref in every ticked repository, one for-each-ref each, a few at a
   * time. Read when its button asks, never on its own: 68 repositories are 68 git processes.
   */
  private async across(d: BranchSheetData): Promise<void> {
    const ctl = this.ctl;
    const limiter = new Limiter(Math.max(1, Math.min(8, this.host.concurrency())));
    const rows = await Promise.all(this.host.ticked().map((repo) => limiter.run(repo.id, async () =>
      // A repository that cannot be read counts as not having it (its row says "Not in").
      acrossRow(repo, parseSheetRef(await this.host.run(repo.root, sheetRefArgs(d.ref), ctl.signal).catch(() => ""), d.ref)))));
    if (ctl.signal.aborted || this.shown?.repoId !== d.repoId || this.shown.ref !== d.ref) return;
    this.lastAcross = rows;
    this.host.post({ type: "branchSheet", repoId: d.repoId, ref: d.ref, across: rows });
  }

  register(routes: MessageRoutes): void {
    routes.on("branchSheet", async (m) => {
      if (m.action === "open") await this.open(m.repoId, m.ref);
      else if (m.action === "close") this.close();
      else await this.action(m.action, m.repoId, m.ref);
    });
    // A new webview shows no sheet: nothing is read for one nobody sees.
    routes.onReady({ before: () => this.close() });
  }

  /** A button of the sheet: the existing command for it, then the sheet read again. */
  async action(action: unknown, repoId: unknown, ref: unknown): Promise<void> {
    const d = this.last;
    if (!d || d.repoId !== repoId || d.ref !== ref) return;
    const arg = { repoId: d.repoId, ref: d.ref };
    const run = (command: string, a: unknown = arg) => this.host.execute(command, a);
    switch (action as SheetAction | "copy") {
      case "copy": await run("linyra.branch.copy"); return;
      case "fetch": await run("linyra.branch.fetch"); break;
      case "pull": await run("linyra.branch.pull"); break;
      case "push": case "forcePush": case "publish": case "pushTag": await run("linyra.branch.push"); break;
      case "switch": await run("linyra.branch.checkout"); break;
      case "createBranch": await run("linyra.branch.create"); break;
      case "setUpstream": await run("linyra.branch.upstream"); break;
      case "history": await run("linyra.branch.view"); return;
      case "compareWith": await run("linyra.compareWith", { name: d.name }); return;
      case "across": await this.across(d); return;
      // Across repositories' actions: the commands that already work across them (each asks first).
      case "acrossCheckout": await run("linyra.branchesAcross", { name: d.name }); break;
      case "pushAll": await run("linyra.pushAll", undefined); break;
      case "updateProject": await run("linyra.updateProject", undefined); break;
      case "delete": await run("linyra.branch.delete"); break;
      // Bring the merge target into the checked-out branch: the Repo List's Merge and Rebase, asked first.
      case "merge": case "rebase": if (d.target) await run(`linyra.branch.${action as string}`, { repoId: d.repoId, ref: `refs/remotes/${d.target.name}` }); break;
      case "review": {
        const right = d.kind === "local" ? d.target?.name : this.host.currentBranch(d.repoId);
        if (right) await this.host.compare(d.repoId, d.name, right);
        return;
      }
      case "openWorktree": if (d.worktree) await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(d.worktree), { forceNewWindow: true }); return;
      case "explain": await run(d.current ? "linyra.ai.explainUnpushed" : "linyra.ai.explainBranch", { webviewSection: "refPill", repoId: d.repoId, ref: d.ref, kind: d.kind, current: d.current }); return;
      default: return;
    }
    // Branches may have moved: the sheet shows where they are now (one read with the branch events the action set off).
    if (this.shown?.repoId === d.repoId && this.shown.ref === d.ref) this.reopenSoon();
  }

  dispose(): void {
    this.ctl.abort();
    this.reopenSoon.cancel();
  }
}

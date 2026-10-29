// The AI features' commands: each reads what it needs from git (read-only, a few processes, all
// cancellable), builds its prompt with the pure modules beside this one, and shows the answer in a
// preview or writes it back where it was asked for. Writes to a repository only after a modal
// confirmation that says what will be done.
import { promises as fs } from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { BranchController } from "../../branchController";
import { copyText } from "../../clipboard";
import type { CommitPlan } from "../../commitModel";
import { selectionIds } from "../../compareModel";
import type { CompareStore } from "../../compareStore";
import type { MergePreviewDocs } from "../../compareView";
import { isValidRef } from "../../filterModel";
import { localize } from "../../i18n";
import type { LogView } from "../../logView";
import { isAbortError, runPool } from "../../pool";
import type { Repo } from "../../types";
import type { Ask } from "../../uncommittedActions";
import type { RepoWork } from "../../uncommittedModel";
import type { UncommittedStore } from "../../uncommittedStore";
import { aiService } from "../index";
import { AiError, type AiService } from "../types";
import { cleanCommitMessage, cleanStashMessage, commitMessageRequest, stashMessageRequest, type CommitRepoInput } from "./commitMessage";
import { conflictTooLarge, explainConflictsRequest, mergeRequest, parseMerge, resolveReport, reviewStep, type PredictedConflict, type ReviewChoice, type ReviewItem } from "./conflicts";
import { budgetDiffs, LIMITS, newFileDiff, splitPatch, type FileDiff, type Limits } from "./context";
import { explainCommitsRequest, explainRangeRequest, explainWorkRequest, type CommitInput, type RangeInput } from "./explain";
import {
  blobArgs, commitPatchArgs, commitsLogArgs, mergeBaseArgs, operationOf, parseCommitPatch, parseNames, parseRangeLog, RANGE_MAX, rangeLogArgs, rangeOk,
  rangePatchArgs, recentSubjectsArgs, shortPaths, stageArgs, unmergedArgs, wipPatchArgs, type Operation,
} from "./gitText";
import { fallbackNotes, notesRequest, parseNotes, renderNotes, type NotesSection } from "./releaseNotes";
import { fileLink, parseReview, renderReview, reviewRequest, type ReviewInput } from "./review";
import { parseSearchAnswer, searchRequest } from "./translateSearch";

/** Explain and Review take this many commits at most (the prompt's budget is shared between them). */
const MAX_COMMITS = 20;
/** New files are read this far (newFileDiff cuts them shorter). */
const NEW_FILE_BYTES = 64 * 1024;
const NEW_FILES = 50;
const READ_CONCURRENCY = 4;

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isCancel = (e: unknown) => (e instanceof AiError && e.kind === "cancelled") || isAbortError(e);
const short = (sha: string) => sha.slice(0, 7);
/** Today as the user's calendar has it. */
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
/** Each of `n` parts gets its share of the prompt's diff budget. */
const share = (limits: Limits, n: number): Limits => ({ ...limits, totalChars: Math.floor(limits.totalChars / Math.max(1, n)) });
/** "refs/heads/x", "refs/remotes/origin/x", "refs/tags/v1" as people say them. */
const refLabel = (ref: string) => ref.replace(/^refs\/(heads|remotes|tags)\//, "");

/** The AI service, when the build has one (registered at activation). */
export function aiIfAny(): AiService | undefined {
  try {
    return aiService();
  } catch {
    return undefined;
  }
}

export interface AiFeatureDeps {
  context: vscode.ExtensionContext;
  log: Pick<LogView, "repoList" | "tickedRepos" | "countedRun" | "contextCommit" | "contextRepo" | "selectedCommits" | "searchNames" | "upstream">;
  uncommitted: Pick<UncommittedStore, "works" | "get" | "readRepo">;
  compare: Pick<CompareStore, "pair" | "results" | "readCommits">;
  /** Compare's picked row (a repository, several, or All). */
  compareSelection(): string | undefined;
  branches: Pick<BranchController, "stashCreate">;
  mergeDocs: Pick<MergePreviewDocs, "put">;
  ask: Ask;
  /** A right-click's commit as the commit actions take it ({ repoId, sha }), from the Log, the Changes view or Compare. */
  commitArg(arg: unknown): unknown;
  /** The commit the Changes view shows, when the command comes with none (Command Palette). */
  shownCommit(): { repoId: string; sha: string } | undefined;
  /** A Compare right-click: its repository, and the file when on one. */
  compareTarget(arg: unknown): { repoId?: string; path?: string };
}

type Target = { repo: Repo; sha: string };

export class AiFeatures {
  constructor(private readonly deps: AiFeatureDeps) {}

  private get language(): string {
    return vscode.env.language;
  }

  private run(root: string, args: string[], signal: AbortSignal): Promise<string> {
    return this.deps.log.countedRun(root, args, signal);
  }

  /** AI configured (or configured now): the service; undefined when the user backed out or the build has none. */
  async ready(): Promise<AiService | undefined> {
    const ai = aiIfAny();
    if (!ai) {
      void vscode.window.showErrorMessage(localize("Linyra AI is not available in this build."));
      return undefined;
    }
    try {
      return (await ai.ensureReady()) ? ai : undefined;
    } catch (e) {
      this.fail(e);
      return undefined;
    }
  }

  /** An error as the user reads it: AiError's own words, nothing for a cancel. */
  fail(e: unknown): void {
    if (isCancel(e)) return;
    const text = messageOf(e).trim();
    void vscode.window.showErrorMessage(localize("Linyra AI: {0}", /[.!?…:]$/.test(text) ? text : `${text}.`));
  }

  /** A streamed answer in the editor area; `write` appends. */
  async present(ai: AiService, title: string, run: (write: (markdown: string) => void, signal: AbortSignal) => Promise<void>): Promise<void> {
    try {
      await ai.present(title, run);
    } catch (e) {
      this.fail(e);
    }
  }

  private repo(id: unknown): Repo | undefined {
    return typeof id === "string" ? this.deps.log.repoList.find((r) => r.id === id) : undefined;
  }

  // ---- 1. AI Search ----------------------------------------------------------------------------

  /** linyra.ai.translateSearch(text): the search box's operator syntax for a question in plain words. */
  async translateSearch(text: unknown): Promise<string | undefined> {
    if (typeof text !== "string" || !text.trim()) return undefined;
    const ai = await this.ready();
    if (!ai) return undefined;
    const ctl = new AbortController();
    return vscode.window.withProgress({ location: { viewId: "linyra.log" }, title: localize("Turning the question into a search…") }, async () => {
      try {
        const names = await this.deps.log.searchNames();
        const parsed = parseSearchAnswer((await ai.ask(searchRequest(text, { ...names, today: today() }, ctl.signal))).text);
        if (!parsed) {
          void vscode.window.showWarningMessage(localize("Linyra AI could not turn this into a search. Try other words, or the search operators."));
          return undefined;
        }
        if (parsed.note) vscode.window.setStatusBarMessage(localize("AI search: {0}", parsed.note), 8000);
        return parsed.query;
      } catch (e) {
        this.fail(e);
        return undefined;
      }
    });
  }

  // ---- 2. Explain commits ----------------------------------------------------------------------

  /** The commits a command is for: the right-clicked one (all of the selection when it is in it), else the selection, else the one shown. */
  targetCommits(arg: unknown): Target[] {
    const one = arg === undefined ? undefined : this.deps.log.contextCommit(this.deps.commitArg(arg));
    const many = this.deps.log.selectedCommits().map((x) => ({ repo: x.repo, sha: x.commit.sha }));
    if (one) return many.length > 1 && many.some((x) => x.repo.id === one.repo.id && x.sha === one.sha) ? many : [one];
    if (many.length > 0) return many;
    const shown = this.deps.shownCommit();
    const c = shown && this.deps.log.contextCommit(shown);
    return c ? [c] : [];
  }

  private async readCommits(ai: AiService, targets: readonly Target[], signal: AbortSignal): Promise<CommitInput[]> {
    const limits = share(LIMITS, targets.length);
    const settled = await runPool(targets, READ_CONCURRENCY, async (t, s) => {
      const c = parseCommitPatch(await this.run(t.repo.root, commitPatchArgs(t.sha), s));
      return { repo: t.repo.name, sha: t.sha, author: c.author, time: c.time, message: c.message, diffs: budgetDiffs(c.files, (p) => ai.excluded(p), limits) };
    }, signal);
    if (signal.aborted) throw new AiError(localize("Cancelled."), "cancelled");
    const failed = settled.find((s) => s.status === "rejected") as PromiseRejectedResult | undefined;
    if (failed) throw failed.reason;
    return settled.map((s) => (s as PromiseFulfilledResult<CommitInput>).value);
  }

  /** linyra.ai.explainCommit: one commit, or several selected together, explained as one change. */
  explainCommit(arg?: unknown): Promise<void> {
    return this.explainTargets(this.targetCommits(arg));
  }

  async explainTargets(all: readonly Target[]): Promise<void> {
    const targets = all.slice(0, MAX_COMMITS);
    if (targets.length === 0) { void vscode.window.showInformationMessage(localize("Select a commit in the Log first.")); return; }
    const ai = await this.ready();
    if (!ai) return;
    // The Log lists newest first; the story reads oldest first.
    const ordered = [...targets].reverse();
    const title = ordered.length === 1 ? localize("Explain {0} ({1})", short(ordered[0].sha), ordered[0].repo.name) : localize("Explain {0} commits", ordered.length);
    await this.present(ai, title, async (write, signal) => {
      await ai.ask(explainCommitsRequest(await this.readCommits(ai, ordered, signal), this.language, signal, write));
    });
  }

  // ---- 3. Explain uncommitted work -------------------------------------------------------------

  /** The uncommitted work a command is for: the right-clicked repository's, else every ticked repository's that has some. */
  targetWorks(arg: unknown): RepoWork[] {
    const id = (arg as { repoId?: unknown } | undefined)?.repoId;
    const all = this.deps.uncommitted.works().filter((w) => w.staged.length + w.changes.length > 0);
    return typeof id === "string" ? all.filter((w) => w.repoId === id) : all;
  }

  /**
   * One repository's uncommitted work as diffs: tracked files from one git diff against the last
   * commit, new files read from disk (never one the settings exclude). `only`: just those paths.
   */
  private async workDiffs(ai: AiService, w: RepoWork, signal: AbortSignal, only?: readonly string[]): Promise<FileDiff[]> {
    const want = only ? new Set(only) : undefined;
    const tracked = splitPatch(await this.run(w.root, wipPatchArgs(w.head, (only && shortPaths(only)) || []), signal))
      .filter((f) => !want || want.has(f.path) || (f.oldPath !== undefined && want.has(f.oldPath)));
    const news = w.changes.filter((f) => f.untracked && (!want || want.has(f.path))).slice(0, NEW_FILES);
    const read = await Promise.all(news.map(async (f): Promise<FileDiff> => {
      if (ai.excluded(f.path)) return { path: f.path, text: "" };
      try {
        const handle = await fs.open(path.join(w.root, ...f.path.split("/")), "r");
        try {
          const buf = Buffer.alloc(NEW_FILE_BYTES);
          const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
          return newFileDiff(f.path, buf.subarray(0, bytesRead).toString("utf8"));
        } finally {
          await handle.close();
        }
      } catch {
        return newFileDiff(f.path, undefined);
      }
    }));
    return [...tracked, ...read];
  }

  private async readWorks(ai: AiService, works: readonly RepoWork[], signal: AbortSignal): Promise<{ work: RepoWork; diffs: ReturnType<typeof budgetDiffs> }[]> {
    const limits = share(LIMITS, works.length);
    const settled = await runPool(works, READ_CONCURRENCY, async (w, s) => ({ work: w, diffs: budgetDiffs(await this.workDiffs(ai, w, s), (p) => ai.excluded(p), limits) }), signal);
    if (signal.aborted) throw new AiError(localize("Cancelled."), "cancelled");
    return settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
  }

  /** linyra.ai.explainWip: the uncommitted work of the right-clicked repository, or of every ticked one. */
  explainWip(arg?: unknown): Promise<void> {
    return this.explainWorks(this.targetWorks(arg));
  }

  async explainWorks(works: readonly RepoWork[]): Promise<void> {
    if (works.length === 0) { void vscode.window.showInformationMessage(localize("No uncommitted changes to explain.")); return; }
    const ai = await this.ready();
    if (!ai) return;
    const title = works.length === 1 ? localize("Explain Uncommitted Changes ({0})", works[0].name) : localize("Explain Uncommitted Changes ({0} repositories)", works.length);
    await this.present(ai, title, async (write, signal) => {
      const read = await this.readWorks(ai, works, signal);
      await ai.ask(explainWorkRequest(read.map((r) => ({ repo: r.work.name, diffs: r.diffs })), this.language, signal, write));
    });
  }

  // ---- 4, 5. Explain unpushed commits, explain a branch ----------------------------------------

  private async readRange(ai: AiService, repo: Repo, base: string, tip: string, labels: { base: string; tip: string }, limits: Limits, signal: AbortSignal): Promise<RangeInput> {
    const commits = parseRangeLog(await this.run(repo.root, rangeLogArgs(base, tip, RANGE_MAX + 1), signal));
    const patch = commits.length ? await this.run(repo.root, rangePatchArgs(base, tip), signal) : "";
    return { repo: repo.name, base: labels.base, tip: labels.tip, commits: commits.slice(0, RANGE_MAX), more: commits.length > RANGE_MAX, diffs: budgetDiffs(splitPatch(patch), (p) => ai.excluded(p), limits) };
  }

  /** linyra.ai.explainUnpushed: the right-clicked repository's commits not on its upstream; with none, every ticked repository's. */
  async explainUnpushed(arg?: unknown): Promise<void> {
    const sync = this.deps.log.upstream.byRepo();
    const one = this.repo((arg as { repoId?: unknown } | undefined)?.repoId);
    if (one && !sync.has(one.id)) { void vscode.window.showInformationMessage(localize("{0} has no upstream branch: nothing to compare its commits with.", one.name)); return; }
    const repos = (one ? [one] : this.deps.log.tickedRepos()).filter((r) => (sync.get(r.id)?.ahead ?? 0) > 0);
    if (repos.length === 0) { void vscode.window.showInformationMessage(one ? localize("Nothing to push in {0}.", one.name) : localize("No ticked repository has commits to push (as of the last read).")); return; }
    const ai = await this.ready();
    if (!ai) return;
    const title = repos.length === 1 ? localize("Explain Unpushed Commits ({0})", repos[0].name) : localize("Explain Unpushed Commits ({0} repositories)", repos.length);
    await this.present(ai, title, async (write, signal) => {
      const limits = share(LIMITS, repos.length);
      const ranges = await Promise.all(repos.map((r) => this.readRange(ai, r, "@{upstream}", "HEAD", { base: "its upstream", tip: "HEAD" }, limits, signal)));
      await ai.ask(explainRangeRequest("unpushed", ranges, this.language, signal, write));
    });
  }

  /** A branch right-click (a ref pill, a Repo List branch): its repository and ref. */
  private branchTarget(arg: unknown): { repo: Repo; ref: string; current: boolean } | undefined {
    const a = arg as { repoId?: unknown; ref?: unknown; current?: unknown; branchCurrent?: unknown } | undefined;
    const repo = this.repo(a?.repoId);
    const ref = typeof a?.ref === "string" ? a.ref.trim() : "";
    return repo && ref && isValidRef(ref) ? { repo, ref, current: a?.current === true || a?.branchCurrent === true } : undefined;
  }

  /** linyra.ai.explainBranch: what a branch did compared with the current branch (what merging it would bring). */
  async explainBranch(arg?: unknown): Promise<void> {
    const t = this.branchTarget(arg);
    if (!t) { void vscode.window.showInformationMessage(localize("Right-click a branch to explain it.")); return; }
    if (t.current) return this.explainUnpushed({ repoId: t.repo.id });
    const ai = await this.ready();
    if (!ai) return;
    const label = refLabel(t.ref);
    await this.present(ai, localize("Explain {0} against the current branch ({1})", label, t.repo.name), async (write, signal) => {
      const range = await this.readRange(ai, t.repo, "HEAD", t.ref, { base: "the current branch", tip: label }, LIMITS, signal);
      if (range.commits.length === 0) { write(localize("{0} has no commits the current branch does not have.", label)); return; }
      await ai.ask(explainRangeRequest("branch", [range], this.language, signal, write));
    });
  }

  // ---- 6, 7. Commit and stash messages ---------------------------------------------------------

  /**
   * The Commit side bar's ✨: one message for the checked files of every repository, streamed
   * through `progress`. Undefined when AI is not set up, or the user backed out (the box goes back).
   */
  async commitMessage(plan: readonly CommitPlan[], draft: string, progress: (text: string) => void, signal: AbortSignal): Promise<string | undefined> {
    const ai = await this.ready();
    if (!ai || signal.aborted) return undefined;
    try {
      const limits = share(LIMITS, plan.length);
      const settled = await runPool(plan, READ_CONCURRENCY, async (p, s): Promise<CommitRepoInput> => {
        const work = this.deps.uncommitted.get(p.repoId);
        const files = work ? await this.workDiffs(ai, work, s, p.paths) : [];
        const recent = await this.run(p.root, recentSubjectsArgs(), s).then((o) => o.split("\n").map((l) => l.trim()).filter(Boolean), () => []);
        return { repo: p.name, recent, diffs: budgetDiffs(files, (f) => ai.excluded(f), limits) };
      }, signal);
      if (signal.aborted) return undefined;
      const failed = settled.find((s) => s.status === "rejected") as PromiseRejectedResult | undefined;
      if (failed) throw failed.reason;
      const instructions = vscode.workspace.getConfiguration("linyra").get<string>("ai.commitMessageInstructions", "") ?? "";
      let text = "";
      const repos = settled.map((s) => (s as PromiseFulfilledResult<CommitRepoInput>).value);
      const res = await ai.ask(commitMessageRequest({ repos, instructions, draft }, signal, (d) => { text += d; progress(cleanCommitMessage(text, false)); }));
      return cleanCommitMessage(res.text || text) || undefined;
    } catch (e) {
      if (isCancel(e) || signal.aborted) return undefined;
      throw e;
    }
  }

  /**
   * Stash Changes…'s ✨ for a box of its own (src/stashBox.ts): undefined when this build has no AI.
   * write() sets AI up first if it is not (the Linyra AI page), streams the message through onText
   * and resolves to it; undefined when cancelled or not set up; throws an Error the box can show.
   */
  stashWriter(): { write(repo: Repo, untracked: boolean, signal: AbortSignal, onText: (text: string) => void): Promise<string | undefined> } | undefined {
    if (!aiIfAny()) return undefined;
    return {
      write: async (repo, untracked, signal, onText) => {
        const ai = await this.ready();
        return ai && !signal.aborted ? this.writeStash(ai, repo, untracked, signal, onText) : undefined;
      },
    };
  }

  /** A stash message from the repository's uncommitted work (new files only when `untracked`), streamed through onText. */
  private async writeStash(ai: AiService, repo: Repo, untracked: boolean, signal: AbortSignal, onText: (text: string) => void): Promise<string | undefined> {
    try {
      const work = this.deps.uncommitted.get(repo.id);
      const files = work ? await this.workDiffs(ai, untracked ? work : { ...work, changes: work.changes.filter((f) => !f.untracked) }, signal) : [];
      let text = "";
      const res = await ai.ask(stashMessageRequest(repo.name, undefined, budgetDiffs(files, (p) => ai.excluded(p)), signal, (d) => { text += d; onText(cleanStashMessage(text)); }));
      return cleanStashMessage(res.text || text) || undefined;
    } catch (e) {
      if (isCancel(e) || signal.aborted) return undefined;
      throw new Error(localize("Linyra AI: {0}", messageOf(e)));
    }
  }

  /**
   * Stash Changes…'s message box with a ✨ button that writes the message from the repository's
   * uncommitted work. The box is VS Code's own; while the model writes, it shows busy.
   */
  stashInput(repo: Repo, untracked: boolean, prompt: string, placeHolder: string, value: string): Promise<string | undefined> {
    const box = vscode.window.createInputBox();
    box.title = localize("Stash Changes");
    box.prompt = prompt;
    box.placeholder = placeHolder;
    box.value = value;
    box.ignoreFocusOut = true;
    const generate: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("sparkle"), tooltip: localize("Write the stash message with AI") };
    box.buttons = aiIfAny() ? [generate] : [];
    let ctl: AbortController | undefined;
    /** Configure AI… takes the screen for a moment: this box comes back after it. */
    let away = false;
    return new Promise<string | undefined>((resolve) => {
      let done = false;
      const finish = (v: string | undefined) => { if (done) return; done = true; ctl?.abort(); resolve(v); box.dispose(); };
      box.onDidAccept(() => { if (!box.busy) { const v = box.value; box.hide(); finish(v); } });
      box.onDidHide(() => { if (!away) finish(undefined); });
      box.onDidTriggerButton(async (b) => {
        if (b !== generate || box.busy) return;
        const ai = aiIfAny();
        if (!ai) { box.validationMessage = localize("Linyra AI is not available in this build."); return; }
        if (!ai.configured) {
          away = true;
          const ok = await this.ready();
          away = false;
          box.show();
          if (!ok) return;
        }
        ctl = new AbortController();
        box.busy = true;
        box.validationMessage = undefined;
        const before = box.value;
        try {
          box.value = (await this.writeStash(ai, repo, untracked, ctl.signal, (text) => { box.value = text; })) || before;
        } catch (e) {
          box.value = before;
          box.validationMessage = messageOf(e);
        } finally {
          box.busy = false;
        }
      });
      box.show();
    });
  }

  // ---- 8. Changelog and release notes ----------------------------------------------------------

  private async presentNotes(ai: AiService, title: string, read: (signal: AbortSignal) => Promise<NotesSection[]>): Promise<void> {
    // Insert puts the notes where the user was typing before the preview opened (that editor may be behind it now).
    const editor = vscode.window.activeTextEditor;
    const at = editor && editor.document.uri.scheme !== "output" ? { doc: editor.document, pos: editor.selection.active } : undefined;
    let markdown = "";
    await this.present(ai, title, async (write, signal) => {
      const sections = (await read(signal)).filter((s) => s.commits.length > 0);
      if (sections.length === 0) { write(localize("No commits to write release notes for.")); return; }
      const answer = await ai.ask(notesRequest(sections, this.language, signal));
      const notes = parseNotes(answer.text, sections) ?? fallbackNotes(sections);
      markdown = renderNotes(notes, title, { feat: localize("Features"), fix: localize("Fixes"), other: localize("Other changes") });
      write(markdown);
    });
    if (!markdown) return;
    const copy = localize("Copy"), insert = localize("Insert into Editor");
    const choice = await vscode.window.showInformationMessage(localize("Release notes are ready."), copy, ...(at && !at.doc.isClosed ? [insert] : []));
    if (choice === copy) await copyText(markdown);
    else if (choice === insert && at && !at.doc.isClosed) {
      const edit = new vscode.WorkspaceEdit();
      edit.insert(at.doc.uri, at.pos, markdown);
      await vscode.workspace.applyEdit(edit);
    }
  }

  /** linyra.ai.releaseNotes: release notes from the commits selected in the Log (or the right-clicked one). */
  async releaseNotes(arg?: unknown): Promise<void> {
    const targets = this.targetCommits(arg);
    if (targets.length === 0) { void vscode.window.showInformationMessage(localize("Select the commits in the Log first.")); return; }
    const ai = await this.ready();
    if (!ai) return;
    const byRepo = new Map<string, { repo: Repo; shas: string[] }>();
    for (const t of targets) (byRepo.get(t.repo.id) ?? byRepo.set(t.repo.id, { repo: t.repo, shas: [] }).get(t.repo.id)!).shas.push(t.sha);
    await this.presentNotes(ai, localize("Release Notes"), async (signal) => Promise.all([...byRepo.values()].map(async ({ repo, shas }) =>
      ({ repo: repo.name, commits: parseRangeLog(await this.run(repo.root, commitsLogArgs(shas), signal)) }))));
  }

  /** linyra.ai.compareReleaseNotes: Compare's commits only on ◀ (what Copy as Release Notes takes), written up by the model. */
  async compareReleaseNotes(): Promise<void> {
    const pair = this.deps.compare.pair;
    const sel = this.deps.compareSelection();
    const picked = sel === undefined ? "all" : selectionIds(sel);
    const targets = this.deps.compare.results().flatMap(({ repo, result }) =>
      result.kind === "differs" && result.left > 0 && (picked === "all" || picked.includes(repo.id)) ? [{ repo, result }] : []);
    if (!pair || targets.length === 0) { void vscode.window.showInformationMessage(localize("No commit is only on the left side of Compare.")); return; }
    const ai = await this.ready();
    if (!ai) return;
    await this.presentNotes(ai, localize("Release Notes: {0} → {1}", pair.left, pair.right), async () => {
      const settled = await runPool(targets, READ_CONCURRENCY, ({ repo, result }) => this.deps.compare.readCommits(repo.id, "left", result.left + result.sameLeft + 1), new AbortController().signal);
      return targets.map(({ repo, result }, i) => ({
        repo: repo.name, range: `${result.leftName} → ${result.rightName}`,
        commits: settled[i].status === "fulfilled"
          ? (settled[i] as PromiseFulfilledResult<Awaited<ReturnType<CompareStore["readCommits"]>>>).value.filter((c) => c.mark === "+").map((c) => ({ sha: short(c.sha), author: c.author, time: c.time, subject: c.subject, body: "" }))
          : [],
      }));
    });
  }

  // ---- 9. Review -------------------------------------------------------------------------------

  /** linyra.ai.review: a commit (or the selection), a branch against the current one, a repository's uncommitted work, or all of it. */
  async review(arg?: unknown): Promise<void> {
    const branch = this.branchTarget(arg);
    const onCommit = arg !== undefined && !branch && !!this.deps.log.contextCommit(this.deps.commitArg(arg));
    const commits = onCommit ? this.targetCommits(arg).slice(0, MAX_COMMITS) : [];
    const works = !branch && commits.length === 0 ? this.targetWorks(arg) : [];
    if (!branch && commits.length === 0 && works.length === 0) { void vscode.window.showInformationMessage(localize("No changes to review.")); return; }
    const ai = await this.ready();
    if (!ai) return;
    const title = branch ? localize("Review {0} ({1})", refLabel(branch.ref), branch.repo.name)
      : commits.length === 1 ? localize("Review {0} ({1})", short(commits[0].sha), commits[0].repo.name)
      : commits.length > 1 ? localize("Review {0} commits", commits.length)
      : works.length === 1 ? localize("Review Uncommitted Changes ({0})", works[0].name) : localize("Review Uncommitted Changes ({0} repositories)", works.length);
    await this.present(ai, title, async (write, signal) => {
      let inputs: (ReviewInput & { root: string })[];
      if (branch) {
        const [base, tip, what] = branch.current ? ["@{upstream}", "HEAD", "unpushed commits"] : ["HEAD", branch.ref, `${refLabel(branch.ref)} against the current branch`];
        if (!rangeOk(base, tip)) return;
        const patch = await this.run(branch.repo.root, rangePatchArgs(base, tip), signal);
        inputs = [{ repo: branch.repo.name, root: branch.repo.root, what, diffs: budgetDiffs(splitPatch(patch), (p) => ai.excluded(p)) }];
      } else if (commits.length) {
        const read = await this.readCommits(ai, [...commits].reverse(), signal);
        inputs = read.map((c, i) => ({ repo: c.repo, root: [...commits].reverse()[i].repo.root, what: `commit ${short(c.sha)}: ${c.message.split("\n")[0]}`, diffs: c.diffs }));
      } else {
        inputs = (await this.readWorks(ai, works, signal)).map((r) => ({ repo: r.work.name, root: r.work.root, what: "uncommitted changes", diffs: r.diffs }));
      }
      const answer = await ai.ask(reviewRequest(inputs, this.language, signal));
      const files = inputs.map((i) => ({ repo: i.repo, files: i.diffs.sections.map((s) => splitPatch(s)[0]?.path ?? "").filter(Boolean) }));
      const review = parseReview(answer.text, files);
      if (!review) { write(localize("The model's answer was not a review Linyra can read. Try again.")); return; }
      const roots = new Map(inputs.map((i) => [i.repo, i.root]));
      write(renderReview(review, {
        title, noFindings: localize("No problems found in what was sent."),
        severity: { critical: localize("Critical"), high: localize("High"), medium: localize("Medium"), low: localize("Low"), info: localize("Notes") },
      }, (repo, file, line) => { const root = roots.get(repo); return root ? fileLink(root, file, line) : undefined; }));
    });
  }

  // ---- 10. Conflicts ---------------------------------------------------------------------------

  /**
   * linyra.ai.resolveConflicts: every conflicted file of the right-clicked repository (or of every
   * repository with uncommitted work), one at a time: the model's merge beside the file as it is,
   * then one choice: Accept and Stage (write the file, git add), the merge editor, Skip, or Stop.
   * Esc skips the file and the run goes on. The merge, rebase or cherry-pick itself is never continued.
   */
  async resolveConflicts(arg?: unknown): Promise<void> {
    const id = (arg as { repoId?: unknown } | undefined)?.repoId;
    const works = this.deps.uncommitted.works().filter((w) => (typeof id !== "string" || w.repoId === id) && w.changes.length + w.staged.length > 0);
    const ctl = new AbortController();
    const found = (await runPool(works, READ_CONCURRENCY, async (w, s) => ({ work: w, files: parseNames(await this.run(w.root, unmergedArgs(), s)) }), ctl.signal))
      .flatMap((s) => (s.status === "fulfilled" && s.value.files.length ? [s.value] : []));
    if (found.length === 0) { void vscode.window.showInformationMessage(localize("No conflicted files in the ticked repositories.")); return; }
    const ai = await this.ready();
    if (!ai) return;
    const total = found.reduce((n, f) => n + f.files.length, 0);
    const operations: (Operation | undefined)[] = [];
    let accepted = 0, reviewed = 0;
    run: for (const { work, files } of found) {
      const op = await this.operation(work.root);
      operations.push(op);
      const head = (await this.run(work.root, ["symbolic-ref", "--short", "-q", "HEAD"], ctl.signal).catch(() => "")).trim() || "HEAD";
      try {
        for (const file of files) {
          const step = await this.resolveOne(ai, work, file, op, head, { index: reviewed + 1, total });
          reviewed++;
          if (step === "accepted") accepted++;
          if (step === "stop") break run;
        }
      } finally {
        await this.deps.uncommitted.readRepo(work.repoId);
      }
    }
    this.lastConflictReport = resolveReport({ accepted, reviewed, total, operations });
    const scm = localize("Open Source Control");
    void vscode.window.showInformationMessage(this.lastConflictReport, scm).then((c) => (c === scm ? vscode.commands.executeCommand("workbench.view.scm") : undefined));
  }

  /** Test seam: what the last Resolve Conflicts with AI said at its end. */
  lastConflictReport: string | undefined;

  private async operation(root: string): Promise<Operation | undefined> {
    try {
      const gitDir = (await this.run(root, ["rev-parse", "--absolute-git-dir"], new AbortController().signal)).trim();
      const names = await fs.readdir(gitDir);
      return operationOf((n) => names.includes(n));
    } catch {
      return undefined;
    }
  }

  private async openMergeEditor(uri: vscode.Uri): Promise<void> {
    try {
      await vscode.commands.executeCommand("git.openMergeEditor", uri);
    } catch {
      await vscode.commands.executeCommand("vscode.open", uri);
    }
  }

  /**
   * A file's one choice. The list stays open while the diff beside it is read and scrolled; Esc,
   * or closing it, is Skip. The integration suite answers through Ask's queue.
   */
  private chooseFor(step: { title: string; placeHolder: string; items: ReviewItem[] }): Promise<ReviewChoice> {
    if (process.env.LINYRA_ITEST === "1") return this.deps.ask.pick(step.items, step.placeHolder).then((i) => (i === undefined ? "skip" : step.items[i].id));
    return new Promise((resolve) => {
      const qp = vscode.window.createQuickPick<ReviewItem>();
      Object.assign(qp, { title: step.title, placeholder: step.placeHolder, items: step.items, ignoreFocusOut: true });
      let done = false;
      const finish = (choice: ReviewChoice) => {
        if (done) return;
        done = true;
        resolve(choice);
        qp.dispose();
      };
      qp.onDidAccept(() => finish(qp.selectedItems[0]?.id ?? qp.activeItems[0]?.id ?? "skip"));
      qp.onDidHide(() => finish("skip"));
      qp.show();
    });
  }

  /** The proposal's diff, once its file is decided: the next file's opens in its place. */
  private async closeProposal(proposal: vscode.Uri): Promise<void> {
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputTextDiff && t.input.original.toString() === proposal.toString());
    if (tabs.length > 0) await vscode.window.tabGroups.close(tabs);
  }

  private async resolveOne(ai: AiService, work: RepoWork, file: string, op: Operation | undefined, head: string, at: { index: number; total: number }): Promise<"accepted" | "skipped" | "stop"> {
    const uri = vscode.Uri.file(path.join(work.root, ...file.split("/")));
    const decide = async (o: { note?: string; reason?: string }, proposal?: vscode.Uri): Promise<ReviewChoice> => {
      const choice = await this.chooseFor(reviewStep({ repo: work.name, path: file, index: at.index, total: at.total, ...o }));
      if (proposal) await this.closeProposal(proposal);
      if (choice === "editor") await this.openMergeEditor(uri);
      return choice;
    };
    const cannot = async (why: string): Promise<"skipped" | "stop"> => ((await decide({ reason: why })) === "stop" ? "stop" : "skipped");
    if (ai.excluded(file)) return cannot(localize("excluded by linyra.ai.exclude, so it is not sent. Resolve it in the merge editor."));
    let current: string;
    try {
      current = await fs.readFile(uri.fsPath, "utf8");
    } catch {
      return cannot(localize("the file could not be read (deleted on one side?). Resolve it in Source Control."));
    }
    const ctl = new AbortController();
    const side = (stage: 1 | 2 | 3) => this.run(work.root, stageArgs(stage, file), ctl.signal).then((t) => t, () => undefined);
    const [base, ours, theirs] = await Promise.all([side(1), side(2), side(3)]);
    const input = { repo: work.name, path: file, operation: op, head, base, ours, theirs, current };
    if (conflictTooLarge(input)) return cannot(localize("too large to send. Resolve it in the merge editor."));
    let answer: string;
    try {
      answer = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: localize("Linyra AI is merging {0} ({1} of {2})…", file, at.index, at.total), cancellable: true }, async (_p, token) => {
        token.onCancellationRequested(() => ctl.abort());
        return (await ai.ask(mergeRequest(input, ctl.signal))).text;
      });
    } catch (e) {
      return cannot(isCancel(e) || ctl.signal.aborted ? localize("cancelled before the model answered.") : messageOf(e));
    }
    const merged = parseMerge(answer, current);
    if (!merged.ok) return cannot(merged.reason === "markers" ? localize("the proposal still has conflict markers.") : localize("the answer had no merged file."));
    const proposal = this.deps.mergeDocs.put(file, merged.content);
    await vscode.commands.executeCommand("vscode.diff", proposal, uri, localize("{0}: AI proposal ↔ file now ({1})", path.posix.basename(file), work.name), { preview: true });
    const choice = await decide({ note: merged.note }, proposal);
    if (choice !== "accept") return choice === "stop" ? "stop" : "skipped";
    try {
      await fs.writeFile(uri.fsPath, merged.content, "utf8");
      await this.run(work.root, ["add", "--", `:(literal)${file}`], new AbortController().signal);
      return "accepted";
    } catch (e) {
      void vscode.window.showErrorMessage(localize("Linyra could not write {0}: {1}", file, messageOf(e)));
      return "skipped";
    }
  }

  /** linyra.ai.explainConflicts: Compare's predicted conflicts of a repository (or every one that has some), explained; nothing is written. */
  async explainConflicts(arg?: unknown): Promise<void> {
    const t = this.deps.compare.pair ? this.deps.compareTarget(arg) : {};
    const targets = this.deps.compare.results().flatMap(({ repo, result }) =>
      result.kind === "differs" && result.conflicts && result.conflicts.length > 0 && (!t.repoId || t.repoId === repo.id) ? [{ repo, result }] : []);
    if (!this.deps.compare.pair || targets.length === 0) { void vscode.window.showInformationMessage(localize("Compare predicts no conflicts here.")); return; }
    const ai = await this.ready();
    if (!ai) return;
    const title = targets.length === 1 ? localize("Explain Conflicts ({0})", targets[0].repo.name) : localize("Explain Conflicts ({0} repositories)", targets.length);
    await this.present(ai, title, async (write, signal) => {
      for (const { repo, result } of targets) {
        if (result.kind !== "differs") continue;
        const files = (result.conflicts ?? []).filter((f) => !t.path || f === t.path).slice(0, 10);
        const base = result.base ?? (await this.run(repo.root, mergeBaseArgs(result.leftSha, result.rightSha), signal).catch(() => "")).trim();
        const blob = (sha: string, file: string) => (sha ? this.run(repo.root, blobArgs(sha, file), signal).then((x) => x, () => undefined) : Promise.resolve(undefined));
        const read: PredictedConflict[] = [];
        let used = 0;
        const left: string[] = [];
        for (const f of files) {
          if (ai.excluded(f)) { left.push(f); continue; }
          const [b, l, r] = await Promise.all([blob(base, f), blob(result.leftSha, f), blob(result.rightSha, f)]);
          const size = (b?.length ?? 0) + (l?.length ?? 0) + (r?.length ?? 0);
          if (used + size > LIMITS.totalChars) { left.push(f); continue; }
          used += size;
          read.push({ path: f, base: b, left: l, right: r });
        }
        if (targets.length > 1) write(`## ${repo.name}\n\n`);
        if (read.length === 0) { write(`${localize("Not sent (excluded or too large): {0}", left.join(", "))}\n\n`); continue; }
        await ai.ask(explainConflictsRequest(repo.name, result.leftName, result.rightName, read, this.language, signal, write));
        if (left.length) write(`\n\n${localize("Not sent (excluded or too large): {0}", left.join(", "))}`);
        write("\n\n");
      }
    });
  }

  /** A request as the Ask AI tools start it, without waiting (each explanation shows itself). */
  start(work: () => Promise<void>): string {
    void work().catch((e: unknown) => this.fail(e));
    return localize("Opened in the editor area.");
  }

  /** Ask AI's stash_changes runs Stash Changes… with its message and choice given. */
  stash(repo: Repo, message: string, untracked: boolean): Promise<void> {
    return this.deps.branches.stashCreate({ repoId: repo.id }, { message, untracked });
  }
}

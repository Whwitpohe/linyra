import { localize } from "./i18n";
import * as vscode from "vscode";
import type { RunGit } from "./logQuery";
import { isAbortError, runPool } from "./pool";
import { commandText, isReadOnly, parseCommandLine, RUN_TIMEOUT_MS, runReport, runTimeout, type RunResult } from "./runAcrossModel";
import type { Repo } from "./types";
import type { Ask } from "./uncommittedActions";
import { FETCH_ENV } from "./upstream";

export interface RunAcrossHost {
  /** The ticked repositories, in the Repo List's order. */
  repos(): readonly Repo[];
  viewId: string;
  run: RunGit;
  ask: Ask;
  concurrency(): number;
  /** A command that may write ran: the Log, uncommitted work and marks of these repositories are read again. */
  changed(repoIds: readonly string[]): Promise<void>;
}

/** A command that may write runs a few at a time, as Linyra's own writes do. */
const WRITE_CONCURRENCY = 4;

/**
 * ⋯ → Run Git Command Across Repositories…: one git command, typed, run in every ticked repository
 * (never through a shell, never prompting); each repository's output in one read-only document.
 * A command that may write is confirmed first; one that only reads runs at once.
 */
export class RunAcross implements vscode.TextDocumentContentProvider, vscode.Disposable {
  static readonly scheme = "linyra-run";
  private readonly docs = new Map<string, string>();
  private readonly changedDoc = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changedDoc.event;
  private last = "";
  private count = 0;
  /** The last run's results (integration test seam). */
  lastResults: RunResult[] | undefined;

  constructor(private readonly host: RunAcrossHost) {}

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.toString()) ?? "";
  }

  async run(preset?: string): Promise<RunResult[] | undefined> {
    const repos = [...this.host.repos()];
    if (repos.length === 0) return undefined;
    const line = preset ?? (await this.host.ask.input(localize("A git command to run in each of the {0} ticked repositories", repos.length), localize("For example: status -sb"), {
      value: this.last, validate: (v) => { const p = parseCommandLine(v); return typeof p === "string" ? p : undefined; },
    }));
    if (line === undefined) return undefined;
    const args = parseCommandLine(line);
    if (typeof args === "string") return undefined;
    this.last = line;
    const shown = commandText(args);
    const reads = isReadOnly(args);
    if (!reads && !(await this.host.ask.warning(localize("Run “git {0}” in {1} repositories?", shown, repos.length),
      localize("It runs as typed in each ticked repository, a few at a time, without prompts. Linyra cannot undo what it does."), localize("Run")))) return undefined;
    // A read that hangs stops at its timeout (runTimeout). A write is never stopped by a timer: still
    // running then, it is named, and stopped (with the ones not started yet) only if the user says so.
    const stop = new AbortController(), running = new Set<string>();
    const slow = reads ? undefined : setTimeout(() => {
      if (running.size === 0) return;
      const button = localize("Stop");
      void vscode.window.showWarningMessage(localize("“git {0}” is still running in {1} after {2} s. Stopping it now can leave a repository halfway through what it writes.", shown, [...running].join(", "), RUN_TIMEOUT_MS / 1000), button)
        .then((pick) => { if (pick === button) stop.abort(); });
    }, RUN_TIMEOUT_MS);
    let settled: PromiseSettledResult<RunResult>[];
    try {
      settled = await vscode.window.withProgress({ location: { viewId: this.host.viewId }, title: `git ${shown}` }, () =>
        runPool(repos, reads ? this.host.concurrency() : WRITE_CONCURRENCY, async (r) => {
          running.add(r.name);
          try { return await this.one(r, args, stop.signal); } finally { running.delete(r.name); }
        }, stop.signal));
    } finally {
      clearTimeout(slow);
    }
    const results = settled.map((s, i): RunResult => (s.status === "fulfilled" ? s.value : { repo: repos[i].name, code: null, stdout: "", stderr: isAbortError(s.reason) ? localize("not run: stopped before it started") : String(s.reason) }));
    this.lastResults = results;
    const uri = vscode.Uri.from({ scheme: RunAcross.scheme, path: `/git ${args[0]} ${++this.count}.txt` });
    this.docs.set(uri.toString(), runReport(shown, results));
    // The last few reports only: a git log -p across many repositories is not kept for the session.
    for (const key of [...this.docs.keys()].slice(0, Math.max(0, this.docs.size - 10))) this.docs.delete(key);
    this.changedDoc.fire(uri);
    if (process.env.LINYRA_ITEST !== "1") {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: true });
    }
    if (!reads) await this.host.changed(repos.map((r) => r.id));
    return results;
  }

  /** One repository's run: stopped at its timeout (a read only), or when `stop` is (the user said so). */
  private async one(repo: Repo, args: string[], stop: AbortSignal): Promise<RunResult> {
    const reads = isReadOnly(args);
    const ctl = new AbortController();
    const limit = runTimeout(args);
    const timer = limit === undefined ? undefined : setTimeout(() => ctl.abort(), limit);
    const onStop = () => ctl.abort();
    stop.addEventListener("abort", onStop, { once: true });
    let stderr = "";
    try {
      const stdout = await this.host.run(repo.root, args, ctl.signal, {
        // stdin closed: a command that would read it (shortlog with no revision, cat-file --batch) ends at once.
        tree: true, input: "", onStderr: (text) => { stderr = text; },
        // Never an editor or a prompt; a writing command may take the index lock.
        env: { ...FETCH_ENV, GIT_EDITOR: ":", GIT_PAGER: "cat", ...(reads ? {} : { GIT_OPTIONAL_LOCKS: "1" }) },
      });
      return { repo: repo.name, code: 0, stdout, stderr };
    } catch (e) {
      const err = e as { exitCode?: unknown; stdout?: unknown };
      // Stopped: said under its output, the timeout's or the user's.
      const why = !ctl.signal.aborted ? "" : stop.aborted ? localize("stopped when you asked") : localize("stopped after {0} s without an answer", (limit ?? 0) / 1000);
      return { repo: repo.name, code: ctl.signal.aborted ? null : typeof err.exitCode === "number" ? err.exitCode : null, stdout: typeof err.stdout === "string" ? err.stdout : "",
        stderr: [stderr || (e instanceof Error ? e.message : String(e)), why].filter(Boolean).join("\n") };
    } finally {
      clearTimeout(timer);
      stop.removeEventListener("abort", onStop);
    }
  }

  dispose(): void {
    this.changedDoc.dispose();
  }
}

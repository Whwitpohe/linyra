import { localize } from "./i18n";
import * as vscode from "vscode";
import type { RunGit } from "./logQuery";
import { runPool } from "./pool";
import { commandText, isReadOnly, parseCommandLine, runReport, type RunResult } from "./runAcrossModel";
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

/** A command that hangs (a credential helper waiting, a huge log) stops after this long. */
const TIMEOUT_MS = 120_000;
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
    const settled = await vscode.window.withProgress({ location: { viewId: this.host.viewId }, title: `git ${shown}` }, () =>
      runPool(repos, reads ? this.host.concurrency() : WRITE_CONCURRENCY, (r) => this.one(r, args, reads), new AbortController().signal));
    const results = settled.map((s, i): RunResult => (s.status === "fulfilled" ? s.value : { repo: repos[i].name, code: null, stdout: "", stderr: String(s.reason) }));
    this.lastResults = results;
    const uri = vscode.Uri.from({ scheme: RunAcross.scheme, path: `/git ${args[0]} ${++this.count}.txt` });
    this.docs.set(uri.toString(), runReport(shown, results));
    this.changedDoc.fire(uri);
    if (process.env.LINYRA_ITEST !== "1") {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: true });
    }
    if (!reads) await this.host.changed(repos.map((r) => r.id));
    return results;
  }

  private async one(repo: Repo, args: string[], reads: boolean): Promise<RunResult> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    let stderr = "";
    try {
      const stdout = await this.host.run(repo.root, args, ctl.signal, {
        tree: true, onStderr: (text) => { stderr = text; },
        // Never an editor or a prompt; a writing command may take the index lock.
        env: { ...FETCH_ENV, GIT_EDITOR: ":", GIT_PAGER: "cat", ...(reads ? {} : { GIT_OPTIONAL_LOCKS: "1" }) },
      });
      return { repo: repo.name, code: 0, stdout, stderr };
    } catch (e) {
      const err = e as { exitCode?: unknown; stdout?: unknown };
      return { repo: repo.name, code: ctl.signal.aborted ? null : typeof err.exitCode === "number" ? err.exitCode : null, stdout: typeof err.stdout === "string" ? err.stdout : "", stderr: stderr || (e instanceof Error ? e.message : String(e)) };
    } finally {
      clearTimeout(timer);
    }
  }

  dispose(): void {
    this.changedDoc.dispose();
  }
}

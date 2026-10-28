import { promises as fs } from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { debounce } from "./debounce";
import type { RunGit } from "./logQuery";
import { runPool } from "./pool";
import type { FileChange, Repo } from "./types";
import type { RepoWork } from "./uncommittedModel";
import { headOf, parseNumstat, splitStatus, stagedNumstatArgs, statusArgs, unstagedNumstatArgs, workFiles } from "./workingTree";

/** What the store reads: the ticked repositories (Repo List order) under the Path box. */
export interface Scope {
  repos: readonly Repo[];
  pathspecs: readonly string[];
}

export interface StoreDeps {
  run: RunGit;
  /** VS Code's Git reports this repository's changes (else it is read on every full read). */
  reportsChanges(root: string): boolean;
  /**
   * The HEAD commit when VS Code's Git has found the repository clean (undefined: unknown).
   * Trusted only where its view is current: see `read`.
   */
  cleanHead?(root: string): string | undefined;
  /** VS Code's Git has the repository open: Stage, Discard and Commit work there. */
  canStage(root: string): boolean;
  concurrency(): number;
}

/** Why a repository's uncommitted work is read: a save in it or VS Code's Git reporting it, every repository, or one asked for. */
type ReadCause = "touched" | "all" | "repo";

interface Entry extends RepoWork {
  /** Orders reads of one repository: a slower, older read never replaces a newer one. */
  seq: number;
}

/** Changed files whose modification time decides "edited N ago". */
const EDITED_SAMPLE = 50;
/** Unreported repositories are read again on focus at most this often (alt-tabbing is bursty). */
const UNREPORTED_INTERVAL_MS = 5000;

async function newestMtime(root: string, paths: readonly string[]): Promise<number | null> {
  const stats = await Promise.allSettled(paths.map((p) => fs.stat(path.join(root, ...p.split("/")))));
  let newest: number | null = null;
  for (const s of stats) if (s.status === "fulfilled" && (newest === null || s.value.mtimeMs > newest)) newest = s.value.mtimeMs;
  return newest;
}

/** Whether a new read shows the same work as the last one (then nobody is told). */
function sameWork(a: RepoWork | undefined, b: RepoWork): boolean {
  if (a === undefined) return b.staged.length + b.changes.length === 0;
  return a.head === b.head && a.editedAt === b.editedAt
    && JSON.stringify(a.staged) === JSON.stringify(b.staged) && JSON.stringify(a.changes) === JSON.stringify(b.changes);
}

/**
 * Each ticked repository's uncommitted work, read from git: once in the background after the
 * Log's first page, then one repository at a time when a save or VS Code's Git says it changed.
 * Nothing here is a cache: every value is a git read, kept current by those events.
 * The Log's Commits | Uncommitted switch and the Uncommitted view both show it.
 */
export class UncommittedStore implements vscode.Disposable {
  private scope: Scope = { repos: [], pathspecs: [] };
  private readonly map = new Map<string, Entry>();
  /** The pathspec the map was read under (a new one reads every repository again). */
  private spec: string | undefined;
  private seq = 0;
  /** The read of every repository; a newer one aborts it. */
  private fullRead = new AbortController();
  /** Reads of single repositories; a read of every repository aborts them. */
  private repoReads = new AbortController();
  /**
   * The repositories and pathspec of the last complete read of every repository (and of the one
   * in flight). The same again reads only what VS Code's Git does not report on.
   */
  private done: string | undefined;
  private inFlight: string | undefined;
  private reading: Promise<void> | undefined;
  private readonly touched = new Set<string>();
  /** Touched by a save: VS Code's Git has not looked yet, so its "clean" is not trusted for these. */
  private readonly saved = new Set<string>();
  private readonly touchedSoon = debounce(() => {
    const ids = new Set(this.touched);
    const trusted = new Set([...ids].filter((id) => !this.saved.has(id)));
    this.touched.clear();
    this.saved.clear();
    void this.read(ids, "touched", trusted);
  }, 400);
  /** Each repository read and why (integration test seam: a save reads only its own repository). */
  readonly reads: { root: string; why: ReadCause }[] = [];
  private readonly emitter = new vscode.EventEmitter<void>();
  /** The work changed (coalesced: at most once every 80 ms while repositories come in). */
  readonly onDidChange = this.emitter.event;
  private changeTimer: ReturnType<typeof setTimeout> | undefined;
  /** How many times onDidChange fired (integration test seam). */
  changes = 0;
  /** The background read has started (before it, nothing is read). */
  started = false;
  /** A read of every repository finished: the switch's badge can show a number. */
  known = false;

  constructor(private readonly deps: StoreDeps) {}

  /** The ticked repositories or the Path box changed. Repositories left out are forgotten at once. */
  setScope(scope: Scope): void {
    this.scope = scope;
    const ids = new Set(scope.repos.map((r) => r.id));
    let dropped = false;
    for (const id of [...this.map.keys()]) {
      if (ids.has(id)) continue;
      const w = this.map.get(id)!;
      this.map.delete(id);
      if (w.staged.length + w.changes.length > 0) dropped = true;
    }
    if (dropped) this.changedSoon();
  }

  /** Reads every repository of the scope (force: even if an identical read finished: Refresh, a new git). */
  readAll(force = false): Promise<void> {
    this.started = true;
    if (force) this.done = this.inFlight = this.reading = undefined;
    // Refresh asks git itself; the first read and a new scope take VS Code's Git's word for clean repositories.
    return this.read(undefined, "all", force ? undefined : "all");
  }

  /**
   * A Log reload: read every repository only when the scope (ticked repositories, Path box) is
   * not the one read already. A filter change does not change the working tree, so a reload
   * never reads the same scope again.
   */
  readIfScopeChanged(): Promise<void> | undefined {
    if (!this.started) return;
    const key = this.scopeKey();
    if (key === this.done || key === this.inFlight) return;
    return this.read(undefined, "all", "all");
  }

  /**
   * The repositories VS Code's Git reports nothing on, read again: when the window regains focus
   * (git may have run in another program) and when the Uncommitted side is shown. At most once
   * every few seconds, and never while a read of every repository is on its way.
   */
  readUnreported(): Promise<void> | undefined {
    if (!this.started || this.scopeKey() !== this.done || Date.now() - this.unreportedAt < UNREPORTED_INTERVAL_MS) return;
    const unreported = this.scope.repos.filter((r) => !this.deps.reportsChanges(r.root));
    if (unreported.length === 0) return;
    this.unreportedAt = Date.now();
    return this.read(new Set(unreported.map((r) => r.id)), "all");
  }
  private unreportedAt = 0;

  private scopeKey(): string {
    return `${this.scope.pathspecs.join("\0")}\n${this.scope.repos.map((r) => r.id).join("\0")}`;
  }

  /** A save, or VS Code's Git reporting a repository: read that repository again after a burst. */
  touch(fsPath: string, saved = false): void {
    if (!this.started) return;
    const repo = this.innermost(fsPath);
    if (!repo) return; // outside every ticked repository
    this.touched.add(repo.id);
    if (saved) this.saved.add(repo.id);
    this.touchedSoon();
  }

  /** Reads one repository now (after Stage, Unstage, Discard, Commit). */
  readRepo(repoId: string): Promise<void> {
    return this.read(new Set([repoId]));
  }

  /** The Path box filters what is read; a commit still takes the whole repository. */
  get filtered(): boolean {
    return this.scope.pathspecs.length > 0;
  }

  /** The whole repository's uncommitted work, ignoring the Path box (what a commit would take). */
  async whole(repoId: string): Promise<{ staged: number; changes: number; tracked: number } | undefined> {
    const r = this.scope.repos.find((x) => x.id === repoId);
    if (!r) return undefined;
    const split = splitStatus(await this.deps.run(r.root, statusArgs([]), new AbortController().signal));
    const paths = (fs: readonly { path: string }[]) => new Set(fs.map((f) => f.path)).size;
    return { staged: paths(split.staged), changes: paths(split.changes), tracked: paths(split.changes.filter((f) => !f.untracked)) };
  }

  /** The work of the repositories read so far, in Repo List order. */
  works(): RepoWork[] {
    return this.scope.repos.flatMap((r) => {
      const w = this.get(r.id);
      return w ? [w] : [];
    });
  }

  /** canStage is asked now, not remembered: vscode.git opens repositories after the first read. */
  get(repoId: string): RepoWork | undefined {
    const w = this.map.get(repoId);
    return w && { ...w, canStage: this.deps.canStage(w.root) };
  }

  private innermost(fsPath: string): Repo | undefined {
    return this.scope.repos
      .map((r) => ({ r, rel: path.relative(r.root, fsPath) }))
      .filter((x) => x.rel !== ".." && !x.rel.startsWith(`..${path.sep}`) && !path.isAbsolute(x.rel))
      .sort((a, b) => a.rel.length - b.rel.length)[0]?.r;
  }

  /**
   * `trust`: the repositories for which VS Code's Git's "clean" is current enough to skip git ("all",
   * or their ids): the first read, a new scope, its own reports. Never after a save, a Refresh or an
   * action of Linyra's: those ask git.
   */
  private async read(only?: ReadonlySet<string>, why: ReadCause = only ? "repo" : "all", trust?: "all" | ReadonlySet<string>): Promise<void> {
    const specs = this.scope.pathspecs;
    const spec = specs.join("\0");
    let repos = [...this.scope.repos];
    let ctl: AbortController;
    if (only) {
      // Under another pathspec, a read of every repository is already on its way.
      if (spec !== this.spec) return;
      repos = repos.filter((r) => only.has(r.id));
      ctl = this.repoReads;
    } else {
      const key = this.scopeKey();
      if (key === this.inFlight && !this.fullRead.signal.aborted && this.reading) return this.reading;
      if (key === this.done) {
        // Kept current by VS Code's Git and saves, except where it reports nothing: read those.
        const unreported = repos.filter((r) => !this.deps.reportsChanges(r.root));
        if (unreported.length > 0) await this.read(new Set(unreported.map((r) => r.id)), "all", trust);
        return;
      }
      this.done = undefined;
      this.inFlight = key;
      this.fullRead.abort();
      this.repoReads.abort();
      this.repoReads = new AbortController();
      ctl = this.fullRead = new AbortController();
      // Until its new result lands, each repository keeps its last one (no flicker), unless the
      // pathspec changed: then the old work answers another question.
      if (spec !== this.spec) {
        const had = [...this.map.values()].some((w) => w.staged.length + w.changes.length > 0);
        this.map.clear();
        // Another question: the badge waits for the whole answer again, not a count that climbs.
        this.known = false;
        if (had) this.changedSoon();
      }
      this.spec = spec;
    }
    const trusted = (r: Repo) => trust === "all" || (trust?.has(r.id) ?? false);
    const readInto = async (r: Repo, signal: AbortSignal) => {
      const seq = ++this.seq;
      const work = await this.readOne(r, specs, signal, why, trusted(r));
      if (ctl.signal.aborted) return;
      const old = this.map.get(r.id);
      if (old && old.seq > seq) return;
      this.map.set(r.id, { ...work, seq });
      // Show each repository as soon as it is read, rather than after the slowest one.
      if (!sameWork(old, work)) this.changedSoon();
    };
    const reading = runPool(repos, this.deps.concurrency(), readInto, ctl.signal);
    if (only) {
      await reading;
      return;
    }
    const done = reading.then((settled) => {
      if (this.fullRead !== ctl) return;
      this.reading = undefined;
      // Done only if every repository answered: one that failed is read again next time.
      if (!ctl.signal.aborted && settled.every((s) => s.status === "fulfilled")) this.done = this.inFlight;
      this.inFlight = undefined;
      if (!ctl.signal.aborted && !this.known) {
        this.known = true;
        this.changedSoon();
      }
    });
    this.reading = done;
    await done;
  }

  /** git status, then (only where something changed) the two numstat reads and the edit times. */
  private async readOne(r: Repo, specs: readonly string[], signal: AbortSignal, why: ReadCause, trusted: boolean): Promise<RepoWork> {
    // Clean as VS Code's Git last found it, and its view is current: no git process at all. Only
    // to confirm a repository already known clean: its event can come before it has read the
    // working tree again, and its word must never erase changes git itself reported.
    const known = this.map.get(r.id);
    const knownClean = !known || known.staged.length + known.changes.length === 0;
    const cleanHead = trusted && knownClean ? this.deps.cleanHead?.(r.root) : undefined;
    if (cleanHead !== undefined) return { repoId: r.id, root: r.root, name: r.name, head: cleanHead, staged: [], changes: [], editedAt: null, canStage: this.deps.canStage(r.root) };
    this.reads.push({ root: r.root, why });
    if (process.env.LINYRA_ITEST !== "1" && this.reads.length > 200) this.reads.splice(0, this.reads.length - 200);
    // One call for a clean repository: --branch carries the last commit's id too.
    const out = await this.deps.run(r.root, statusArgs(specs), signal);
    const head = headOf(out);
    const split = splitStatus(out);
    let staged: FileChange[] = [];
    let changes: FileChange[] = [];
    let editedAt: number | null = null;
    if (split.staged.length + split.changes.length > 0) {
      const [s, u] = await Promise.all([
        split.staged.length > 0 ? this.deps.run(r.root, stagedNumstatArgs(head, specs), signal) : Promise.resolve(""),
        split.changes.length > 0 ? this.deps.run(r.root, unstagedNumstatArgs(specs), signal) : Promise.resolve(""),
      ]);
      staged = workFiles(split.staged, parseNumstat(s));
      changes = workFiles(split.changes, parseNumstat(u));
      const present = [...new Set([...staged, ...changes].filter((f) => f.status !== "D").map((f) => f.path))].slice(0, EDITED_SAMPLE);
      editedAt = await newestMtime(r.root, present);
    }
    return { repoId: r.id, root: r.root, name: r.name, head, staged, changes, editedAt, canStage: this.deps.canStage(r.root) };
  }

  private changedSoon(): void {
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = undefined;
      this.changes++;
      this.emitter.fire();
    }, 80);
  }

  dispose(): void {
    this.fullRead.abort();
    this.repoReads.abort();
    this.touchedSoon.cancel();
    clearTimeout(this.changeTimer);
    this.emitter.dispose();
  }
}

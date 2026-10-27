import { localize } from "./i18n";
import * as vscode from "vscode";
import { parseShow, showArgs } from "./commitDetail";
import {
  bothPaths, filesArgs, sameNow, tipsDiffArgs, logArgs, mergeBaseArgs, mirror, parseFiles, parseRevParse, parseSideCount, parseSideLog,
  revParseArgs, setRemoteNames, sideCountArgs, type Pair, type RepoCompare, type Side, type SideCommit,
} from "./compareModel";
import { GitError } from "./git";
import type { RunGit } from "./logQuery";
import { isAbortError, runPool } from "./pool";
import { branchSuggestions } from "./repos";
import type { FileChange, Repo } from "./types";

/** Files mode for one repository. both: changed on both sides; same: of those, the same at both tips. */
export interface FilesRead { left: FileChange[]; right: FileChange[]; both: string[]; same: string[] }

export interface CompareDeps {
  run: RunGit;
  concurrency(): number;
  /** The ticked repositories, in Repo List order. */
  repos(): readonly Repo[];
}

/** A result as the tests and the list name it. */
export function rowLabel(name: string, c: RepoCompare): string {
  switch (c.kind) {
    case "differs": return `${name} ◀${c.left} ▶${c.right} =${c.sameLeft}`;
    case "nobase": return localize("{0} no common history", name);
    case "error": return localize("{0} git error: {1}", name, c.reason);
    default: return localize("{0} {1}", name, c.kind);
  }
}

/**
 * Two branches compared in each ticked repository: one read per repository when the pair is
 * picked, kept until the pair, the ticks or a branch changes. Nothing here is a cache: every
 * number is the answer of the last git read, and each change of what was asked reads again.
 */
export class CompareStore implements vscode.Disposable {
  private current: Pair | null = null;
  private readonly map = new Map<string, RepoCompare>();
  /** Bumped by every new pair and swap: a read of an older one is dropped when it lands. */
  private gen = 0;
  private ctl = new AbortController();
  private inFlight = 0;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly deps: CompareDeps) {}

  get pair(): Pair | null {
    return this.current;
  }

  get reading(): boolean {
    return this.inFlight > 0;
  }

  /** A new pair: everything in flight stops, every ticked repository is read. null forgets it. */
  async setPair(p: Pair | null): Promise<void> {
    this.ctl.abort();
    this.ctl = new AbortController();
    this.gen++;
    this.current = p;
    this.map.clear();
    this.changed();
    if (p && p.left !== p.right) await this.read(this.deps.repos());
  }

  /** Left and right trade places: the results are mirrored, nothing is read. */
  swap(): void {
    if (!this.current) return;
    // A read still running is stopped here: what it had not answered yet is read again below.
    const wasReading = this.inFlight > 0;
    this.ctl.abort();
    this.ctl = new AbortController();
    this.gen++;
    this.current = { left: this.current.right, right: this.current.left };
    for (const [id, c] of this.map) this.map.set(id, mirror(c));
    this.changed();
    // Unanswered repositories, and (a Refresh cut short) answers that may be old: read them again.
    if (wasReading) void this.read(this.deps.repos().filter((r) => !this.map.has(r.id) || this.refreshing.has(r.id)));
  }

  /** The ticks changed: unticked repositories leave at once, newly ticked ones are read. */
  async scopeChanged(): Promise<void> {
    const ids = new Set(this.deps.repos().map((r) => r.id));
    for (const id of [...this.map.keys()]) if (!ids.has(id)) this.map.delete(id);
    this.changed();
    if (!this.current || this.current.left === this.current.right) return;
    await this.read(this.deps.repos().filter((r) => !this.map.has(r.id)));
  }

  /** Reads again: one repository (its branches moved) or all (Refresh, Fetch All). */
  async refresh(repoId?: string): Promise<void> {
    if (!this.current || this.current.left === this.current.right) return;
    const repos = this.deps.repos().filter((r) => repoId === undefined || r.id === repoId);
    for (const r of repos) this.refreshing.add(r.id);
    try {
      await this.read(repos);
    } finally {
      for (const r of repos) this.refreshing.delete(r.id);
    }
  }
  /** Repositories a Refresh is reading again (a swap meanwhile reads them once more). */
  private readonly refreshing = new Set<string>();

  results(): { repo: Repo; result: RepoCompare }[] {
    return this.deps.repos().flatMap((repo) => {
      const result = this.map.get(repo.id);
      return result ? [{ repo, result }] : [];
    });
  }

  private async read(repos: readonly Repo[]): Promise<void> {
    const p = this.current;
    if (!p || repos.length === 0) return;
    const gen = this.gen;
    const signal = this.ctl.signal;
    this.inFlight++;
    this.changed();
    try {
      await runPool(repos, this.deps.concurrency(), async (r, s) => {
        const result = await this.readOne(r, p, s);
        // A newer pair or swap, or the repository was unticked meanwhile: drop it.
        if (gen !== this.gen || signal.aborted || !this.deps.repos().some((x) => x.id === r.id)) return;
        this.map.set(r.id, result);
        this.changed();
      }, signal);
    } finally {
      this.inFlight--;
      this.changed();
    }
  }

  private async readOne(r: Repo, p: Pair, signal: AbortSignal): Promise<RepoCompare> {
    let ids: ReturnType<typeof parseRevParse>;
    try {
      ids = parseRevParse(await this.deps.run(r.root, revParseArgs(p), signal));
    } catch (e) {
      if (isAbortError(e)) throw e;
      return { kind: "missing" };
    }
    if (!ids) return { kind: "missing" };
    const { left: l, right: rt } = ids;
    // The same files on both sides: nothing to review, whatever merges or duplicates the commits hold.
    if (ids.sameFiles) return { kind: "identical" };
    try {
      // All three at once: a repository's answer waits for one round of git, not two.
      const [base, left, right] = await Promise.all([
        this.deps.run(r.root, mergeBaseArgs(l, rt), signal).then((out) => out.trim(), (e) => {
          if (e instanceof GitError && e.exitCode === 1) return null;
          throw e;
        }),
        this.deps.run(r.root, sideCountArgs("left", l, rt), signal).then(parseSideCount),
        this.deps.run(r.root, sideCountArgs("right", l, rt), signal).then(parseSideCount),
      ]);
      if (base === null) return { kind: "nobase" };
      return { kind: "differs", leftSha: l, rightSha: rt, base, left: left.only, right: right.only, sameLeft: left.same, sameRight: right.same };
    } catch (e) {
      if (isAbortError(e)) throw e;
      return { kind: "error", reason: e instanceof Error ? e.message : String(e) };
    }
  }

  private differs(repoId: string): { repo: Repo; c: Extract<RepoCompare, { kind: "differs" }> } | undefined {
    const repo = this.deps.repos().find((r) => r.id === repoId);
    const c = this.map.get(repoId);
    return repo && c?.kind === "differs" ? { repo, c } : undefined;
  }

  /**
   * Files mode for one repository: each side's changes since the split, and the paths both
   * changed (and of those, the ones the two tips now have the same). Both side views ask for it: they share the read for the same tips and base (the
   * answer for the repository on screen, dropped when its branches move).
   */
  readFiles(repoId: string): Promise<FilesRead> {
    const d = this.differs(repoId);
    if (!d) return Promise.resolve({ left: [], right: [], both: [], same: [] });
    const key = `${repoId}\0${d.c.leftSha} ${d.c.rightSha} ${d.c.base}\0${this.gen}`;
    if (this.files?.key === key) return this.files.read;
    const signal = this.ctl.signal;
    const read = Promise.all([
      this.deps.run(d.repo.root, filesArgs(d.c.base, d.c.leftSha), signal).then(parseFiles),
      this.deps.run(d.repo.root, filesArgs(d.c.base, d.c.rightSha), signal).then(parseFiles),
      this.deps.run(d.repo.root, tipsDiffArgs(d.c.leftSha, d.c.rightSha), signal),
    ]).then(([left, right, tips]) => {
      const both = bothPaths(left, right);
      return { left, right, both: [...both], same: [...sameNow(both, tips)] };
    });
    this.files = { key, read };
    read.catch(() => {
      if (this.files?.read === read) this.files = undefined; // a failed or aborted read is not kept
    });
    return read;
  }
  private files: { key: string; read: Promise<FilesRead> } | undefined;

  /** Commits mode for one side of one repository, newest first. */
  async readCommits(repoId: string, side: Side, max: number): Promise<SideCommit[]> {
    const d = this.differs(repoId);
    if (!d) return [];
    return parseSideLog(await this.deps.run(d.repo.root, logArgs(side, d.c.leftSha, d.c.rightSha, max), this.ctl.signal));
  }

  async readCommitFiles(repoId: string, sha: string): Promise<FileChange[]> {
    const repo = this.deps.repos().find((r) => r.id === repoId);
    if (!repo) return [];
    return parseShow(await this.deps.run(repo.root, showArgs(sha), this.ctl.signal)).files;
  }

  /** The remotes the last branch read found ("origin", …): the Branch picker's Remote group. */
  remoteNames: string[] = [];

  /** Branch names across the ticked repositories, with how many have each (the Branch picker). */
  async readBranches(): Promise<{ name: string; count: number }[]> {
    const repos = [...this.deps.repos()];
    const settled = await runPool(repos, this.deps.concurrency(),
      (r, signal) => this.deps.run(r.root, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"], signal), new AbortController().signal);
    const remotes = new Set<string>();
    const lists = settled.map((s) => (s.status === "fulfilled" ? s.value.split("\n").map((l) => l.trim()).filter(Boolean) : []).map((ref) => {
      const m = /^refs\/remotes\/([^/]+)\//.exec(ref);
      if (m) remotes.add(m[1]);
      return ref.replace(/^refs\/(heads|remotes)\//, "");
    }));
    setRemoteNames(remotes);
    this.remoteNames = [...remotes];
    return branchSuggestions(lists);
  }

  private changed(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.emitter.fire();
    }, 80);
  }

  dispose(): void {
    this.ctl.abort();
    clearTimeout(this.timer);
    this.emitter.dispose();
  }
}

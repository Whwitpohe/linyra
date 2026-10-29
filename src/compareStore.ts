import { localize } from "./i18n";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { parseShow, showArgs } from "./commitDetail";
import {
  bothPaths, filesArgs, sameNow, tipsDiffArgs, logArgs, mergeBaseArgs, mergeTreeArgs, mergeTreeFailure, mirror, parseFiles, parseMergeTree, parseResolve, parseSideCount, parseSideLog,
  resolveInput, setRemoteNames, sideCountArgs, type Pair, type RepoCompare, type Side, type SideCommit,
} from "./compareModel";
import { GitError } from "./git";
import type { RunGit } from "./logQuery";
import { isAbortError, runPool } from "./pool";
import { branchSuggestions } from "./repos";
import type { FileChange, Repo } from "./types";

/** Files mode for one repository. both: changed on both sides; same: of those, the same at both tips; base: the split point. */
export interface FilesRead { left: FileChange[]; right: FileChange[]; both: string[]; same: string[]; base: string }

export interface CompareDeps {
  run: RunGit;
  concurrency(): number;
  /** The ticked repositories, in Repo List order. */
  repos(): readonly Repo[];
}

/** A result as the tests and the list name it. */
export function rowLabel(name: string, c: RepoCompare): string {
  switch (c.kind) {
    case "differs": return `${name} ◀${c.left} ▶${c.right} =${c.sameLeft}${c.conflicts?.length ? ` ⚠${c.conflicts.length}` : ""}`;
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
    this.files.clear();
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
    this.files.clear();
    for (const [id, c] of this.map) this.map.set(id, mirror(c));
    this.changed();
    // Unanswered repositories, and (a Refresh cut short) answers that may be old: read them again.
    if (wasReading) void this.read(this.deps.repos().filter((r) => !this.map.has(r.id) || this.refreshing.has(r.id)));
  }

  /** The ticks changed: unticked repositories leave at once, newly ticked ones are read. */
  async scopeChanged(): Promise<void> {
    const ids = new Set(this.deps.repos().map((r) => r.id));
    for (const id of [...this.map.keys()]) if (!ids.has(id)) this.map.delete(id);
    for (const id of [...this.files.keys()]) if (!ids.has(id)) this.files.delete(id);
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
    let ids: ReturnType<typeof parseResolve>;
    try {
      // Each side's first name this repository has: every name of the pair in one git process.
      ids = parseResolve(p, await this.deps.run(r.root, ["cat-file", "--batch-check"], signal, { input: resolveInput(p) }));
    } catch (e) {
      if (isAbortError(e)) throw e;
      return { kind: "missing" };
    }
    if (!ids.left || !ids.right) return { kind: "missing" };
    const { left: L, right: R } = ids;
    // The same files on both sides: nothing to review, whatever merges or duplicates the commits hold.
    if (L.tree === R.tree) return { kind: "identical" };
    const l = L.sha, rt = R.sha;
    try {
      // All three at once: a repository's answer waits for one round of git, not two. The merge
      // check also says whether the two share history, so the split point waits for a side to need it.
      const [merge, left, right] = await Promise.all([
        this.mergeCheck(r, l, rt, signal),
        this.deps.run(r.root, sideCountArgs("left", l, rt), signal).then(parseSideCount),
        this.deps.run(r.root, sideCountArgs("right", l, rt), signal).then(parseSideCount),
      ]);
      if (merge === "nobase") return { kind: "nobase" };
      let base: string | null = null;
      if (merge === "unknown") {
        // A git without merge-tree --write-tree: the split point tells whether they share history.
        base = await this.mergeBase(r, l, rt, signal);
        if (base === null) return { kind: "nobase" };
      }
      return { kind: "differs", leftName: L.name, rightName: R.name, leftSha: l, rightSha: rt, base, left: left.only, right: right.only, sameLeft: left.same, sameRight: right.same,
        conflicts: merge === "unknown" ? null : merge.conflicts };
    } catch (e) {
      if (isAbortError(e)) throw e;
      return { kind: "error", reason: e instanceof Error ? e.message : String(e) };
    }
  }

  private mergeBase(r: Repo, l: string, rt: string, signal: AbortSignal): Promise<string | null> {
    return this.deps.run(r.root, mergeBaseArgs(l, rt), signal).then((out) => out.trim(), (e) => {
      if (e instanceof GitError && e.exitCode === 1) return null;
      throw e;
    });
  }

  /** git is older than 2.38 (no merge-tree --write-tree): conflicts are not checked again this session. */
  private noMergeTree = false;

  /**
   * Would merging the two conflict? git merge-tree does the merge in memory. The blobs and trees it
   * makes go to a scratch object directory (the repository's own is only read), so nothing is
   * written to the repository.
   */
  private async mergeCheck(r: Repo, l: string, rt: string, signal: AbortSignal): Promise<{ conflicts: string[] } | "nobase" | "unknown"> {
    const merged = await this.merge(r, l, rt, signal, async () => undefined);
    return merged === "nobase" || merged === "unknown" ? merged : { conflicts: merged.conflicts };
  }

  private async merge<T>(r: Repo, l: string, rt: string, signal: AbortSignal, then: (merged: { tree: string; conflicts: string[] }, env: Record<string, string>) => Promise<T>):
    Promise<{ conflicts: string[]; value: T } | "nobase" | "unknown"> {
    if (this.noMergeTree) return "unknown";
    const objects = await objectsDir(r.root);
    if (!objects) return "unknown";
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "linyra-merge-"));
    const env = { GIT_OBJECT_DIRECTORY: dir, GIT_ALTERNATE_OBJECT_DIRECTORIES: objects };
    try {
      let out: string;
      try {
        out = await this.deps.run(r.root, mergeTreeArgs(l, rt), signal, { env });
      } catch (e) {
        if (isAbortError(e)) throw e;
        if (e instanceof GitError && e.exitCode === 1) out = e.stdout;
        else {
          const why = mergeTreeFailure(e instanceof Error ? e.message : String(e));
          if (why === "unsupported") this.noMergeTree = true;
          return why === "nobase" ? "nobase" : "unknown";
        }
      }
      const merged = parseMergeTree(out);
      return { conflicts: merged.conflicts, value: await then(merged, env) };
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Preview Merge Result: the file as merging the two would leave it, conflict markers included
   * (undefined: this git cannot tell, or the merge has no such file).
   */
  async mergePreview(repoId: string, file: string): Promise<string | undefined> {
    const d = this.differs(repoId);
    if (!d) return undefined;
    const merged = await this.merge(d.repo, d.c.leftSha, d.c.rightSha, this.ctl.signal,
      (m, env) => this.deps.run(d.repo.root, ["cat-file", "blob", `${m.tree}:${file}`], this.ctl.signal, { env }).catch(() => undefined));
    return typeof merged === "object" ? merged.value : undefined;
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
    if (!d) return Promise.resolve({ left: [], right: [], both: [], same: [], base: "" });
    const key = `${d.c.leftSha} ${d.c.rightSha}\0${this.gen}`;
    const had = this.files.get(repoId);
    if (had?.key === key) return had.read;
    const signal = this.ctl.signal;
    const { leftSha: l, rightSha: rt } = d.c;
    const read = (async () => {
      // The split point, read now that a side needs it (unless the read of the pair had it).
      const base = d.c.base ?? await this.mergeBase(d.repo, l, rt, signal);
      if (base === null) throw new Error(localize("{0}: the two branches share no history, so there is no split point.", d.repo.name));
      const [left, right, tips] = await Promise.all([
        this.deps.run(d.repo.root, filesArgs(base, l), signal).then(parseFiles),
        this.deps.run(d.repo.root, filesArgs(base, rt), signal).then(parseFiles),
        this.deps.run(d.repo.root, tipsDiffArgs(l, rt), signal),
      ]);
      const both = bothPaths(left, right);
      return { left, right, both: [...both], same: [...sameNow(both, tips)], base };
    })();
    this.files.set(repoId, { key, read });
    read.catch(() => {
      if (this.files.get(repoId)?.read === read) this.files.delete(repoId); // a failed or aborted read is not kept
    });
    return read;
  }
  /** Each repository's Files read, for the tips it was read for (the repositories on screen; dropped with them). */
  private readonly files = new Map<string, { key: string; read: Promise<FilesRead> }>();

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
  /** Each remote's default branch (origin/HEAD) and how many repositories have one: the Branch picker's Default branch. */
  defaultBranches: { name: string; count: number }[] = [];

  /** Branch names across the ticked repositories, with how many have each (the Branch picker). */
  async readBranches(): Promise<{ name: string; count: number }[]> {
    const repos = [...this.deps.repos()];
    const settled = await runPool(repos, this.deps.concurrency(),
      (r, signal) => this.deps.run(r.root, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"], signal), new AbortController().signal);
    const remotes = new Set<string>();
    const heads = new Map<string, number>();
    const lists = settled.map((s) => (s.status === "fulfilled" ? s.value.split("\n").map((l) => l.trim()).filter(Boolean) : []).map((ref) => {
      const m = /^refs\/remotes\/([^/]+)\//.exec(ref);
      if (m) remotes.add(m[1]);
      if (m && ref === `refs/remotes/${m[1]}/HEAD`) heads.set(`${m[1]}/HEAD`, (heads.get(`${m[1]}/HEAD`) ?? 0) + 1);
      return ref.replace(/^refs\/(heads|remotes)\//, "");
    }));
    setRemoteNames(remotes);
    this.remoteNames = [...remotes];
    this.defaultBranches = [...heads].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1));
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

/**
 * The repository's object directory, read from the disk (no git process): .git/objects, or for a
 * worktree or submodule (.git is a "gitdir:" file) the one its common directory names.
 */
async function objectsDir(root: string): Promise<string | undefined> {
  const dotGit = path.join(root, ".git");
  try {
    let gitDir = dotGit;
    if ((await fs.stat(dotGit)).isFile()) {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(await fs.readFile(dotGit, "utf8"));
      if (!m) return undefined;
      gitDir = path.resolve(root, m[1]);
    }
    const common = await fs.readFile(path.join(gitDir, "commondir"), "utf8").then((c) => path.resolve(gitDir, c.trim()), () => gitDir);
    const objects = path.join(common, "objects");
    return (await fs.stat(objects)).isDirectory() ? objects : undefined;
  } catch {
    return undefined;
  }
}

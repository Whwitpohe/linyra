import type { RunOptions } from "./git";
import { hasOtherAuthors, historyArgs, historyPathsArgs, logArgs, parseHistoryPaths, selectRepos, selectedBranches, type FilterState } from "./filterModel";
import { fetchHashPage } from "./hashSearch";
import { countRecords, parseHistory, parseLog } from "./gitLog";
import { copyTopoState, takeReady, takeTopoReady, type RepoProgress, type TopoMergeState } from "./mergeStream";
import { abortError, runPool } from "./pool";
import { planSearch, runnable, searchRepos, searchSkips } from "./searchQuery";
import type { Commit, Repo, RepoFailure } from "./types";

export type RunGit = (cwd: string, args: string[], signal: AbortSignal, opts?: RunOptions) => Promise<string>;

export interface QueryState {
  /** Fixed at the first page so --since does not drift while paging. */
  now: number;
  progress: Map<string, RepoProgress>;
  /** File history: every name the file has had, learned on the first page. */
  historyPaths?: string[];
  topology?: TopoMergeState;
}

export interface PageRequest {
  repos: readonly Repo[];
  filter: FilterState;
  pageSize: number;
  concurrency: number;
  now: number;
  /** null for the first page; the previous page's state for Load More. */
  prev: QueryState | null;
  run: RunGit;
  signal: AbortSignal;
  /** repo id → that repo's user.email, for the "Me" filter. */
  me?: ReadonlyMap<string, string>;
  /** File history: only this repository, only this path (followed across renames). */
  history?: { repoId: string; path: string } | null;
}

/** Repositories with at least one selected branch, and those with none. */
export interface BranchUse {
  branches: string[];
  found: number;
  missing: number;
}

export interface PageResult {
  branchUse?: BranchUse;
  rows: Commit[];
  failures: RepoFailure[];
  state: QueryState;
  done: boolean;
}

/** Fetch rounds per page; each round drains at least one repo, so this only bounds pathological input. */
const MAX_ROUNDS = 64;

/** The most records one repository's git log returns at once, whatever the depth. */
export const MAX_BATCH = 2000;

/**
 * How many records to ask one repository for: a page at first, then as many as it has already
 * returned (up to MAX_BATCH). Each --skip walks the whole history above it again, and without a
 * commit-graph --topo-order walks all of it on every call; growing the batch makes reaching depth N
 * cost O(log N + N / MAX_BATCH) spawns instead of N / pageSize. The surplus waits as pending rows.
 */
export function batchSize(fetched: number, pageSize: number): number {
  return Math.max(pageSize, Math.min(fetched, MAX_BATCH));
}

/**
 * One page of the merged log: one `git log` per repository that needs more,
 * every filter pushed down as git flags, merged in memory. No index, no cache —
 * the pending rows live only as long as this query.
 */
export async function fetchPage(req: PageRequest): Promise<PageResult> {
  const now = req.prev?.now ?? req.now;
  // The search box's query, read once for every repository and page. One the box would not send
  // (invalid, or an operator still without its value) runs nothing.
  const search = planSearch(req.filter, now);
  if (!runnable(search)) return { rows: [], failures: [], state: { now, progress: new Map() }, done: true };
  // repo: narrows the ticked repositories (the Repo List keeps its ticks); not in File History.
  const scoped = req.history ? req.repos : searchRepos(search, req.repos);
  if (search.hashes.length > 0) return fetchHashPage({ ...req, repos: scoped }, search.hashes);
  const byId = new Map(req.repos.map((r) => [r.id, r]));
  // Copy, so an aborted page leaves the previous state intact.
  const progress = new Map<string, RepoProgress>(
    req.prev
      ? [...req.prev.progress].filter(([id]) => byId.has(id)).map(([id, p]) => [id, { ...p, pending: [...p.pending] }])
      : (req.history ? req.repos.filter((r) => r.id === req.history!.repoId) : selectRepos(req.filter, scoped))
          // Me alone: a repo with no user.email has no commits that are "mine". With other
          // authors picked too, it is still searched for them. author:@me alike.
          .filter((r) => !req.filter.mine || hasOtherAuthors(req.filter) || req.me?.has(r.id))
          .filter((r) => !searchSkips(search, req.me?.get(r.id)))
          .map((r) => [r.id, { fetched: 0, pending: [], exhausted: false }]),
  );
  const failures: RepoFailure[] = [];
  const topology = req.filter.sort === "topo" ? copyTopoState(req.prev?.topology) : undefined;
  const branches = selectedBranches(req.filter);

  // One listing resolves all selected names. Each repository can start its own log
  // immediately afterwards, without waiting for the others' ref listings.
  const resolveRef = async (repo: Repo, signal: AbortSignal): Promise<void> => {
    const p = progress.get(repo.id)!;
    if (!branches.length || p.refs !== undefined) return;
    const available = new Set((await req.run(repo.root, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes", "refs/tags"], signal)).split(/\r?\n/));
    p.refs = [...new Set(branches.flatMap((branch) => {
      if (branch === "HEAD") return ["HEAD"];
      // A name is a local branch first, then a remote-tracking branch, then a tag (git's own order).
      const ref = branch.startsWith("refs/") ? branch : ["heads", "remotes", "tags"].map((kind) => `refs/${kind}/${branch}`).find((r) => available.has(r));
      return ref && available.has(ref) ? [ref] : [];
    }))];
    if (signal.aborted) throw abortError();
  };
  if (branches.length && !req.prev && req.history) {
    // File history reads the file's names on its branch first.
    const repo = byId.get(req.history.repoId);
    if (repo && progress.has(repo.id)) await resolveRef(repo, req.signal);
  }
  // File history, first page: learn every name the file has had (one unfiltered
  // --follow walk), then query all of them like any other log.
  let historyPaths = req.prev?.historyPaths;
  if (req.history && !historyPaths) {
    const repo = byId.get(req.history.repoId);
    const p = repo && progress.get(repo.id);
    if (repo && p && (!branches.length || p.refs?.length)) {
      try {
        // Follow each selected tip separately so a rename on one branch cannot hide another's old name.
        const tips = p.refs?.length ? p.refs : [undefined];
        const names = await runPool(tips, req.concurrency, (ref, signal) => req.run(repo.root, historyPathsArgs(req.history!.path, ref), signal), req.signal);
        for (const result of names) if (result.status === "rejected") throw result.reason;
        historyPaths = [...new Set(names.flatMap((result) => parseHistoryPaths((result as PromiseFulfilledResult<string>).value, req.history!.path)))];
      } catch (e) {
        if (req.signal.aborted) throw abortError();
        progress.delete(repo.id);
        failures.push({ repoId: repo.id, name: repo.name, reason: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  const branchUse = (): BranchUse | undefined => {
    if (!branches.length) return undefined;
    const refs = [...progress.values()].map((p) => p.refs);
    return { branches, found: refs.filter((x) => x?.length).length, missing: refs.filter((x) => !x?.length).length };
  };

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const targets = [...progress]
      .filter(([, p]) => !p.exhausted && p.pending.length < req.pageSize)
      .map(([id]) => byId.get(id)!);
    const wanted = targets.map((repo) => batchSize(progress.get(repo.id)!.fetched, req.pageSize));
    const settled = await runPool(
      targets,
      req.concurrency,
      async (repo, signal) => {
        const i = targets.indexOf(repo);
        await resolveRef(repo, signal);
        const p = progress.get(repo.id)!;
        if (branches.length && !p.refs?.length) return "";
        const o = { pageSize: wanted[i], now, cursor: { skip: p.fetched }, me: req.me?.get(repo.id), refs: p.refs, search };
        return req.run(repo.root, req.history ? historyArgs(req.filter, { ...o, paths: historyPaths ?? [req.history.path] }) : logArgs(req.filter, o), signal);
      },
      req.signal,
    );
    if (req.signal.aborted) throw abortError();

    settled.forEach((result, i) => {
      const repo = targets[i];
      const p = progress.get(repo.id)!;
      if (result.status === "fulfilled") {
        const records = countRecords(result.value);
        p.fetched += records;
        const commits = req.history ? parseHistory(result.value, repo.id, req.history.path) : parseLog(result.value, repo.id);
        // The selected branches it was walked from (ref: walks its own revisions instead).
        if (branches.length && search.refs.length === 0) for (const c of commits) c.ref = p.refs?.map((r) => r.replace(/^refs\/(heads|remotes|tags)\//, "")).join(", ");
        p.pending.push(...commits);
        if (records < wanted[i]) p.exhausted = true;
      } else {
        // Stop reading it, but keep the commits already fetched for it: they are still true.
        p.exhausted = true;
        failures.push({ repoId: repo.id, name: repo.name, reason: result.reason instanceof Error ? result.reason.message : String(result.reason) });
      }
    });

    const rows = topology ? takeTopoReady(progress, topology) : takeReady(progress);
    const done = [...progress.values()].every((p) => p.exhausted && p.pending.length === 0);
    if (rows.length > 0 || done) return { rows, failures, state: { now, progress, historyPaths, ...(topology ? { topology } : {}) }, done, branchUse: branchUse() };
  }
  return { rows: [], failures, state: { now, progress, historyPaths, ...(topology ? { topology } : {}) }, done: false, branchUse: branchUse() };
}

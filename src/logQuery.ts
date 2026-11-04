import type { RunOptions } from "./git";
import {
  followUnion, hasOtherAuthors, historyArgs, historyInput, historyPathsArgs, logArgs, parseFollow, selectRepos, selectedBranches, type FileFollow, type FilterState,
} from "./filterModel";
import { fetchHashPage } from "./hashSearch";
import { countRecords, parseHistory, parseLog } from "./gitLog";
import { copyTopoState, takeReady, takeTopoReady, type RepoProgress, type TopoMergeState } from "./mergeStream";
import { abortError, runPool } from "./pool";
import { planSearch, runnable, searchRepos, searchSkips } from "./searchQuery";
import { isSha, type Commit, type Repo, type RepoFailure } from "./types";

export type RunGit = (cwd: string, args: string[], signal: AbortSignal, opts?: RunOptions) => Promise<string>;

export interface QueryState {
  /** Fixed at the first page so --since does not drift while paging. */
  now: number;
  progress: Map<string, RepoProgress>;
  /** File history: its commits and every name the file has had, learned on the first page. */
  follow?: FileFollow;
  topology?: TopoMergeState;
  /**
   * Each repository's last record read, the one at --skip minus one: the next read asks for it
   * again, and a different commit there means its history moved since (see fetchPage).
   */
  tails?: Map<string, string>;
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
  /**
   * A first page read as deep as an earlier one of the same list: each repository's records, at
   * once. A list read again (after a fetch, or when history moved) keeps the rows it showed.
   */
  depth?: ReadonlyMap<string, number>;
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
  /**
   * Load More found history moved under the list (a commit, a reset, a fetch since it was read):
   * rows is the whole list again, from the top and a page deeper, not a page to append.
   */
  restarted?: boolean;
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
 * How deep a query read each repository: a first page read this deep lists the same rows again
 * (one record more where git had nothing left, so it still knows it has reached the end).
 */
export function depthOf(state: QueryState | null): Map<string, number> | undefined {
  return state ? new Map([...state.progress].map(([id, p]) => [id, p.exhausted ? p.fetched + 1 : p.fetched])) : undefined;
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
  // File history, first page: the commits `git log --follow` lists for the file and its name in
  // each (unfiltered walks), then the Log's filters choose among exactly those, page by page.
  let follow = req.prev?.follow;
  if (req.history && !follow) {
    const repo = byId.get(req.history.repoId);
    const p = repo && progress.get(repo.id);
    if (repo && p && (!branches.length || p.refs?.length)) {
      try {
        const path = req.history.path;
        const topo = req.filter.sort === "topo";
        const walk = async (tips: readonly (string | undefined)[]) => (await runPool(tips, req.concurrency, (ref, signal) => req.run(repo.root, historyPathsArgs(path, ref, topo), signal), req.signal))
          .map((result) => {
            if (result.status === "rejected") throw result.reason;
            return parseFollow(result.value, path);
          });
        // Follow each tip separately so a rename on one branch cannot hide another's old name: each
        // selected one. With none selected, one walk over every branch; git switches to an old name
        // on all of them at once, so when that walk went through a rename, each distinct tip is walked
        // on its own (one rev-parse, then one walk per tip). A file never renamed costs one walk.
        let walks = await walk(p.refs?.length ? p.refs : [undefined]);
        if (!p.refs?.length && walks[0].renamed) {
          const tips = [...new Set((await req.run(repo.root, ["rev-parse", "--branches", "--remotes", "HEAD"], req.signal)).split(/\r?\n/).filter(isSha))];
          if (tips.length > 1) walks = await walk(tips);
        }
        follow = followUnion(walks, path, topo);
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

  // --skip counts positions in git's walk, and the walk moves when history does (a commit, a reset,
  // a fetch): Load More asks each repository again for the last record it read, one before its
  // --skip, in the same git process. Only reads that continue an earlier page do.
  const tails = new Map(req.prev?.tails);
  const continuing = new Set(tails.keys());
  let moved = false;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const targets = [...progress]
      .filter(([, p]) => !p.exhausted && p.pending.length < req.pageSize)
      .map(([id]) => byId.get(id)!);
    const wanted = targets.map((repo) => {
      const p = progress.get(repo.id)!;
      return Math.max(batchSize(p.fetched, req.pageSize), p.fetched === 0 ? req.depth?.get(repo.id) ?? 0 : 0);
    });
    const overlap = targets.map((repo) => (continuing.delete(repo.id) && progress.get(repo.id)!.fetched > 0 ? 1 : 0));
    const settled = await runPool(
      targets,
      req.concurrency,
      async (repo, signal) => {
        const i = targets.indexOf(repo);
        await resolveRef(repo, signal);
        const p = progress.get(repo.id)!;
        // A repository without a selected branch has nothing to show. With ref: too, both hold:
        // it needs a selected branch, and walks ref:'s revisions (logArgs).
        if (branches.length && !p.refs?.length) return "";
        const o = { pageSize: wanted[i] + overlap[i], now, cursor: { skip: p.fetched - overlap[i] }, me: req.me?.get(repo.id), refs: p.refs, search };
        // A file with no commits has nothing to list: git log --stdin given none would list HEAD.
        if (req.history) return follow?.commits.size ? req.run(repo.root, historyArgs(req.filter, { ...o, paths: follow.names, walkOrder: follow.walkOrder }), signal, { input: historyInput(follow) }) : "";
        return req.run(repo.root, logArgs(req.filter, o), signal);
      },
      req.signal,
    );
    if (req.signal.aborted) throw abortError();

    settled.forEach((result, i) => {
      const repo = targets[i];
      const p = progress.get(repo.id)!;
      if (result.status === "fulfilled") {
        let records = countRecords(result.value);
        let commits = req.history ? parseHistory(result.value, repo.id, req.history.path, follow?.commits) : parseLog(result.value, repo.id);
        if (overlap[i]) {
          // Another commit there: rows above it came or went, and --skip would repeat or pass some.
          if (commits[0]?.sha !== tails.get(repo.id)) { moved = true; return; }
          commits = commits.slice(1);
          records--;
        }
        p.fetched += records;
        // Known only when every record parsed: then the last commit is the last record.
        if (records > 0) {
          if (commits.length === records) tails.set(repo.id, commits[records - 1].sha);
          else tails.delete(repo.id);
        }
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
    if (moved && req.prev) {
      // The list again from the top, each repository a batch deeper than it was read: the rows it
      // showed stay listed (and selected), the new ones join, nothing twice. A first page never
      // continues an earlier one, so this happens once.
      const depth = new Map([...req.prev.progress].map(([id, p]) => [id, p.fetched + batchSize(p.fetched, req.pageSize)]));
      return { ...(await fetchPage({ ...req, prev: null, now, depth })), restarted: true };
    }

    const rows = topology ? takeTopoReady(progress, topology) : takeReady(progress);
    const done = [...progress.values()].every((p) => p.exhausted && p.pending.length === 0);
    const state: QueryState = { now, progress, follow, ...(topology ? { topology } : {}), tails };
    if (rows.length > 0 || done) return { rows, failures, state, done, branchUse: branchUse() };
  }
  return { rows: [], failures, state: { now, progress, follow, ...(topology ? { topology } : {}), tails }, done: false, branchUse: branchUse() };
}

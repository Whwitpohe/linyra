import type { Commit } from "./types";

/** One repository's place in the merged log for the life of one query. */
export interface RepoProgress {
  /** Records consumed from git's walk so far — the next page's --skip. */
  fetched: number;
  /** Fetched but not shown yet: held back by the horizon. */
  pending: Commit[];
  /** git returned a short page: nothing more to fetch. */
  exhausted: boolean;
  /** Selected local/remote refs this repo has; resolved once per query. [] means no match. */
  refs?: string[];
}

/**
 * Newest first; equal times by repository. Within one repository a tie is left to git's order
 * (sorts are stable): a child and its parent made in the same second would otherwise swap.
 */
export function compareCommits(a: Commit, b: Commit): number {
  if (a.time !== b.time) return b.time - a.time;
  return a.repoId < b.repoId ? -1 : a.repoId > b.repoId ? 1 : 0;
}

/**
 * Moves every pending commit at or above the horizon into the returned rows,
 * newest first. The horizon is the highest "oldest pending commit" among
 * repositories that may still have unfetched history: nothing below it can be
 * shown yet, or that history could later land above it. Rows below the horizon
 * stay pending — held, never dropped — so a commit with a skewed clock sinks to
 * its date instead of truncating its repository.
 */
export function takeReady(progress: ReadonlyMap<string, RepoProgress>): Commit[] {
  let horizon = -Infinity;
  for (const p of progress.values()) {
    if (!p.exhausted && p.pending.length > 0) horizon = Math.max(horizon, p.pending.reduce((m, c) => Math.min(m, c.time), Infinity));
  }
  const rows: Commit[] = [];
  for (const p of progress.values()) {
    const held: Commit[] = [];
    for (const c of p.pending) (c.time >= horizon ? rows : held).push(c);
    p.pending = held;
  }
  return rows.sort(compareCommits);
}

export interface TopoPart {
  repoId: string;
  previous: Commit;
  length: number;
  /** The first parent resumes the mainline; other parents belong to the incoming side. */
  mainline?: string;
  incoming?: Set<string>;
}

/** Query-local continuation, carried across Load More without retaining a history index. */
export interface TopoMergeState { part?: TopoPart }

export function copyTopoState(state: TopoMergeState | undefined): TopoMergeState {
  const part = state?.part;
  return part ? { part: { ...part, ...(part.incoming ? { incoming: new Set(part.incoming) } : {}) } } : {};
}

function continuesPart(part: TopoPart, next: Commit): boolean {
  if (part.incoming) return next.sha !== part.mainline && part.incoming.has(next.sha);
  if (!part.previous.parents.includes(next.sha)) return false;
  const gap = Math.abs(part.previous.time - next.time);
  // Keep connected activity together, but release unrelated repositories after
  // long pauses. Merge-side paths remain attached to their merge regardless of age.
  return gap <= 3 * 86400 && (part.length < 20 || gap <= 4 * 3600);
}

function advancePart(part: TopoPart, commit: Commit): void {
  if (part.incoming) {
    part.incoming.delete(commit.sha);
    for (const parent of commit.parents) if (parent !== part.mainline) part.incoming.add(parent);
  } else if (commit.parents.length > 1) {
    part.mainline = commit.parents[0];
    part.incoming = new Set(commit.parents.slice(1));
  }
  part.previous = commit;
  part.length++;
}

/**
 * Merge connected topological parts, rather than comparing every commit's date.
 * Incoming paths stay immediately below their merge (including nested/octopus
 * merges); the first-parent mainline then competes with other parts by date.
 * Git still supplies each repo's topological walk, so no parent can move above a
 * child. A missing filtered ancestor ends a part instead of inventing an edge.
 */
export function takeTopoReady(progress: ReadonlyMap<string, RepoProgress>, state: TopoMergeState = {}): Commit[] {
  const rows: Commit[] = [];
  while (true) {
    let next: RepoProgress | undefined;
    const part = state.part;
    if (part) {
      const repo = progress.get(part.repoId);
      if (repo && !repo.pending.length && !repo.exhausted && (part.incoming ? part.incoming.size > 0 : part.previous.parents.length > 0)) return rows;
      if (repo?.pending.length && continuesPart(part, repo.pending[0])) next = repo;
      else state.part = undefined;
    }
    if (!next) {
      let repoId: string | undefined;
      for (const [id, repo] of progress) {
        if (!repo.exhausted && !repo.pending.length) return rows;
        if (repo.pending.length && (!next || compareCommits(repo.pending[0], next.pending[0]) < 0)) { next = repo; repoId = id; }
      }
      if (!next || repoId === undefined) { state.part = undefined; return rows; }
      state.part = { repoId, previous: next.pending[0], length: 0 };
    }
    const commit = next.pending.shift()!;
    advancePart(state.part!, commit);
    rows.push(commit);
  }
}

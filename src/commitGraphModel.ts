/** A topological page slower than this, in a repository without a commit-graph, earns the hint. */
export const SLOW_TOPO_MS = 1000;

/**
 * Whether to look for repositories without a commit-graph: only in topological order (which, without
 * one, walks a repository's whole history on every page), and only when a page was slow.
 */
export function wantsCommitGraphHint(sort: string | undefined, pageMs: number): boolean {
  return sort === "topo" && pageMs >= SLOW_TOPO_MS;
}

/** git's own paths for this repository's commit-graph (a single file, or a split chain). */
export const commitGraphPathArgs = (): string[] => ["rev-parse", "--git-path", "objects/info/commit-graph", "--git-path", "objects/info/commit-graphs/commit-graph-chain"];

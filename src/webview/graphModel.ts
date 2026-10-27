import { commitKey, type Commit } from "../types";
import { ACCENT_COUNT } from "./view";

export interface GraphRail {
  column: number;
  accent: number;
  targetKey?: string;
}

export interface GraphRow {
  node: GraphRail;
  incoming: boolean;
  through: GraphRail[];
  outgoing: GraphRail[];
  /** A dashed endpoint: the parent is filtered out or has not been loaded yet. */
  missing?: GraphRail;
}

export interface CommitGraph {
  rows: GraphRow[];
  columns: number;
}

/**
 * Lay out the actual parent edges without changing the log's date order. Each
 * frontier lane points to a later displayed commit. A skewed clock can place a
 * parent above its child: its edge is still drawn between those exact commits.
 * Keys include the repository, so identical hashes in different repos never join.
 */
export function layoutGraph(commits: readonly Commit[], accents: ReadonlyMap<string, number>): CommitGraph {
  const indexes = new Map(commits.map((c, i) => [commitKey(c), i]));
  const future = new Map<number, number[]>();
  const missing = new Set<number>();
  commits.forEach((c, i) => {
    for (const parent of new Set(c.parents)) {
      const j = indexes.get(commitKey({ repoId: c.repoId, sha: parent }));
      if (j === undefined) { missing.add(i); continue; }
      if (i === j) continue;
      const from = Math.min(i, j), to = Math.max(i, j);
      const neighbors = future.get(from) ?? [];
      if (!neighbors.includes(to)) neighbors.push(to);
      future.set(from, neighbors);
    }
  });
  const lanes: ({ target: number; repoId: string } & GraphRail | undefined)[] = [];
  const targets = new Map<number, { target: number; repoId: string } & GraphRail>();
  const free = () => {
    const i = lanes.findIndex((lane) => lane === undefined);
    return i < 0 ? lanes.length : i;
  };
  let columns = 0;
  const nextAccent = (repoId: string, reserve?: number): number => {
    const used = new Set(lanes.filter((lane) => lane?.repoId === repoId).map((lane) => lane!.accent));
    if (reserve !== undefined) used.add(reserve);
    const start = accents.get(repoId) ?? 0;
    for (let i = 0; i < ACCENT_COUNT; i++) if (!used.has((start + i) % ACCENT_COUNT)) return (start + i) % ACCENT_COUNT;
    return start;
  };
  const rows = commits.map((c, i): GraphRow => {
    const incoming = targets.get(i);
    const node = incoming ?? { column: free(), accent: nextAccent(c.repoId) };
    const through = lanes.filter((lane): lane is NonNullable<typeof lane> => lane !== undefined && lane.target !== i);
    if (incoming) { lanes[incoming.column] = undefined; targets.delete(i); }
    const outgoing = (future.get(i) ?? []).map((target) => {
      let lane = targets.get(target);
      if (!lane) {
        const continues = lanes[node.column] === undefined;
        lane = { target, repoId: c.repoId, targetKey: commitKey(commits[target]), column: continues ? node.column : free(), accent: continues ? node.accent : nextAccent(c.repoId, node.accent) };
        lanes[lane.column] = lane;
        targets.set(target, lane);
      }
      return lane;
    });
    const cut = missing.has(i) ? { column: lanes[node.column] === undefined ? node.column : free(), accent: node.accent } : undefined;
    columns = Math.max(columns, node.column + 1, ...outgoing.map((lane) => lane.column + 1), (cut?.column ?? -1) + 1);
    // The rows retain only shared rail descriptions, not a copy of every edge.
    while (lanes.length > 0 && lanes[lanes.length - 1] === undefined) lanes.pop();
    return { node, incoming: incoming !== undefined, through, outgoing, ...(cut ? { missing: cut } : {}) };
  });
  return { rows, columns };
}

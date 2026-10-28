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
 * Each row's parents as row indexes (undefined: not listed, or not loaded yet). Built once for a
 * list and extended when a page is appended, so paging deep does not re-read every row's keys.
 */
export interface ParentIndex {
  rows: readonly Commit[];
  parents: (number | undefined)[][];
  keys: Map<string, number>;
  /** Parents not listed yet, by key: the rows and parent slots waiting for them. */
  waiting: Map<string, [number, number][]>;
}

/** The same rows in the same order (an index built for one list serves an equal copy of it). */
export function sameRows(a: readonly Commit[], b: readonly Commit[]): boolean {
  return a.length === b.length && (a.length === 0 || (a[0] === b[0] && a[a.length - 1] === b[b.length - 1]));
}

/** The parent index of `rows`, extending `prev` when `rows` only appends to the rows it was built for. */
export function indexParents(rows: readonly Commit[], prev?: ParentIndex): ParentIndex {
  const extends_ = prev !== undefined && prev.rows.length > 0 && rows.length >= prev.rows.length
    && rows[0] === prev.rows[0] && rows[prev.rows.length - 1] === prev.rows[prev.rows.length - 1];
  const index: ParentIndex = extends_
    ? { rows, parents: prev!.parents, keys: prev!.keys, waiting: prev!.waiting }
    : { rows, parents: [], keys: new Map(), waiting: new Map() };
  for (let i = index.parents.length; i < rows.length; i++) {
    const c = rows[i];
    const key = commitKey(c);
    index.keys.set(key, i);
    const waiting = index.waiting.get(key);
    if (waiting) {
      for (const [child, slot] of waiting) index.parents[child][slot] = i;
      index.waiting.delete(key);
    }
    index.parents.push(c.parents.map((sha, slot) => {
      const parentKey = commitKey({ repoId: c.repoId, sha });
      const j = index.keys.get(parentKey);
      if (j === undefined) {
        const list = index.waiting.get(parentKey);
        if (list) list.push([i, slot]); else index.waiting.set(parentKey, [[i, slot]]);
      }
      return j;
    }));
  }
  return index;
}

/**
 * Lay out the actual parent edges without changing the log's date order. Each
 * frontier lane points to a later displayed commit. A skewed clock can place a
 * parent above its child: its edge is still drawn between those exact commits.
 * Keys include the repository, so identical hashes in different repos never join.
 */
export function layoutGraph(commits: readonly Commit[], accents: ReadonlyMap<string, number>, index?: ParentIndex): CommitGraph {
  const parentRows = (index && sameRows(index.rows, commits) ? index : indexParents(commits)).parents;
  const future = new Map<number, number[]>();
  const missing = new Set<number>();
  commits.forEach((c, i) => {
    c.parents.forEach((sha, slot) => {
      if (c.parents.indexOf(sha) !== slot) return; // a parent listed twice is one edge
      const j = parentRows[i][slot];
      if (j === undefined) { missing.add(i); return; }
      if (i === j) return;
      const from = Math.min(i, j), to = Math.max(i, j);
      const neighbors = future.get(from) ?? [];
      if (!neighbors.includes(to)) neighbors.push(to);
      future.set(from, neighbors);
    });
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

import { commitKey, type Commit } from "../types";
import { indexParents, sameRows, type ParentIndex } from "./graphModel";

export interface LinearSegment {
  id: string;
  repoId: string;
  top: number;
  bottom: number;
  hidden: number[];
}

export interface FoldRow {
  /** Real index for a commit row; the first hidden index for a summary row. */
  sourceIndex: number;
  commit: Commit;
  segment?: LinearSegment;
}

export interface FoldProjection {
  rows: FoldRow[];
  sourceToDisplay: ReadonlyMap<number, number>;
  hiddenCount: number;
}

/**
 * Only contract complete, forward-ordered, one-parent/one-child paths. Heads,
 * tags, merges, forks, roots and unknown parents remain visible. Repository-qualified
 * keys prevent identical hashes in unrelated repositories from becoming one path.
 */
export function linearSegments(commits: readonly Commit[], index?: ParentIndex): LinearSegment[] {
  const parents = (index && sameRows(index.rows, commits) ? index : indexParents(commits)).parents;
  const children: number[][] = commits.map(() => []);
  parents.forEach((ps, i) => { for (const parent of new Set(ps)) if (parent !== undefined) children[parent].push(i); });
  const interior = commits.map((c, i) => c.parents.length === 1 && parents[i][0] !== undefined && parents[i][0]! > i
    && children[i].length === 1 && children[i][0] < i && !c.refs?.length);
  const segments: LinearSegment[] = [];
  commits.forEach((top, i) => {
    if (interior[i]) return;
    for (const parent of parents[i]) {
      if (parent === undefined || parent <= i || !interior[parent]) continue;
      const hidden: number[] = [];
      let next = parent;
      while (interior[next]) { hidden.push(next); next = parents[next][0]!; }
      // One hidden commit replaced with one summary row would save no room.
      if (hidden.length >= 2) segments.push({ id: JSON.stringify([top.repoId, top.sha, commits[parent].sha, commits[next].sha]),
        repoId: top.repoId, top: i, bottom: next, hidden });
    }
  });
  return segments;
}

/** Which path a node can collapse; a merge has several paths, so use its individual edges. */
export function segmentNodes(commits: readonly Commit[], segments: readonly LinearSegment[]): Map<number, string> {
  const nodes = new Map<number, string>();
  for (const segment of segments) {
    if (commits[segment.top].parents.length === 1) nodes.set(segment.top, segment.id);
    for (const index of segment.hidden) nodes.set(index, segment.id);
  }
  return nodes;
}

/**
 * A display-only projection: loaded commits and their selection identities never
 * change. Each summary occupies the first hidden row's position; interleaved
 * repositories keep their order. Real edges are redirected through the summary.
 */
export function projectFolds(commits: readonly Commit[], segments: readonly LinearSegment[], collapsed: ReadonlySet<string>): FoldProjection {
  const hidden = new Set<number>();
  const starts = new Map<number, LinearSegment>();
  const replacements = new Map<string, string>();
  for (const segment of segments) {
    if (!collapsed.has(segment.id)) continue;
    const sha = `fold:${segment.id}`;
    starts.set(segment.hidden[0], segment);
    for (const index of segment.hidden) { hidden.add(index); replacements.set(commitKey(commits[index]), sha); }
  }
  const rows: FoldRow[] = [];
  const sourceToDisplay = new Map<number, number>();
  commits.forEach((commit, i) => {
    const segment = starts.get(i);
    if (segment) rows.push({ sourceIndex: i, segment, commit: { ...commit, sha: `fold:${segment.id}`,
      parents: [...commits[segment.hidden[segment.hidden.length - 1]].parents], refs: undefined } });
    if (hidden.has(i)) return;
    sourceToDisplay.set(i, rows.length);
    rows.push({ sourceIndex: i, commit });
  });
  for (const row of rows) {
    const parents = row.commit.parents.map((sha) => replacements.get(commitKey({ repoId: row.commit.repoId, sha })) ?? sha);
    if (parents.some((sha, i) => sha !== row.commit.parents[i])) row.commit = { ...row.commit, parents };
  }
  return { rows, sourceToDisplay, hiddenCount: hidden.size };
}

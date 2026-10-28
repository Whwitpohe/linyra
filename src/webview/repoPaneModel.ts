// The Repositories pane's selection logic. It only edits the Log's repo filter
// (null = every repo); git does the filtering. Narrowing the pane's own list by
// name is UI, not commit filtering.

import { activeProfiles, type ResolvedProfile } from "../profileModel";
import type { Repo } from "../types";

export const DEFAULT_REPO_PANE_WIDTH = 190;
const MIN_WIDTH = 120;
const MAX_WIDTH = 480;
/** Room the Log always keeps beside the pane. */
const MIN_LOG_WIDTH = 300;

export function pickOnly(id: string): string[] {
  return [id];
}

export function isChecked(repoIds: readonly string[] | null, id: string): boolean {
  return repoIds === null || repoIds.includes(id);
}

/** Tick or untick one repo; ticking every repo again means All (null). */
export function toggleRepo(repoIds: readonly string[] | null, id: string, allIds: readonly string[]): string[] | null {
  const selected = new Set(repoIds ?? allIds);
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  const ordered = allIds.filter((x) => selected.has(x));
  return ordered.length === allIds.length ? null : ordered;
}

const BOUNDARY = new Set(["-", "_", ".", "/", " "]);

/**
 * Fuzzy match, like VS Code's Quick Open: the query's letters must appear in
 * order; runs of consecutive letters, word starts and a prefix score higher.
 * Tries every alignment (tiny DP), so "svc1" prefers the "1" that starts a word.
 */
export function fuzzyMatch(query: string, text: string): { score: number; positions: number[] } | null {
  const q = query.trim().toLowerCase();
  const t = text.toLowerCase();
  if (!q) return { score: 0, positions: [] };
  const charScore = (j: number, consecutive: boolean) =>
    1 + (consecutive ? 5 : 0) + (j === 0 || BOUNDARY.has(t[j - 1]) ? 4 : 0) + (j === 0 ? 3 : 0);
  // best[i][j]: best score with q[i] matched at t[j]; from[i][j]: where q[i-1] was.
  const best: number[][] = [];
  const from: number[][] = [];
  for (let i = 0; i < q.length; i++) {
    best.push(new Array(t.length).fill(-Infinity));
    from.push(new Array(t.length).fill(-1));
    for (let j = i; j < t.length; j++) {
      if (t[j] !== q[i]) continue;
      if (i === 0) {
        best[0][j] = charScore(j, false);
        continue;
      }
      for (let k = i - 1; k < j; k++) {
        if (best[i - 1][k] === -Infinity) continue;
        const s = best[i - 1][k] + charScore(j, k === j - 1);
        if (s > best[i][j]) {
          best[i][j] = s;
          from[i][j] = k;
        }
      }
    }
  }
  const last = q.length - 1;
  let end = -1;
  for (let j = 0; j < t.length; j++) if (best[last][j] > (end < 0 ? -Infinity : best[last][end])) end = j;
  if (end < 0 || best[last][end] === -Infinity) return null;
  const positions: number[] = [];
  for (let i = last, j = end; i >= 0; j = from[i][j], i--) positions.unshift(j);
  // Shorter names win ties, so "acme-web" beats "acme-web-legacy".
  return { score: best[last][end] - t.length * 0.01, positions };
}

/** Repos matching the pane's search, best match first; the empty query keeps workspace order. */
export function visibleRepos<T extends { name: string }>(repos: readonly T[], query: string): T[] {
  if (!query.trim()) return [...repos];
  return repos
    .map((r, i) => ({ r, i, m: fuzzyMatch(query, r.name) }))
    .filter((x): x is { r: T; i: number; m: { score: number; positions: number[] } } => x.m !== null)
    .sort((a, b) => b.m.score - a.m.score || a.i - b.i)
    .map((x) => x.r);
}

export function clampPaneWidth(width: number, total: number): number {
  if (!Number.isFinite(width)) return DEFAULT_REPO_PANE_WIDTH;
  const max = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, total - MIN_LOG_WIDTH));
  return Math.round(Math.min(max, Math.max(MIN_WIDTH, width)));
}

/**
 * The Repositories pane's width: what the user chose, and what fits right now. Resizing
 * (a narrow Log, or a collapse, which briefly leaves almost no room) changes only what is
 * shown, so the chosen width comes back when there is room for it again.
 */
export class PaneWidth {
  private wanted = DEFAULT_REPO_PANE_WIDTH;
  shown = DEFAULT_REPO_PANE_WIDTH;

  /** A drag, a key step or the saved layout: this becomes the user's width. */
  set(width: number, total: number): number {
    this.wanted = clampPaneWidth(width, Number.POSITIVE_INFINITY);
    return this.fit(total);
  }

  /** The webview resized. */
  fit(total: number): number {
    this.shown = clampPaneWidth(this.wanted, total);
    return this.shown;
  }
}

export type PaneRow =
  | { kind: "all" }
  | { kind: "profile"; profile: ResolvedProfile; active: boolean }
  | { kind: "repo"; id: string; name: string };

/**
 * The Repo List's rows: All, the profiles (not while searching repositories by name: the search
 * is for repositories), then the repositories. Saving the ticks as a profile is in the ⋯ menu and
 * the list's right-click, not a row: a row that came and went with every tick was noise.
 */
export function paneRows(repos: readonly Repo[], query: string, profiles: readonly ResolvedProfile[], repoIds: readonly string[] | null): PaneRow[] {
  const repoRows: PaneRow[] = visibleRepos(repos, query).map((r) => ({ kind: "repo", id: r.id, name: r.name }));
  if (query.trim()) return [{ kind: "all" }, ...repoRows];
  const allIds = repos.map((r) => r.id);
  const active = activeProfiles(profiles, repoIds, allIds);
  const rows: PaneRow[] = [{ kind: "all" }, ...profiles.map((profile): PaneRow => ({ kind: "profile", profile, active: active.includes(profile.name) }))];
  return [...rows, ...repoRows];
}

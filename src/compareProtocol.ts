// Messages between the Repositories view (a webview in the Linyra Compare tab) and the host.
import type { Duplicate, Pair } from "./compareModel";
import type { ChangeStatus } from "./types";

export type CompareMode = "files" | "commits";
export interface CompareTreeRow {
  id: string;
  kind: "folder" | "repo" | "file" | "commit" | "more";
  label: string;
  description: string;
  tooltip: string;
  contextValue: string;
  status?: ChangeStatus;
  same?: boolean;
  /** A merge of the two branches would leave this file conflicted. */
  conflict?: boolean;
  /** A file row's parts, drawn as the Changes view draws them: lines added and deleted (none: binary or new), a rename's old name, and a note (conflict, already on both, both, new, binary). */
  lines?: { added: number; deleted: number };
  oldPath?: string;
  note?: string;
  untracked?: boolean;
  /** A file's path in its repository: what the side's filter reads. */
  path?: string;
  children?: CompareTreeRow[];
  loaded?: boolean;
}
export interface CompareSidePage {
  type: "side";
  side: "left" | "right";
  key: string;
  description: string;
  message?: string;
  /** An empty side's way back, a link under its message: Hide Files Already on Both off, or Only Conflicts off. */
  emptyAction?: { kind: "showSame" | "showAll"; label: string };
  rows: CompareTreeRow[];
}
export interface CompareLayout {
  repositoriesWidth: number;
  leftWidth: number;
  leftHeight: number;
  sidesHeight: number;
  orientation: "auto" | "sideBySide" | "stacked";
}

export interface CRepoRow {
  repoId: string;
  name: string;
  accent: number;
  status: "differs" | "nobase" | "error";
  left: number;
  right: number;
  same: number;
  reason?: string;
  /** Behind its upstream: the right-click menu offers Pull. */
  behind: boolean;
  /** Files a merge of the two would leave conflicted (0: merges cleanly); undefined while it is checked; null when git cannot tell. */
  conflicts?: number | null;
  /** The names this repository uses ("develop-k → main"), when a side lists several. */
  names?: string;
}

/** Host → Repositories page. */
export type ReposHost =
  | CompareSidePage
  | { type: "focusSide"; side: "left" | "right" }
  | { type: "state"; pair: Pair | null; mode: CompareMode; recent: Pair[]; favorites: string[]; message?: string; hideSame?: boolean; onlyConflicts?: boolean; showLeft?: boolean; showRight?: boolean; layout?: CompareLayout }
  /**
   * message: the page shows it instead of the list (no pair, no ticks…). empty: the list's text when
   * it has no rows — only claims "the same files" once a read is done. pairKey: unfolded duplicates
   * belong to one pair (and side).
   */
  | { type: "repos"; reading: boolean; summary: string; rows: CRepoRow[]; missing: string[]; selected?: string; message?: string; empty?: string; pairKey: string }
  /** defaults: each remote's default branch (origin/HEAD), with how many repositories have one. */
  | { type: "branches"; names: { name: string; count: number }[]; remotes: string[]; defaults?: { name: string; count: number }[] }
  | { type: "dups"; repoId: string; items: Duplicate[] }
  /** Compare with… / Pick Branches…: open the Branch picker on this side. */
  | { type: "openPicker"; side: "left" | "right" };

/** Repositories page → host. */
export type ReposWebview =
  | { type: "sideReady" }
  | { type: "sideOpen" | "sideExpand"; side: "left" | "right"; id: string }
  | { type: "sideExpandAll"; side: "left" | "right" }
  /** The rows selected together on a side (Ctrl/Shift-click): Cherry-Pick takes them all. */
  | { type: "sideSelect"; side: "left" | "right"; ids: string[] }
  | { type: "onlyConflicts"; on: boolean }
  /** Merge ◀ into ▶… in every listed repository that merges cleanly and has ▶ checked out. */
  | { type: "merge" }
  /** Copy as Release Notes: every repository's ◀-only commits, as Markdown. */
  | { type: "releaseNotes" }
  | { type: "sideVisibility"; side: "left" | "right"; show: boolean }
  | { type: "hideSame"; hide: boolean }
  | { type: "layout"; layout: CompareLayout }
  | { type: "ready" }
  | { type: "pick"; pair: Pair }
  /** One side picked, the other still empty: the host keeps it (guidance, sides cleared). */
  | { type: "pending"; pair: Pair }
  | { type: "swap" }
  | { type: "mode"; mode: CompareMode }
  | { type: "refresh" }
  | { type: "select"; repoId: string }
  | { type: "favorite"; name: string }
  | { type: "wantBranches" }
  | { type: "wantDups"; repoId: string };

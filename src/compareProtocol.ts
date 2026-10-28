// Messages between the Repositories view (a webview in the Linyra Compare tab) and the host.
import type { Duplicate, Pair } from "./compareModel";
import type { ChangeStatus } from "./types";

export type CompareMode = "files" | "commits";
export interface CompareTreeRow {
  id: string;
  kind: "folder" | "file" | "commit" | "more";
  label: string;
  description: string;
  tooltip: string;
  contextValue: string;
  status?: ChangeStatus;
  same?: boolean;
  children?: CompareTreeRow[];
  loaded?: boolean;
}
export interface CompareSidePage {
  type: "side";
  side: "left" | "right";
  key: string;
  description: string;
  message?: string;
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
}

/** Host → Repositories page. */
export type ReposHost =
  | CompareSidePage
  | { type: "focusSide"; side: "left" | "right" }
  | { type: "state"; pair: Pair | null; mode: CompareMode; recent: Pair[]; favorites: string[]; message?: string; hideSame?: boolean; showLeft?: boolean; showRight?: boolean; layout?: CompareLayout }
  /**
   * message: the page shows it instead of the list (no pair, no ticks…). empty: the list's text when
   * it has no rows — only claims "the same files" once a read is done. pairKey: unfolded duplicates
   * belong to one pair (and side).
   */
  | { type: "repos"; reading: boolean; summary: string; rows: CRepoRow[]; missing: string[]; selected?: string; message?: string; empty?: string; pairKey: string }
  | { type: "branches"; names: { name: string; count: number }[]; remotes: string[] }
  | { type: "dups"; repoId: string; items: Duplicate[] }
  /** Compare with… / Pick Branches…: open the Branch picker on this side. */
  | { type: "openPicker"; side: "left" | "right" };

/** Repositories page → host. */
export type ReposWebview =
  | { type: "sideReady" }
  | { type: "sideOpen" | "sideExpand"; side: "left" | "right"; id: string }
  | { type: "sideExpandAll"; side: "left" | "right" }
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

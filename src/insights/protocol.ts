// Messages between the Insights tab and the extension host.
import type { ColorBy, InsightsRange, InsightsScope, InsightsTab } from "./range";
import type { TreeNodeMsg } from "./treemap";

export interface InsightsRepo { id: string; name: string; accent: number }

/** A commit as Visual History draws it. */
export interface BubbleCommit {
  repoId: string;
  sha: string;
  time: number;
  author: string;
  email: string;
  subject: string;
  added: number;
  deleted: number;
  files: number;
}

export interface ReadFailure { repoId: string; name: string; reason: string }

export interface HistoryData {
  /** The range's start (unix seconds); undefined: all of history. */
  since: number | undefined;
  now: number;
  commits: BubbleCommit[];
  /** Repositories with more commits in the range than were read (names). */
  truncated: string[];
  failures: ReadFailure[];
}

export type TreeTab = "files" | "commits";
export const isTreeTab = (v: unknown): v is TreeTab => v === "files" || v === "commits";

export interface TreeData {
  tab: TreeTab;
  /** The shown folder's keys below the scope's root (a repository's id, then folder names); [] is the root. */
  path: string[];
  /** The names to show for the scope's root and for each key of `path`. */
  crumbs: string[];
  node: TreeNodeMsg;
  /** Files: the file types holding the most bytes in scope, in color order (the rest is Other). */
  legend: { ext: string; value: number }[];
  /** Commits: the counts that start each heat step (hottest last). */
  heat: number[];
  /** Commits: the range read; Files: undefined. */
  since?: number;
  failures: ReadFailure[];
}

export type InsightsHostMessage =
  | { type: "init"; repos: InsightsRepo[]; ticked: string[]; scope: InsightsScope; range: InsightsRange; tab: InsightsTab; colorBy: ColorBy; platform: string }
  | { type: "history"; status: "loading" | "ready"; data?: HistoryData }
  | { type: "tree"; tab: TreeTab; status: "loading" | "ready"; data?: TreeData };

export type InsightsWebviewMessage =
  | { type: "ready" }
  | { type: "tab"; tab: InsightsTab }
  | { type: "scope"; scope: InsightsScope }
  | { type: "range"; range: InsightsRange }
  | { type: "colorBy"; colorBy: ColorBy }
  | { type: "refresh" }
  | { type: "reveal"; repoId: string; sha: string }
  | { type: "openFile"; repoId: string; path: string }
  | { type: "visualHistory"; repoId: string; path: string; folder: boolean }
  | { type: "drill"; tab: TreeTab; path: string[] };

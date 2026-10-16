import type { ResolvedProfile } from "./profileModel";
import type { FilterState } from "./filterModel";
import type { BranchUse } from "./logQuery";
import type { Commit, Repo, RepoFailure } from "./types";

/** The Log view's own layout: the Repositories pane's width and whether it is shown. */
export interface Layout {
  repoPaneWidth: number;
  groupByRepo: boolean;
}

/** Someone who committed recently, across the workspace (Author box suggestions). */
export interface AuthorName {
  name: string;
  email: string;
  count: number;
}

/** A branch name seen across the workspace, with how many repositories have it. */
export interface BranchName {
  name: string;
  count: number;
}

/** One repository on the Log's Uncommitted side. */
export interface WorkRow {
  repoId: string;
  /** "3 files · src/app.ts, src/new.ts, notes.md" */
  preview: string;
  meter: { added: number; modified: number; deleted: number };
  /** "1 staged" / "all staged", "2 new" */
  tags: string[];
  /** "edited 2m ago", or "" */
  edited: string;
  /** VS Code's Git has the repository open: its menu offers Commit…, Stage/Unstage All and Discard All Changes. */
  canStage: boolean;
  /** Something is staged (Unstage All), something is not (Stage All). */
  hasStaged: boolean;
  hasChanges: boolean;
}

/** Extension host → webview. */
export type HostMessage =
  | { type: "init"; repos: Repo[]; filter: FilterState; hasMe: boolean; layout: Layout; history: { repoName: string; path: string } | null; logMode?: "commits" | "uncommitted"; profiles: ResolvedProfile[] }
  | { type: "loading" }
  /** The uncommitted work behind the Log's switch. `known`: every repository was read (the badge shows a number). */
  | { type: "uncommitted"; known: boolean; totals: { files: number; repos: number; added: number; deleted: number }; rows: WorkRow[] }
  | { type: "page"; rows: Commit[]; append: boolean; failures: RepoFailure[]; done: boolean; now: number; branchUse?: BranchUse }
  /** Each repository's distance from its upstream (only those ahead or behind). */
  | { type: "sync"; byRepo: Record<string, { ahead: number; behind: number }> }
  /** Suggestions a box asked for (wantSuggestions). Its own message: it must not touch the filter. */
  | { type: "suggestions"; authors?: AuthorName[]; branches?: BranchName[] };

/** Webview → extension host. Every field is untrusted until validated. */
export type WebviewMessage =
  | { type: "ready" }
  | { type: "filter"; filter: FilterState }
  | { type: "loadMore" }
  | { type: "refresh" }
  | { type: "select"; repoId: string; sha: string }
  | { type: "openFirst"; repoId: string; sha: string }
  | { type: "layout"; repoPaneWidth: number }
  | { type: "exitHistory" }
  /** The Log's switch: Commits or Uncommitted. */
  | { type: "logMode"; mode: "commits" | "uncommitted" }
  /** A row on the Uncommitted side was selected: its files go to the Changes view. */
  | { type: "selectWork"; repoId: string }
  /** A suggestion box got focus for the first time: read its suggestions now, not at startup. */
  | { type: "wantSuggestions"; kind: "authors" | "branches" }
  | { type: "openSettings" }
  /** The Repo List's ＋ Save as profile… row. */
  | { type: "profileSave" };

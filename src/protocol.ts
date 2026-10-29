import type { ResolvedProfile } from "./profileModel";
import type { Branches, BranchSidebarState } from "./branchModel";
import type { FilterState } from "./filterModel";
import type { BranchUse } from "./logQuery";
import type { ChangeStatus, Commit, Repo, RepoFailure } from "./types";
import type { ChangesMessage, ChangesPage } from "./changesProtocol";
import type { ChangesLayout, ToolbarAction, ToolbarState } from "./toolbarModel";

/** The Log view's own layout: the Repositories pane's width and whether it is shown. */
export interface Layout {
  repoPaneWidth: number;
  groupByRepo: boolean;
  changesPaneWidth?: number;
  changesPaneHeight?: number;
  showChanges?: boolean;
  changesLayout?: ChangesLayout;
  /** View options (the Log's ⋯ menu), as in the JetBrains Log: bold my commits, dim commits not on HEAD, a hash column. */
  highlightMine?: boolean;
  highlightHead?: boolean;
  hashColumn?: boolean;
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

/** File History: the file's uncommitted change (the row above its commits), HEAD to the working tree. */
export interface HistoryWork {
  /** Its name in the working tree (a staged rename's new name). */
  path: string;
  oldPath?: string;
  status: ChangeStatus;
  untracked: boolean;
  staged: boolean;
  /** Staged, then changed again. */
  partlyStaged: boolean;
  /** null: binary; absent: not counted (an untracked file). */
  added?: number | null;
  deleted?: number | null;
}

/** Extension host → webview. */
export type HostMessage =
  | { type: "toolbar"; state: ToolbarState }
  | { type: "focusChanges" }
  | { type: "changesView"; message: ChangesPage | { type: "copied" } }
  | { type: "sidebarState"; state: BranchSidebarState }
  | { type: "branchTree"; repoId: string; data?: Branches; loading?: boolean; error?: string }
  | { type: "init"; repos: Repo[]; filter: FilterState; hasMe: boolean; /** Each repository's user.email (Highlight My Commits). */ me?: Record<string, string>; layout: Layout; history: { repoId: string; repoName: string; path: string } | null; logMode?: "commits" | "uncommitted"; profiles: ResolvedProfile[] }
  /** File History: the file's uncommitted change, or null (none, or no File History). */
  | { type: "historyWork"; work: HistoryWork | null }
  | { type: "loading" }
  /** Highlight Current Branch: the listed commits (commitKey) not reachable from their repository's HEAD. */
  | { type: "offHead"; keys: string[] }
  /** The uncommitted work behind the Log's switch. `known`: every repository was read (the badge shows a number). */
  | { type: "uncommitted"; known: boolean; totals: { files: number; repos: number; added: number; deleted: number }; rows: WorkRow[] }
  | { type: "page"; rows: Commit[]; append: boolean; failures: RepoFailure[]; done: boolean; now: number; branchUse?: BranchUse }
  /** Each repository's distance from its upstream (only those ahead or behind). */
  | { type: "sync"; byRepo: Record<string, { ahead: number; behind: number }> }
  /** Suggestions a box asked for (wantSuggestions). Its own message: it must not touch the filter. */
  | { type: "suggestions"; authors?: AuthorName[]; branches?: BranchName[] }
  /** Combined Changes: the host changed the Commit list's selection (Clear Selection). */
  | { type: "setSelection"; items: CommitRef[]; focus: CommitRef };

/** One commit of the Commit list. */
export interface CommitRef {
  repoId: string;
  sha: string;
}

/** Webview → extension host. Every field is untrusted until validated. */
export type WebviewMessage =
  | { type: "toolbarAction"; action: ToolbarAction }
  /** The repository colors the Log shows, after it separated neighbors (sent when they change). */
  | { type: "accents"; accents: Record<string, number> }
  | { type: "changesView"; message: ChangesMessage }
  | { type: "branchSidebar"; action: "state" | "load" | "refresh" | "select" | "favorite" | "stashShow"; repoId?: string; ref?: string; state?: BranchSidebarState }
  | { type: "ready" }
  | { type: "filter"; filter: FilterState }
  | { type: "loadMore" }
  | { type: "refresh" }
  | { type: "select"; repoId: string; sha: string }
  /** Combined Changes: two or more commits selected (Ctrl/⌘ or Shift). */
  | { type: "selectMany"; items: CommitRef[]; focus: CommitRef }
  | { type: "openFirst"; repoId: string; sha: string }
  | { type: "layout"; repoPaneWidth?: number; changesPaneWidth?: number; changesPaneHeight?: number; showChanges?: boolean; changesLayout?: ChangesLayout; highlightMine?: boolean; highlightHead?: boolean; hashColumn?: boolean }
  | { type: "exitHistory" }
  /** File History's uncommitted row: open the file's diff, HEAD to the working tree. */
  | { type: "openHistoryWork" }
  /** The Log's switch: Commits or Uncommitted. */
  | { type: "logMode"; mode: "commits" | "uncommitted" }
  /** A row on the Uncommitted side was selected: its files go to the Changes view. */
  | { type: "selectWork"; repoId: string }
  /** A suggestion box got focus for the first time: read its suggestions now, not at startup. */
  | { type: "wantSuggestions"; kind: "authors" | "branches" }
  | { type: "openSettings" }
  /** The Repo List's ＋ Save as profile… row. */
  | { type: "profileSave" };

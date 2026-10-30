import type { ChangesMode } from "./changeStats";
import type { ResolvedProfile } from "./profileModel";
import type { Branches, BranchSidebarState } from "./branchModel";
import type { FilterState } from "./filterModel";
import type { BranchUse } from "./logQuery";
import type { ChangeStatus, Commit, Repo, RepoFailure } from "./types";
import type { ChangesMessage, ChangesPage } from "./changesProtocol";
import type { ChangesLayout, ToolbarAction, ToolbarState } from "./toolbarModel";
import type { HoverDetail, MergeTarget } from "./hoverModel";
import type { KindCounts } from "./changeKinds";
import type { BranchStatus } from "./workingTree";
import type { RepoMark } from "./repoMarkModel";
import type { ColumnPrefs } from "./webview/logColumns";
import type { AcrossRow } from "./branchSheetModel";
import type { BranchSheetData, SheetAction } from "./branchSheetModel";
import type { PromptHostMessage } from "./promptPort";

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
  /** The Changes column's drawing (the column header): off, numbers, squares, bar or bipolar. */
  changesColumn?: ChangesMode;
  /** The column header's widths, hidden columns and date format (read back through logColumns.columnPrefs). */
  columns?: ColumnPrefs;
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
  /** "notes.md, src/app.ts, src/new.ts": the paths (how many: counts) */
  preview: string;
  /** Distinct files by kind (+3 ✎2 −1); the meter is drawn from it. */
  counts: KindCounts;
  /** The checked-out branch and its upstream, from the same git status. */
  branch?: BranchStatus;
  /** The last commit (a detached HEAD's pill names it); null before the first. */
  head: string | null;
  /** "1 staged" / "all staged", or nothing */
  tags: string[];
  /** "edited 2m ago", or "" */
  edited: string;
  /** The same edit as a time (ms), or null when not known: the Log's summary row shows it as the commits show theirs. */
  editedAt: number | null;
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
  /** A question asked where the user acted, a typed name's check, the host writing into its box (promptPort.ts, webview/ui/prompt.ts). */
  | PromptHostMessage
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
  /** Each repository's branch, its * + ! and a merge or rebase that stopped (repositories whose git dir was read). */
  | { type: "repoMarks"; byRepo: Record<string, RepoMark> }
  /** Suggestions a box asked for (wantSuggestions). Its own message: it must not touch the filter. */
  | { type: "suggestions"; authors?: AuthorName[]; branches?: BranchName[]; tags?: BranchName[] }
  /** Combined Changes: the host changed the Commit list's selection (Clear Selection). */
  | { type: "setSelection"; items: CommitRef[]; focus: CommitRef }
  /** Avatars of the authors on screen (email → data: URI), a batch at a time. reset: drop those sent before (the settings changed). */
  | { type: "avatars"; byEmail: Record<string, string>; reset?: boolean }
  /** The Changes column: [files, added, deleted] by repoId\0sha, a repository at a time (changeStatsReader.ts). */
  | { type: "stats"; byKey: Record<string, [number, number, number]> }
  /** The hover card's commit: its git show (or why it failed), whether Explain exists, and on the HEAD row its merge target. */
  | { type: "hoverDetail"; repoId: string; sha: string; detail?: HoverDetail; error?: string; explain?: boolean; target?: MergeTarget }
  /** The search box's ✨ toggle: linyra.ai.translateSearch is registered and Linyra AI is configured. */
  | { type: "aiSearchAvailable"; available: boolean }
  /** What Linyra AI made of an aiSearch: the operator query for the box, or why there is none. */
  | { type: "aiSearchResult"; text: string; query?: string; error?: string }
  /** A branch pill's sheet: the branch read (or gone, or why it could not be read). */
  | { type: "branchSheet"; repoId: string; ref: string; data?: BranchSheetData; missing?: true; error?: string; across?: AcrossRow[] }
  /** A pill's Show Branch Details (its right-click, the keyboard's way in): open its sheet, focused. */
  | { type: "branchSheetShow"; repoId: string; ref: string };

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
  /** now: Enter in the search box, run without the typing debounce. */
  | { type: "filter"; filter: FilterState; now?: boolean }
  | { type: "loadMore" }
  | { type: "refresh" }
  | { type: "select"; repoId: string; sha: string }
  /** Combined Changes: two or more commits selected (Ctrl/⌘ or Shift). */
  | { type: "selectMany"; items: CommitRef[]; focus: CommitRef }
  | { type: "openFirst"; repoId: string; sha: string }
  | { type: "layout"; repoPaneWidth?: number; changesPaneWidth?: number; changesPaneHeight?: number; showChanges?: boolean; changesLayout?: ChangesLayout; highlightMine?: boolean; highlightHead?: boolean; hashColumn?: boolean; changesColumn?: ChangesMode; columns?: ColumnPrefs }
  | { type: "exitHistory" }
  /** File History's uncommitted row: open the file's diff, HEAD to the working tree. */
  | { type: "openHistoryWork" }
  /** The Log's switch: Commits or Uncommitted. */
  | { type: "logMode"; mode: "commits" | "uncommitted" }
  /** A row on the Uncommitted side was selected: its files go to the Changes view. */
  | { type: "selectWork"; repoId: string }
  /** A suggestion box got focus for the first time: read its suggestions now, not at startup. */
  | { type: "wantSuggestions"; kind: "authors" | "branches" | "tags" }
  | { type: "openSettings" }
  /** The Repo List's ＋ Save as profile… row. */
  | { type: "profileSave" }
  /** The authors of the rows on screen, once they settle after a scroll (avatars are asked only for these). */
  | { type: "visibleAuthors"; authors: { email: string; repoId: string }[] }
  /** The commits on screen whose Changes cell has no stats yet, once the rows settle. */
  | { type: "wantStats"; commits: { repoId: string; sha: string }[] }
  /** The hover card was shown on a listed commit (the pointer rested on its row): read its detail. */
  | { type: "hover"; repoId: string; sha: string }
  /** The hover card closed: kill its read. */
  | { type: "hoverEnd" }
  /** A link in the hover card's footer. */
  | { type: "hoverAction"; action: "copySha" | "openOnRemote" | "compare" | "explain"; repoId: string; sha: string }
  /** A Log row's own button (webview/rowActions.ts): the checked-out commit's Undo Commit or Edit Commit Message. */
  | { type: "rowAction"; action: "undo" | "reword"; repoId: string; sha: string }
  /** A question asked in the Log (promptModel.ts) answered: the answer as the webview gives it (checked by the host), or none for cancelled. */
  | { type: "promptAnswer"; id: number; answer?: unknown }
  /** What is typed in an asked name, to be checked (the host answers with promptCheck). */
  | { type: "promptInput"; id: number; value: string }
  /** The button beside an asked name's box (✨) pressed, its switch as `on` (the host writes into the box: promptUpdate). */
  | { type: "promptExtra"; id: number; on: boolean }
  /** The Log's summary row of uncommitted work selected (webview/workSummary.ts): that work in the Changes view; repoId: a chip's, else the most recently edited. */
  | { type: "showWork"; repoId?: string }
  /** The summary row's Commit…: the Commit side bar, for that repository alone when one is named. */
  | { type: "commitWork"; repoId?: string }
  /** The search box's ✨ mode: plain words for linyra.ai.translateSearch to turn into a query. */
  | { type: "aiSearch"; text: string }
  /** The ✨ toggle while Linyra AI is not available: set it up. */
  | { type: "aiConfigure" }
  /** The branch sheet: opened on a pill's click, closed, or one of its buttons. */
  /** The Repo List's stopped-operation row: its buttons run the matching command (logView maps them). */
  | { type: "operation"; action: "resolve" | "continue" | "abort"; repoId: string }
  | { type: "branchSheet"; action: "open" | "close" | "copy" | SheetAction; repoId: string; ref: string };

import { localize } from "../i18n";
import { ColumnHeader, type HeaderState } from "./columnHeader";
import { DEFAULT_COLUMNS, columnPrefs } from "./logColumns";
import "./styles.css";
import "./changes/changes.css";
import { mountChanges, type SavedState } from "./changes/view";
import type { ChangesMessage } from "../changesProtocol";
import type { ResolvedProfile } from "../profileModel";
// Registers <vscode-checkbox> (VS Code Elements, MIT): the Repositories pane's boxes.
import "@vscode-elements/elements/dist/vscode-checkbox/index.js";
import { DEFAULT_FILTER, hashQuery, sameFilter, type FilterState } from "../filterModel";
import type { HistoryWork, HostMessage, WebviewMessage, WorkRow } from "../protocol";
import { HistoryChip, HistoryWorkRow, type HistoryTarget } from "./history";
import { commitKey, type Commit, type Repo, type RepoFailure } from "../types";
import { byId, setText } from "./dom";
import { EmptyView } from "./empty";
import { FilterBar } from "./filters";
import { CommitList, type Gesture } from "./list";
import { NoticeBar } from "./notices";
import { RepoPane } from "./repoPane";
import { applyGesture, keepListed, SELECTION_LIMIT, type Selection } from "./selectionModel";
import { accentOf, assignAccents, separateAdjacentAccents, branchUseLabel, repoColumnChars, countLabel, emptyState, escapeTarget, reselect, switchCount, type EmptyAction } from "./view";
import { renderWorkTotals, WorkList } from "./workList";
import { AvatarFeed } from "./avatars";
import { ChangesFeed } from "./changesColumn";
import { LogToolbar, type ViewOptions } from "./toolbar";
import { HoverCard } from "./hoverCard";
import { RowActions } from "./rowActions";
import { workSummary } from "./workSummary";
import { isoDay } from "./searchBox";
import { BranchSheetView } from "./branchSheet";
import { revealTarget, type Upstream } from "./refPills";
import { HostRoutes } from "./hostRoutes";
import { PanelLayout } from "./panelLayout";

const vscode = acquireVsCodeApi();
const post = (m: WebviewMessage): void => vscode.postMessage(m);
const changesEvents = new EventTarget();

/** A 25 ms query should never flash a skeleton. */
const SKELETON_DELAY_MS = 150;

const state = {
  repos: [] as Repo[],
  profiles: [] as ResolvedProfile[],
  filter: DEFAULT_FILTER as FilterState,
  history: null as HistoryTarget | null,
  rows: [] as Commit[],
  failures: [] as RepoFailure[],
  dismissed: false,
  done: true,
  loading: true,
  skeleton: false,
  selected: -1,
  /** Every selected commit (Combined Changes when there are several); `selected` is its focus row. */
  selection: { keys: [], focus: null, anchor: null } as Selection,
  /** A Ctrl/Shift click past the limit was refused: the footer says why. */
  overLimit: false,
  now: Math.floor(Date.now() / 1000),
};
/**
 * The summary row of uncommitted work is the selection (workSummary.ts): the Changes view shows
 * that work, of workRepo or the most recently edited repository, while the Commits side stays.
 */
let workSelected = false;
let workRepo: string | undefined;

const listEl = byId("list");
const searchEl = byId<HTMLInputElement>("search");
const moreEl = byId<HTMLButtonElement>("more");
const countEl = byId("count");
const branchUseEl = byId("branch-use");
/** Whether linear history can be folded or unfolded (the Graph column's menu). */
let folds = { canCollapse: false, canExpand: false };
const list = new CommitList(listEl, byId("rows"), (i, how) => gesture(i, how), openFirstFile, (stats) => {
  folds = { canCollapse: stats.available !== stats.collapsed, canExpand: stats.collapsed > 0 };
  refreshHeader();
  const count = byId("graph-fold-count");
  count.hidden = stats.hidden === 0;
  count.textContent = localize("{0} commits hidden", stats.hidden);
}, (next) => {
  accents = next;
  showAccents(next);
});
const avatars = new AvatarFeed(byId("rows"), (i) => state.rows[i], post, (changed) => list.redraw(changed));
/**
 * The column header (columnHeader.ts): each column's options run what the filter bar and the view
 * options already run; its widths, hidden columns and date format are view options too.
 */
const header = new ColumnHeader({
  sort: (order) => setFilter({ ...state.filter, sort: order === "topo" ? "topo" : undefined }),
  fold: (fold) => (fold === "collapse" ? list.collapseAll() : list.expandAll()),
  changes: (mode) => changeView({ changesColumn: mode }),
  hash: (shown) => changeView({ hashColumn: shown }),
  prefs: (columns) => changeView({ columns }),
  preview: (id, px) => list.previewColumn(id, px),
  focusSearch: () => searchEl.focus(),
  authorFilter: () => byId("author").click(),
  dateFilter: () => {
    const date = byId<HTMLSelectElement>("date");
    date.focus();
    // Opens the range's list where the browser allows it from here (a click's gesture).
    try { date.showPicker?.(); } catch { /* the focus is enough */ }
  },
});
listEl.insertBefore(header.el, byId("rows"));
function headerState(): HeaderState {
  const f = state.filter;
  return {
    history: !!state.history, sort: f.sort === "topo" ? "topo" : "date", folds, changes: view.changesColumn, hash: view.hashColumn,
    prefs: view.columns ?? DEFAULT_COLUMNS, authorFiltered: !!(f.mine || f.authors?.length || f.author), dateFiltered: (f.date ?? "all") !== "all",
    hashLookup: !!hashQuery(f.text),
  };
}
/** The header again with the same columns: a filter, the toolbar or the folds changed what it shows. */
function refreshHeader(): void {
  const layout = list.columns();
  if (layout) header.render(layout, headerState());
}
list.onLayout = (layout) => header.render(layout, headerState());
const limitEl = byId("limit");
const notices = new NoticeBar(byId("notices"), () => {
  state.dismissed = true;
  render();
});
const empty = new EmptyView(byId("empty"), runEmptyAction);
const filters = new FilterBar(setFilter, () => post({ type: "refresh" }), (kind) => post({ type: "wantSuggestions", kind }), {
  wip: () => setMode("uncommitted"),
  ai: (text) => post({ type: "aiSearch", text }),
  configureAi: () => post({ type: "aiConfigure" }),
  // The last searches, per workspace: the view's own state.
  history: {
    load: () => (vscode.getState() as { searchHistory?: unknown } | undefined)?.searchHistory,
    save: (list) => vscode.setState({ ...((vscode.getState() ?? {}) as object), searchHistory: list }),
  },
});
const repoPane = new RepoPane((repoIds) => setFilter({ ...state.filter, repoIds }), post);
const appEl = byId("app");
/** The commit hover card; a branch pill (in a row or the card) shows its branch in the Repo List. */
const hoverCard = new HoverCard(listEl, byId("rows"), { commit: (i) => list.commitAt(i), row: (i) => list.hoverRow(i) }, post);
new RowActions(byId("rows"), post);
const revealBranch = (repoId: string, ref: string) => {
  if (state.history) return; // the Repo List is locked during File History
  if (appEl.classList.contains("no-repos")) post({ type: "toolbarAction", action: "toggleRepos" });
  const { key, expand } = revealTarget(repoId, ref);
  repoPane.reveal(key, expand);
};
// A branch pill's click: the branch sheet in the Changes view's details area (it reveals the Repo List row too, on request).
const branchSheet = new BranchSheetView(post, {
  reveal: revealBranch,
  accent: (id) => accentOf(accents, id),
  repoName: (id) => state.repos.find((r) => r.id === id)?.name ?? id,
  selectCommit: (repoId, sha) => post({ type: "changesView", message: { type: "selectCommit", repoId, sha } }),
  mark: (repoId, ref) => list.markBranch(repoId, ref),
});
list.onRevealBranch = (repoId, ref) => branchSheet.open(repoId, ref);
list.onWork = (repoId) => {
  branchSheet.close();
  // A commit still settling from a held arrow key would replace the work: it is dropped.
  clearTimeout(pendingSelect);
  pendingSelect = undefined;
  pendingPost = undefined;
  select(-1, false);
  workSelected = true;
  workRepo = repoId;
  post({ type: "showWork", ...(repoId ? { repoId } : {}) });
  render();
};
list.onCommitWork = (repoId) => post({ type: "commitWork", ...(repoId ? { repoId } : {}) });
// The hover card's pills too: their commit's row selected and the sheet opened, as a pill in the row does
// (the Repo List when the row is not loaded).
const fullRef = (r: { kind: string; name: string }) => (r.kind === "local" ? `refs/heads/${r.name}` : r.kind === "remote" ? `refs/remotes/${r.name}` : r.kind === "tag" ? `refs/tags/${r.name}` : "");
const openSheetFor = (repoId: string, ref: string, focus: boolean) => {
  const i = state.rows.findIndex((c) => c.repoId === repoId && (c.refs ?? []).some((r) => fullRef(r) === ref));
  if (i < 0) { revealBranch(repoId, ref); return; }
  gesture(i, { kind: "click", ctrl: false, shift: false });
  branchSheet.open(repoId, ref, focus);
};
hoverCard.onReveal = (repoId, ref) => openSheetFor(repoId, ref, false);
/** Each repository's distance from its upstream: the checked-out branch's pill shows it. */
let upstream: Upstream = {};
/** The Log's switch: Commits (the Commit list) or Uncommitted (one row per repository with work). */
let mode: "commits" | "uncommitted" = "commits";
let work = { known: false, totals: { files: 0, repos: 0, added: 0, deleted: 0 }, rows: [] as WorkRow[] };
const tabs = { commits: byId<HTMLButtonElement>("mode-commits"), uncommitted: byId<HTMLButtonElement>("mode-work") };
const workCount = byId("work-count");
const workTotals = byId("work-totals");
const workEl = byId("worklist");
const workList = new WorkList(workEl, (repoId) => post({ type: "selectWork", repoId }));

function setMode(next: "commits" | "uncommitted", focus = false): void {
  if (next !== mode) {
    mode = next;
    post({ type: "logMode", mode: next });
    // Back on the Commits side with the summary row selected: its work again, not the commit the host kept.
    if (next === "commits" && workSelected) post({ type: "showWork", ...(workRepo ? { repoId: workRepo } : {}) });
  }
  for (const [k, el] of Object.entries(tabs)) {
    const on = k === mode;
    el.setAttribute("aria-selected", String(on));
    el.tabIndex = on ? 0 : -1;
  }
  if (focus) tabs[mode].focus();
  appEl.classList.toggle("work", mode === "uncommitted");
  workEl.hidden = mode !== "uncommitted";
  render();
}
tabs.commits.addEventListener("click", () => setMode("commits"));
tabs.uncommitted.addEventListener("click", () => setMode("uncommitted"));
// A tablist: ←/→ move between the two tabs.
for (const el of Object.values(tabs)) {
  el.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    setMode(mode === "commits" ? "uncommitted" : "commits", true);
  });
}
// File History: its chip in place of the switch, and the file's uncommitted row above its commits.
const historyChip = new HistoryChip(() => post({ type: "exitHistory" }));
const historyWorkRow = new HistoryWorkRow(byId("history-work"), () => post({ type: "openHistoryWork" }));
let historyWork: HistoryWork | null = null;
/** Where the Repo List and the changed files sit (panelLayout.ts). */
const panel = new PanelLayout({ post, changed: (mode) => toolbar.updateLayout(mode) });
/** View options, each repository's user.email, and the listed commits HEAD does not reach. */
let view: ViewOptions = { highlightMine: false, highlightHead: false, hashColumn: false, changesColumn: "bar", columns: DEFAULT_COLUMNS };
let me: Readonly<Record<string, string>> = {};
let offHead: ReadonlySet<string> = new Set();
const toolbar = new LogToolbar((action) => post({ type: "toolbarAction", action }), (layout) => panel.setMode(layout), (patch) => changeView(patch));
/** A view option changed (the ⋯ menu or the column header): saved by the host, the Log drawn again. */
function changeView(patch: Partial<ViewOptions>): void {
  view = { ...view, ...patch };
  toolbar.updateView(view);
  post({ type: "layout", highlightMine: patch.highlightMine, highlightHead: patch.highlightHead, hashColumn: patch.hashColumn, changesColumn: patch.changesColumn, columns: patch.columns });
  render();
  if (patch.changesColumn) applyChangesColumn();
  refreshHeader();
}
/** The Changes column asks for the stats of the rows on screen (changesColumn.ts); off, it asks nothing. */
const changesFeed = new ChangesFeed(byId("rows"), (i) => state.rows[i], post, (keys) => list.statsArrived(keys));
function applyChangesColumn(): void {
  changesFeed.enabled = view.changesColumn !== "off";
  if (changesFeed.enabled) changesFeed.refresh();
}
/**
 * Shared repo hues honor both the commit bands and the Repo List's own order. That order is the
 * unsearched list: typing in the Repo List's search box never recolors the Log.
 */
let accents: ReadonlyMap<string, number> = new Map();
let repoOrder: readonly string[] = [];
/** The hues last reported to the host, so Compare and the details color repositories as shown here. */
let reportedAccents = "";
function showAccents(next: ReadonlyMap<string, number>): void {
  repoPane.setAccents(next);
  const key = JSON.stringify([...next]);
  if (key === reportedAccents) return;
  reportedAccents = key;
  post({ type: "accents", accents: Object.fromEntries(next) });
}
let skeletonTimer: ReturnType<typeof setTimeout> | undefined;
let selectedKey: string | null = null;
/** Repositories with commits to pull (their rows' right-click offers Pull). */
let behind: ReadonlySet<string> = new Set();

moreEl.addEventListener("click", () => {
  if (state.loading) return;
  state.loading = true;
  render();
  post({ type: "loadMore" });
});

/** The host's messages that a part of the page owns (hostRoutes.ts); the switch below keeps the Log's. */
const routes = new HostRoutes();
for (const part of [repoPane, avatars, changesFeed, hoverCard, branchSheet, filters]) part.register(routes);
routes
  .on("toolbar", (m) => { toolbar.update(m.state); refreshHeader(); })
  .on("focusChanges", () => byId("file-tree").focus())
  .on("changesView", (m) => changesEvents.dispatchEvent(new MessageEvent("message", { data: m.message })))
  .on("branchSheetShow", (m) => openSheetFor(m.repoId, m.ref, true));
window.addEventListener("message", (e: MessageEvent<HostMessage>) => {
  const m = e.data;
  if (routes.dispatch(m)) return;
  switch (m.type) {
    case "init": {
      const previousNames = new Map(state.repos.map((repo) => [repo.id, repo.name]));
      if (m.repos.length !== state.repos.length || m.repos.some((repo) => previousNames.get(repo.id) !== repo.name)) {
        accents = assignAccents(m.repos);
      }
      if (m.repos.length !== repoOrder.length || m.repos.some((repo, i) => repo.id !== repoOrder[i])) repoOrder = m.repos.map((repo) => repo.id);
      // The same repositories keep their list: the names the rows draw are worked out from it again only for a change.
      if (JSON.stringify(m.repos) !== JSON.stringify(state.repos)) state.repos = m.repos;
      // +2: the chip's own padding, so a name that fits is never cut.
      appEl.style.setProperty("--repo-col", `${repoColumnChars(m.repos.map((r) => r.name)) + 2}ch`);
      state.filter = m.filter;
      filters.setRepos(m.repos.map((r) => r.name));
      filters.setMe(m.hasMe);
      filters.update(m.filter);
      state.profiles = m.profiles;
      repoPane.update(m.repos, m.filter.repoIds, m.profiles);
      showAccents(accents);
      repoPane.setFilter(m.filter);
      appEl.classList.toggle("no-repos", !m.layout.groupByRepo);
      // Only when the host changed the switch: a late init must not undo the user's click.
      if (m.logMode !== undefined && m.logMode !== mode) setMode(m.logMode);
      state.history = m.history;
      if (!m.history) historyWork = null;
      appEl.classList.toggle("history", !!m.history);
      // Locked during File History: out of the keyboard order too, not only the mouse's.
      byId("repo-pane").toggleAttribute("inert", !!m.history);
      panel.restore(m.layout);
      // The same identities and columns keep their objects: an init (a filter set by the host) does
      // not repaint every row.
      const nextMe = m.me ?? {};
      if (JSON.stringify(nextMe) !== JSON.stringify(me)) me = nextMe;
      const columns = columnPrefs(m.layout.columns);
      view = { highlightMine: m.layout.highlightMine === true, highlightHead: m.layout.highlightHead === true, hashColumn: m.layout.hashColumn === true, changesColumn: m.layout.changesColumn ?? "bar",
        columns: JSON.stringify(columns) === JSON.stringify(view.columns) ? view.columns : columns };
      toolbar.updateView(view);
      applyChangesColumn();
      break;
    }
    case "offHead":
      offHead = new Set(m.keys);
      break;
    case "historyWork":
      historyWork = m.work;
      break;
    case "uncommitted":
      work = { known: m.known, totals: m.totals, rows: m.rows };
      break;
    case "sync":
      repoPane.setSync(m.byRepo);
      upstream = m.byRepo;
      behind = new Set(Object.entries(m.byRepo).filter(([, ab]) => ab.behind > 0).map(([id]) => id));
      break;
    case "loading":
      state.loading = true;
      clearTimeout(skeletonTimer);
      skeletonTimer = setTimeout(() => {
        state.skeleton = true;
        render();
      }, SKELETON_DELAY_MS);
      break;
    case "setSelection": {
      // Clear Selection: the host went back to one commit and is showing it already.
      const keys = m.items.map(commitKey);
      const focus = commitKey(m.focus);
      workSelected = false;
      state.selection = { keys, focus, anchor: focus };
      state.selected = state.rows.findIndex((c) => commitKey(c) === focus);
      selectedKey = keys.length === 1 ? focus : null;
      break;
    }
    case "page":
      clearTimeout(skeletonTimer);
      state.loading = false;
      state.skeleton = false;
      state.now = m.now;
      branchUseEl.textContent = branchUseLabel(m.branchUse);
      state.done = m.done;
      if (m.append) {
        state.rows = state.rows.concat(m.rows);
        state.failures = m.failures.length > 0 ? state.failures.concat(m.failures) : state.failures;
      } else {
        state.failures = m.failures;
        state.dismissed = false;
        replaceRows(m.rows);
      }
      break;
  }
  render();
});

/** New rows for the list, keeping the selected commit (and the scroll) when it is still listed. */
function replaceRows(rows: Commit[]): void {
  // The summary row stays the selection across a reload: there is no commit to keep.
  if (workSelected) {
    state.rows = rows;
    state.selected = -1;
    return;
  }
  let prevKey = state.rows[state.selected] ? commitKey(state.rows[state.selected]) : null;
  if (state.selection.keys.length > 1) {
    // Combined Changes: the host keeps the commits still listed too, and re-reads what is left.
    const left = keepListed(state.selection, rows.map(commitKey));
    if (left.keys.length > 1) {
      state.rows = rows;
      state.selection = left;
      state.selected = rows.findIndex((c) => commitKey(c) === left.focus);
      return;
    }
    // One left: it stays selected, focused or not.
    if (left.focus !== null) prevKey = left.focus;
  }
  const next = reselect(prevKey, rows);
  const kept = prevKey !== null && next >= 0 && commitKey(rows[next]) === prevKey;
  state.rows = rows;
  if (!kept) list.resetScroll();
  select(next, false);
}

/** Selections closer together than this are a held arrow key: only where it stops is read. */
const RAPID_SELECT_MS = 100;
const SETTLE_SELECT_MS = 80;
let lastSelectAt = 0;
let pendingSelect: ReturnType<typeof setTimeout> | undefined;
let pendingPost: (() => void) | undefined;

function select(index: number, andRender = true): void {
  state.selected = index;
  const c = state.rows[index];
  const key = c ? commitKey(c) : null;
  // Another commit: its details, not the branch sheet.
  if (key !== selectedKey) branchSheet.close();
  state.selection = key ? { keys: [key], focus: key, anchor: key } : { keys: [], focus: null, anchor: null };
  if (c && key !== selectedKey) postSelect(c);
  selectedKey = key;
  if (andRender) render();
}

/** A click, key or right-click on a row: one commit as always, or several with Ctrl/⌘ and Shift. */
function gesture(index: number, how: Gesture): void {
  const c = state.rows[index];
  if (!c) return;
  workSelected = false;
  // A click on a row shows its commit's details (a pill's click opens the sheet right after this).
  branchSheet.close();
  const key = commitKey(c);
  const order = list.visibleCommitIndexes().map((i) => commitKey(state.rows[i]));
  const g = how.kind === "click" ? { kind: "click" as const, key, ctrl: how.ctrl, shift: how.shift }
    : how.kind === "arrow" ? { kind: "arrow" as const, key, shift: how.shift }
    : { kind: "context" as const, key };
  const { next, overLimit } = applyGesture(state.selection, g, order);
  state.overLimit = overLimit;
  if (overLimit) return render();
  // Back to one commit: the one left, not necessarily the row clicked (Ctrl-click removes it).
  if (next.keys.length <= 1) return select(state.rows.findIndex((c) => commitKey(c) === (next.focus ?? key)));
  state.selection = next;
  state.selected = state.rows.findIndex((c) => commitKey(c) === (next.focus ?? key));
  selectedKey = null; // a plain click on any of them is a new selection
  postSelectMany(next);
  render();
}

function postSelectMany(s: Selection): void {
  const ref = (k: string) => {
    const c = state.rows.find((r) => commitKey(r) === k)!;
    return { repoId: c.repoId, sha: c.sha };
  };
  const send = () => {
    pendingSelect = undefined;
    pendingPost = undefined;
    post({ type: "selectMany", items: s.keys.map(ref), focus: ref(s.focus ?? s.keys[0]) });
  };
  // Shift+↓ held down: only where it stops is read, as for one commit.
  const now = performance.now();
  const rapid = now - lastSelectAt < RAPID_SELECT_MS;
  lastSelectAt = now;
  clearTimeout(pendingSelect);
  if (!rapid) return send();
  pendingPost = send;
  pendingSelect = setTimeout(send, SETTLE_SELECT_MS);
}

/**
 * Tells the host about a new selection. The highlight moves at once; while selections keep
 * coming (holding ↓), the host's git show waits until they stop, instead of one per row.
 */
function postSelect(c: Commit): void {
  const now = performance.now();
  const rapid = now - lastSelectAt < RAPID_SELECT_MS;
  lastSelectAt = now;
  clearTimeout(pendingSelect);
  const send = () => {
    pendingSelect = undefined;
    pendingPost = undefined;
    post({ type: "select", repoId: c.repoId, sha: c.sha });
  };
  if (!rapid) return send();
  pendingPost = send;
  pendingSelect = setTimeout(send, SETTLE_SELECT_MS);
}

/** Enter: the host opens the selected commit's first text file in the editor area. */
function openFirstFile(): void {
  pendingPost?.(); // a selection still settling goes first
  const c = state.rows[state.selected];
  if (c) post({ type: "openFirst", repoId: c.repoId, sha: c.sha });
}

/** now: Enter in the search box, run without the host's typing debounce. */
function setFilter(f: FilterState, now = false): void {
  // A click on what is already shown: the panes still redraw (the Repo List's active row), the Log
  // and the host have nothing to do. Enter (now) runs the search again on purpose.
  const same = !now && sameFilter(f, state.filter);
  state.filter = f;
  filters.update(f);
  repoPane.update(state.repos, f.repoIds, state.profiles);
  repoPane.setFilter(f);
  refreshHeader();
  if (same) return;
  post({ type: "filter", filter: f, ...(now ? { now } : {}) });
  render();
}

function runEmptyAction(action: EmptyAction): void {
  const f = state.filter;
  switch (action) {
    case "clearText": setFilter({ ...f, text: "" }); return;
    case "clearAuthor": setFilter({ ...f, author: "", mine: false, authors: undefined }); return;
    case "allTime": setFilter({ ...f, date: "all", from: undefined, to: undefined }); return;
    case "clearPath": setFilter({ ...f, path: undefined }); return;
    case "allBranches": setFilter({ ...f, branch: "", branches: undefined }); return;
    case "selectAll": setFilter({ ...f, repoIds: null }); return;
    case "settings": post({ type: "openSettings" }); return;
  }
}

/**
 * The repositories' names and the selected keys, made again only when they change: the list
 * repaints its rows only when something they draw is new (a render for a badge leaves them).
 */
let names = new Map<string, string>();
let namesOf: typeof state.repos | undefined;
let selectedKeys: ReadonlySet<string> = new Set();
let keysOf: typeof state.selection.keys | undefined;

function render(): void {
  if (namesOf !== state.repos) { namesOf = state.repos; names = new Map(state.repos.map((r) => [r.id, r.name])); }
  const summary = workSummary({ mode, history: state.history !== null, work, filter: state.filter, today: isoDay(new Date()) });
  // The row went on the Commits side (everything committed, a search typed): the newest commit takes the selection back.
  if (workSelected && !summary && mode === "commits") {
    workSelected = false;
    workRepo = undefined;
    const first = list.visibleCommitIndexes()[0] ?? (state.rows.length > 0 ? 0 : undefined);
    if (first !== undefined) select(first, false);
  }
  if (keysOf !== state.selection.keys) { keysOf = state.selection.keys; selectedKeys = new Set(keysOf); }
  const count = switchCount(work.known, work.totals.files);
  setText(workCount, count);
  workCount.hidden = count === "";
  tabs.uncommitted.setAttribute("aria-label", count ? localize("Uncommitted, {0} {1}", count, localize(count === "1" ? "file" : "files")) : localize("Uncommitted"));
  renderWorkTotals(workTotals, mode === "uncommitted" ? work.rows : [], work.totals);
  const historyAccent = state.history ? accentOf(accents, state.history.repoId) : 0;
  historyChip.update(state.history, historyAccent);
  if (mode === "uncommitted") {
    const next = separateAdjacentAccents(work.rows, accents, repoOrder);
    if (next !== accents) {
      accents = next;
      showAccents(next);
    }
    workList.update(work.rows, names, accents, behind);
    empty.render(work.rows.length === 0 ? { title: localize("Nothing uncommitted"), body: localize("Nothing uncommitted in the ticked repositories.") } : null);
    return;
  }
  list.update({
    rows: state.rows, repoNames: names, accents, repoOrder, behind, upstream,
    me, highlightMine: view.highlightMine, offHead: view.highlightHead ? offHead : undefined, hashColumn: view.hashColumn,
    changes: view.changesColumn === "off" ? undefined : view.changesColumn, columns: view.columns,
    historyPath: state.history?.path,
    selected: state.selected, selectedKeys, now: state.now,
    skeleton: state.skeleton && state.rows.length === 0,
    work: summary, workSelected, workRepo,
  });
  historyWorkRow.update(state.history ? historyWork : null, historyAccent, listEl.style.getPropertyValue("--graph-width"));
  empty.render(!state.loading && state.rows.length === 0 ? emptyState({ repoCount: state.repos.length, filter: state.filter, history: state.history?.path }) : null);
  notices.render(state.dismissed ? [] : state.failures);
  moreEl.hidden = state.done || state.rows.length === 0;
  moreEl.disabled = state.loading;
  setText(countEl, state.rows.length > 0 ? countLabel(state.rows.length) : "");
  setText(limitEl, state.overLimit ? localize("Combined Changes shows up to {0} commits", SELECTION_LIMIT) : "");
}

document.addEventListener("keydown", (e) => {
  const t = e.target;
  if (t instanceof Element && t.closest("#changes-pane")) return;
  const typing = t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement;
  const find = e.key.toLowerCase() === "f" && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
  if (find || (e.key === "/" && !typing)) {
    e.preventDefault();
    // The search box is hidden on the Uncommitted side; the Path box filters both.
    const box = mode === "uncommitted" ? byId<HTMLInputElement>("path") : searchEl;
    box.focus();
    box.select();
    return;
  }
  if (e.key !== "Escape") return;
  if (t === searchEl && searchEl.value !== "") {
    e.preventDefault();
    setFilter({ ...state.filter, text: "" });
    return;
  }
  if (t instanceof HTMLInputElement && t.id === "path" && t.value !== "") {
    e.preventDefault();
    t.value = "";
    t.removeAttribute("aria-invalid");
    setFilter({ ...state.filter, path: undefined });
    return;
  }
  byId(escapeTarget(mode)).focus();
});

mountChanges({
  viewId: "main",
  postMessage: (message: ChangesMessage) => post({ type: "changesView", message }),
  getState: () => (vscode.getState() as { changes?: SavedState } | undefined)?.changes,
  setState: (changes) => vscode.setState({ ...((vscode.getState() ?? {}) as object), changes }),
}, changesEvents);
panel.apply();
render();
post({ type: "ready" });

import { localize } from "../i18n";
import "./styles.css";
import "./changes/changes.css";
import { mountChanges, type SavedState } from "./changes/view";
import type { ChangesMessage } from "../changesProtocol";
import type { ResolvedProfile } from "../profileModel";
// Registers <vscode-checkbox> (VS Code Elements, MIT): the Repositories pane's boxes.
import "@vscode-elements/elements/dist/vscode-checkbox/index.js";
import { DEFAULT_FILTER, sameFilter, type FilterState } from "../filterModel";
import type { HistoryWork, HostMessage, WebviewMessage, WorkRow } from "../protocol";
import { HistoryChip, HistoryWorkRow, type HistoryTarget } from "./history";
import { commitKey, type Commit, type Repo, type RepoFailure } from "../types";
import { byId } from "./dom";
import { EmptyView } from "./empty";
import { FilterBar } from "./filters";
import { CommitList, type Gesture } from "./list";
import { NoticeBar } from "./notices";
import { RepoPane } from "./repoPane";
import { applyGesture, keepListed, SELECTION_LIMIT, type Selection } from "./selectionModel";
import { attachSplitter } from "./splitter";
import { PaneWidth } from "./repoPaneModel";
import { accentOf, assignAccents, separateAdjacentAccents, branchUseLabel, repoColumnChars, countLabel, emptyState, escapeTarget, reselect, switchCount, type EmptyAction } from "./view";
import { renderWorkTotals, WorkList } from "./workList";
import { AvatarFeed } from "./avatars";
import { ChangesFeed } from "./changesColumn";
import { LogToolbar, type ViewOptions } from "./toolbar";
import type { ChangesLayout } from "../toolbarModel";
import { HoverCard } from "./hoverCard";
import { revealTarget, type Upstream } from "./refPills";

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

const listEl = byId("list");
const searchEl = byId<HTMLInputElement>("search");
const moreEl = byId<HTMLButtonElement>("more");
const countEl = byId("count");
const branchUseEl = byId("branch-use");
const list = new CommitList(listEl, byId("rows"), (i, how) => gesture(i, how), openFirstFile, (stats) => {
  toolbar.setFolds({ canCollapse: stats.available !== stats.collapsed, canExpand: stats.collapsed > 0 });
  const count = byId("graph-fold-count");
  count.hidden = stats.hidden === 0;
  count.textContent = localize("{0} commits hidden", stats.hidden);
}, (next) => {
  accents = next;
  showAccents(next);
});
const avatars = new AvatarFeed(byId("rows"), (i) => state.rows[i], post, (changed) => list.redraw(changed));
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
const revealBranch = (repoId: string, ref: string) => {
  if (state.history) return; // the Repo List is locked during File History
  if (appEl.classList.contains("no-repos")) post({ type: "toolbarAction", action: "toggleRepos" });
  const { key, expand } = revealTarget(repoId, ref);
  repoPane.reveal(key, expand);
};
list.onRevealBranch = revealBranch;
hoverCard.onReveal = revealBranch;
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
const splitter = byId("splitter");
const paneWidth = new PaneWidth();
const workspace = byId("workspace");
const changesPane = byId("changes-pane");
const changesSplitter = byId("changes-splitter");
const changesVerticalSplitter = byId("changes-splitter-vertical");
const changesToggle = byId<HTMLButtonElement>("toggle-changes");
let changesWidth = 360;
let changesHeight = 240;
let showChanges = true;
let changesLayout: ChangesLayout = "auto";

function applyChangesLayout(): void {
  const stacked = changesLayout === "stacked" || (changesLayout === "auto" && workspace.clientWidth < 720) || workspace.clientWidth < 505;
  const size = stacked ? Math.max(96, Math.min(changesHeight, workspace.clientHeight - 160)) : Math.max(180, Math.min(changesWidth, workspace.clientWidth - 320));
  workspace.classList.toggle("stacked", stacked);
  workspace.classList.toggle("no-changes", !showChanges);
  workspace.style.setProperty("--changes-size", `${size}px`);
  changesPane.hidden = !showChanges;
  changesSplitter.hidden = !showChanges || stacked;
  changesVerticalSplitter.hidden = !showChanges || !stacked;
  // Its icon says what it shows (the changed files), not where they sit: beside the Repo List's
  // toggle, two mirrored layout icons read as one control.
  changesToggle.setAttribute("aria-pressed", String(showChanges));
  changesSplitter.setAttribute("aria-valuenow", String(size));
  changesVerticalSplitter.setAttribute("aria-valuenow", String(size));
  toolbar.updateLayout(changesLayout);
}
const saveChangesLayout = () => post({ type: "layout", repoPaneWidth: paneWidth.shown, changesPaneWidth: changesWidth, changesPaneHeight: changesHeight, showChanges, changesLayout });
/** View options, each repository's user.email, and the listed commits HEAD does not reach. */
let view: ViewOptions = { highlightMine: false, highlightHead: false, hashColumn: false, changesColumn: "bar" };
let me: Readonly<Record<string, string>> = {};
let offHead: ReadonlySet<string> = new Set();
const toolbar = new LogToolbar((action) => post({ type: "toolbarAction", action }), (layout) => { changesLayout = layout; applyChangesLayout(); saveChangesLayout(); }, (patch) => {
  if (patch.fold) { if (patch.fold === "collapse") list.collapseAll(); else list.expandAll(); return; }
  view = { ...view, ...patch };
  toolbar.updateView(view);
  post({ type: "layout", highlightMine: patch.highlightMine, highlightHead: patch.highlightHead, hashColumn: patch.hashColumn, changesColumn: patch.changesColumn });
  render();
  if (patch.changesColumn) applyChangesColumn();
});
/** The Changes column asks for the stats of the rows on screen (changesColumn.ts); off, it asks nothing. */
const changesFeed = new ChangesFeed(byId("rows"), (i) => state.rows[i], post, (keys) => list.statsArrived(keys));
function applyChangesColumn(): void {
  changesFeed.enabled = view.changesColumn !== "off";
  if (changesFeed.enabled) changesFeed.refresh();
}
changesToggle.addEventListener("click", () => { showChanges = !showChanges; applyChangesLayout(); saveChangesLayout(); });
attachSplitter(changesSplitter, {
  get: () => changesSplitter.getBoundingClientRect().left,
  set: (left) => { changesWidth = Math.max(180, Math.min(workspace.clientWidth - left - 5, workspace.clientWidth - 320)); applyChangesLayout(); },
  commit: saveChangesLayout,
});
attachSplitter(changesVerticalSplitter, {
  get: () => changesVerticalSplitter.getBoundingClientRect().top,
  set: (top) => { changesHeight = Math.max(96, Math.min(workspace.clientHeight - top - 5, workspace.clientHeight - 160)); applyChangesLayout(); },
  commit: saveChangesLayout,
}, "y");
new ResizeObserver(applyChangesLayout).observe(workspace);

function showPaneWidth(width: number): void {
  appEl.style.setProperty("--repo-pane-width", `${width}px`);
  splitter.setAttribute("aria-valuenow", String(width));
}
const applyPaneWidth = (width: number) => showPaneWidth(paneWidth.set(width, window.innerWidth));

// Drag (or ←/→) the divider; the width is saved by the host when the gesture ends.
attachSplitter(splitter, { get: () => paneWidth.shown, set: applyPaneWidth, commit: () => post({ type: "layout", repoPaneWidth: paneWidth.shown }) });
window.addEventListener("resize", () => showPaneWidth(paneWidth.fit(window.innerWidth)));
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

window.addEventListener("message", (e: MessageEvent<HostMessage>) => {
  const m = e.data;
  switch (m.type) {
    case "toolbar": toolbar.update(m.state); return;
    case "focusChanges": byId("file-tree").focus(); return;
    case "changesView": changesEvents.dispatchEvent(new MessageEvent("message", { data: m.message })); return;
    case "sidebarState": repoPane.applyBranchState(m.state); return;
    case "branchTree": repoPane.receiveBranches(m); return;
    case "avatars": avatars.receive(m.byEmail, m.reset); return;
    case "stats": changesFeed.receive(m.byKey); return;
    case "init": {
      const previousNames = new Map(state.repos.map((repo) => [repo.id, repo.name]));
      if (m.repos.length !== state.repos.length || m.repos.some((repo) => previousNames.get(repo.id) !== repo.name)) {
        accents = assignAccents(m.repos);
      }
      if (m.repos.length !== repoOrder.length || m.repos.some((repo, i) => repo.id !== repoOrder[i])) repoOrder = m.repos.map((repo) => repo.id);
      state.repos = m.repos;
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
      applyPaneWidth(m.layout.repoPaneWidth);
      changesWidth = m.layout.changesPaneWidth ?? changesWidth;
      changesHeight = m.layout.changesPaneHeight ?? changesHeight;
      showChanges = m.layout.showChanges ?? true;
      changesLayout = m.layout.changesLayout ?? "auto";
      applyChangesLayout();
      me = m.me ?? {};
      view = { highlightMine: m.layout.highlightMine === true, highlightHead: m.layout.highlightHead === true, hashColumn: m.layout.hashColumn === true, changesColumn: m.layout.changesColumn ?? "bar" };
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
    case "hoverDetail": hoverCard.receive(m); return;
    case "sync":
      repoPane.setSync(m.byRepo);
      upstream = m.byRepo;
      behind = new Set(Object.entries(m.byRepo).filter(([, ab]) => ab.behind > 0).map(([id]) => id));
      break;
    case "suggestions":
      if (m.authors) filters.setAuthors(m.authors);
      if (m.branches) filters.setBranches(m.branches);
      if (m.tags) filters.setTags(m.tags);
      return;
    case "aiSearchAvailable": filters.setAiAvailable(m.available); return;
    case "aiSearchResult": filters.aiResult(m); return;
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
  state.selection = key ? { keys: [key], focus: key, anchor: key } : { keys: [], focus: null, anchor: null };
  if (c && key !== selectedKey) postSelect(c);
  selectedKey = key;
  if (andRender) render();
}

/** A click, key or right-click on a row: one commit as always, or several with Ctrl/⌘ and Shift. */
function gesture(index: number, how: Gesture): void {
  const c = state.rows[index];
  if (!c) return;
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
  toolbar.setCommitsShown(mode !== "uncommitted");
  if (namesOf !== state.repos) { namesOf = state.repos; names = new Map(state.repos.map((r) => [r.id, r.name])); }
  if (keysOf !== state.selection.keys) { keysOf = state.selection.keys; selectedKeys = new Set(keysOf); }
  const count = switchCount(work.known, work.totals.files);
  workCount.textContent = count;
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
    changes: view.changesColumn === "off" ? undefined : view.changesColumn,
    historyPath: state.history?.path,
    selected: state.selected, selectedKeys, now: state.now,
    skeleton: state.skeleton && state.rows.length === 0,
  });
  historyWorkRow.update(state.history ? historyWork : null, historyAccent, listEl.style.getPropertyValue("--graph-width"));
  empty.render(!state.loading && state.rows.length === 0 ? emptyState({ repoCount: state.repos.length, filter: state.filter, history: state.history?.path }) : null);
  notices.render(state.dismissed ? [] : state.failures);
  moreEl.hidden = state.done || state.rows.length === 0;
  moreEl.disabled = state.loading;
  countEl.textContent = state.rows.length > 0 ? countLabel(state.rows.length) : "";
  limitEl.textContent = state.overLimit ? localize("Combined Changes shows up to {0} commits", SELECTION_LIMIT) : "";
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
applyChangesLayout();
render();
post({ type: "ready" });

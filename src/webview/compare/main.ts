import { localize } from "../../i18n";
import "./compare.css";
import { ALL_REPOS, candidates, manyRepos, selectionIds, setRemoteNames, sideLabel, sideOf, type Duplicate, type Pair, type Side } from "../../compareModel";
import type { CompareMode, CompareLayout, CRepoRow, ReposHost, ReposWebview } from "../../compareProtocol";
import { byId, clear, h } from "../dom";
import { codicon, codiconElement } from "../codicons";
import { BranchPicker } from "./picker";
import { CompareTree } from "./sideTree";
import { attachSplitter } from "../splitter";

declare function acquireVsCodeApi(): { postMessage(m: ReposWebview): void };
const vscodeApi = acquireVsCodeApi();
const post = (m: ReposWebview) => vscodeApi.postMessage(m);
const sideTrees = { left: new CompareTree("left", post), right: new CompareTree("right", post) };
const workspace = byId("compare-workspace"), sidesElement = byId("compare-sides");
let layout: CompareLayout = { repositoriesWidth: 240, leftWidth: 480, leftHeight: 180, sidesHeight: 280, orientation: "auto" };
let showLeft = true, showRight = true, hideSame = true, onlyConflicts = false;
const repoSash = byId("compare-repo-splitter"), repoVerticalSash = byId("compare-repo-splitter-vertical");
const sideSash = byId("compare-side-splitter"), sideVerticalSash = byId("compare-side-splitter-vertical");

function applyLayout(): void {
  const stacked = layout.orientation === "stacked" || (layout.orientation === "auto" && workspace.clientWidth < 800) || workspace.clientWidth < 600;
  const sideStacked = workspace.clientWidth < 600;
  const anySide = showLeft || showRight;
  workspace.classList.toggle("stacked", stacked);
  workspace.classList.toggle("no-sides", !anySide);
  workspace.style.setProperty("--repositories-width", `${Math.max(160, Math.min(layout.repositoriesWidth, workspace.clientWidth - 365))}px`);
  workspace.style.setProperty("--sides-height", `${Math.max(120, Math.min(layout.sidesHeight, workspace.clientHeight - 110))}px`);
  sidesElement.classList.toggle("stacked", sideStacked);
  sidesElement.classList.toggle("one-side", !showLeft || !showRight);
  sidesElement.hidden = !anySide;
  byId("compare-left").hidden = !showLeft;
  byId("compare-right").hidden = !showRight;
  sidesElement.style.setProperty("--left-width", `${Math.max(100, Math.min(layout.leftWidth, sidesElement.clientWidth - 105))}px`);
  sidesElement.style.setProperty("--left-height", `${Math.max(80, Math.min(layout.leftHeight, sidesElement.clientHeight - 85))}px`);
  repoSash.hidden = stacked || !anySide;
  repoVerticalSash.hidden = !stacked || !anySide;
  sideSash.hidden = sideStacked || !showLeft || !showRight;
  sideVerticalSash.hidden = !sideStacked || !showLeft || !showRight;
  byId("compare-toggle-left").setAttribute("aria-pressed", String(showLeft));
  byId("compare-toggle-right").setAttribute("aria-pressed", String(showRight));
  byId("compare-layout-horizontal").setAttribute("aria-pressed", String(layout.orientation === "sideBySide"));
  byId("compare-layout-stacked").setAttribute("aria-pressed", String(layout.orientation === "stacked"));
  repoSash.setAttribute("aria-valuenow", String(Math.round(byId("repos").getBoundingClientRect().width)));
  sideSash.setAttribute("aria-valuenow", String(Math.round(byId("compare-left").getBoundingClientRect().width)));
  repoVerticalSash.setAttribute("aria-valuenow", String(Math.round(byId("repos").getBoundingClientRect().height)));
  sideVerticalSash.setAttribute("aria-valuenow", String(Math.round(byId("compare-left").getBoundingClientRect().height)));
}
const saveLayout = () => post({ type: "layout", layout });
attachSplitter(repoSash, { get: () => byId("repos").getBoundingClientRect().width, set: (width) => { layout.repositoriesWidth = Math.max(160, Math.min(width, workspace.clientWidth - 365)); applyLayout(); }, commit: saveLayout });
attachSplitter(repoVerticalSash, { get: () => repoVerticalSash.getBoundingClientRect().top, set: (top) => { layout.sidesHeight = Math.max(120, Math.min(workspace.getBoundingClientRect().bottom - top - 5, workspace.clientHeight - 110)); applyLayout(); }, commit: saveLayout }, "y");
attachSplitter(sideSash, { get: () => byId("compare-left").getBoundingClientRect().width, set: (width) => { layout.leftWidth = Math.max(100, Math.min(width, sidesElement.clientWidth - 105)); applyLayout(); }, commit: saveLayout });
attachSplitter(sideVerticalSash, { get: () => byId("compare-left").getBoundingClientRect().height, set: (height) => { layout.leftHeight = Math.max(80, Math.min(height, sidesElement.clientHeight - 85)); applyLayout(); }, commit: saveLayout }, "y");
new ResizeObserver(applyLayout).observe(workspace);

let pair: Pair | null = null;
let mode: CompareMode = "files";
let recent: Pair[] = [];
let favorites: string[] = [];
let names: { name: string; count: number }[] = [];
let rows: CRepoRow[] = [];
let selected: string | undefined;
let pickingSide: Side = "left";
/** What the list says when it has no rows (decided by the host, which knows whether a read is done). */
let empty: string | undefined;
let pairKey = "";
/** Repositories whose duplicates are unfolded, and what the host sent for them. */
const open = new Map<string, Duplicate[] | undefined>();

const list = byId("repo-list");
const otherSide = (side: Side): Side => (side === "left" ? "right" : "left");
const picker = new BranchPicker(byId("picker"), byId<HTMLInputElement>("picker-search"), byId("picker-items"), {
  pickPair: (p) => post({ type: "pick", pair: p }),
  setNames: (names) => setSide(pickingSide, names),
  favorite: (name) => post({ type: "favorite", name }),
  // Closed with this side picked and the other still empty: the other side's picker, next.
  closed: () => { if (pair?.[pickingSide] && !pair[otherSide(pickingSide)]) openPicker(otherSide(pickingSide)); },
});

const sideNames = (side: Side) => candidates(pair?.[side] ?? "");

/** A side's ticked names, in order (the picker stays open while they change). */
function setSide(side: Side, names: string[]): void {
  const value = sideOf(names);
  const other = pair?.[otherSide(side)] ?? "";
  const p = side === "left" ? { left: value, right: other } : { left: other, right: value };
  if (p.left && p.right) post({ type: "pick", pair: p });
  else {
    // A side is still empty: the host keeps the half pair (and its guidance).
    pair = p;
    renderState();
    if (p.left || p.right) post({ type: "pending", pair: p });
  }
}

/** Branch names are read when the picker first opens, and again after Refresh. */
let namesWanted = false;

function openPicker(side: Side): void {
  pickingSide = side;
  if (!namesWanted) {
    namesWanted = true;
    post({ type: "wantBranches" });
  }
  picker.open(byId(side === "left" ? "branch-left" : "branch-right"), sideNames(side));
}

byId("branch-left").addEventListener("click", () => openPicker("left"));
byId("branch-right").addEventListener("click", () => openPicker("right"));
byId("swap").addEventListener("click", () => post({ type: "swap" }));
byId("refresh").addEventListener("click", () => {
  namesWanted = false;
  post({ type: "refresh" });
});
byId("mode-files").addEventListener("click", () => post({ type: "mode", mode: "files" }));
byId("mode-commits").addEventListener("click", () => post({ type: "mode", mode: "commits" }));
byId("compare-hide-same").addEventListener("click", () => post({ type: "hideSame", hide: !hideSame }));
byId("compare-only-conflicts").addEventListener("click", () => post({ type: "onlyConflicts", on: !onlyConflicts }));
byId("compare-merge").addEventListener("click", () => post({ type: "merge" }));
byId("compare-release-notes").addEventListener("click", () => post({ type: "releaseNotes" }));
byId("compare-layout-horizontal").addEventListener("click", () => { layout.orientation = "sideBySide"; applyLayout(); saveLayout(); });
byId("compare-layout-stacked").addEventListener("click", () => { layout.orientation = "stacked"; applyLayout(); saveLayout(); });
for (const side of ["left", "right"] as const) {
  byId(`compare-toggle-${side}`).addEventListener("click", () => post({ type: "sideVisibility", side, show: side === "left" ? !showLeft : !showRight }));
}

list.addEventListener("click", (e) => {
  const twisty = (e.target as Element).closest<HTMLElement>("[data-twisty]");
  if (twisty) {
    const id = twisty.dataset.twisty!;
    if (open.has(id)) open.delete(id);
    else {
      open.set(id, undefined);
      post({ type: "wantDups", repoId: id });
    }
    renderRows();
    return;
  }
  const row = (e.target as Element).closest<HTMLElement>("[data-repo]");
  if (!row) return;
  const id = row.dataset.repo!;
  // Ctrl-click adds or removes a repository; Shift-click picks every one from the last clicked to it.
  if (id !== ALL_REPOS && (e.ctrlKey || e.metaKey || e.shiftKey)) pickMany(id, e.shiftKey);
  else select(id, true);
});
list.addEventListener("keydown", (e) => {
  // → / ← unfold and fold the selected repository's duplicates (the twisty, by keyboard).
  if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && selected) {
    const r = rows.find((x) => x.repoId === selected);
    if (!r || r.status !== "differs" || r.same === 0) return;
    e.preventDefault();
    if (e.key === "ArrowRight" && !open.has(r.repoId)) {
      open.set(r.repoId, undefined);
      post({ type: "wantDups", repoId: r.repoId });
    } else if (e.key === "ArrowLeft") open.delete(r.repoId);
    renderRows();
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
  e.preventDefault();
  const ids = entries();
  const i = ids.indexOf(anchor ?? selected ?? "");
  const to = e.key === "Home" ? 0 : e.key === "End" ? ids.length - 1 : i + (e.key === "ArrowDown" ? 1 : -1);
  const id = ids[Math.max(0, Math.min(ids.length - 1, to))];
  if (id) select(id, true);
});
// Shift-click picks rows, not their text.
list.addEventListener("mousedown", (e) => { if (e.shiftKey) e.preventDefault(); });

/** The repositories the selection holds (All repositories: none of them is picked on its own). */
function pickedIds(): string[] {
  if (!selected || selected === ALL_REPOS) return [];
  return selectionIds(selected) as string[];
}

/** Several repositories at once: Ctrl toggles one, Shift picks the range from the last clicked. */
function pickMany(id: string, range: boolean): void {
  const order = rows.map((r) => r.repoId);
  let ids: string[];
  if (range && anchor && order.includes(anchor)) {
    const [a, b] = [order.indexOf(anchor), order.indexOf(id)].sort((x, y) => x - y);
    ids = order.slice(a, b + 1);
  } else {
    const had = new Set(pickedIds());
    if (had.has(id) && had.size > 1) had.delete(id); else had.add(id);
    ids = order.filter((x) => had.has(x));
    anchor = id;
  }
  select(manyRepos(ids), false);
}

/** Selections sent and not yet echoed back by the host: an older echo must not undo a newer pick. */
let pendingSelects = 0;
/** The row last clicked on its own: where Shift-click and the arrow keys start. */
let anchor: string | undefined;

function select(repoId: string, single: boolean): void {
  if (single) anchor = repoId;
  if (repoId === selected) return;
  selected = repoId;
  pendingSelects++;
  renderRows();
  if (single) byId(`crepo-${entries().indexOf(repoId)}`)?.scrollIntoView({ block: "nearest" });
  post({ type: "select", repoId });
}

window.addEventListener("message", (e: MessageEvent<ReposHost>) => {
  const m = e.data;
  switch (m.type) {
    case "side": sideTrees[m.side].receive(m); return;
    case "focusSide": sideTrees[m.side].focus(); return;
    case "state":
      pair = m.pair;
      mode = m.mode;
      recent = m.recent;
      favorites = m.favorites;
      hideSame = m.hideSame ?? true;
      onlyConflicts = m.onlyConflicts ?? false;
      showLeft = m.showLeft ?? true;
      showRight = m.showRight ?? true;
      layout = m.layout ?? layout;
      applyLayout();
      picker.update(names, favorites, recent);
      renderState(m.message);
      return;
    case "branches":
      setRemoteNames(m.remotes);
      names = m.names;
      picker.update(names, favorites, recent, true, m.defaults ?? []);
      return;
    case "repos":
      rows = m.rows;
      // Our own picks come back one echo each; until the last one does, the page's choice stands.
      if (pendingSelects > 0 && m.selected !== undefined && (entries().includes(selected ?? "") || pickedIds().length > 1)) pendingSelects--;
      else selected = m.selected;
      empty = m.empty;
      // Unfolded duplicates belong to one pair and orientation: a new pair or a swap folds them.
      if (m.pairKey !== pairKey) open.clear();
      pairKey = m.pairKey;
      for (const id of [...open.keys()]) if (!rows.some((r) => r.repoId === id)) open.delete(id);
      byId("summary").textContent = m.summary;
      // Announced once the read is done, not every 80 ms while it runs.
      byId("summary").setAttribute("aria-busy", String(m.reading));
      renderState(m.message);
      renderMissing(m.missing);
      renderRows();
      renderConflictsButton();
      return;
    case "dups":
      if (open.has(m.repoId)) {
        open.set(m.repoId, m.items);
        renderRows();
      }
      return;
    case "openPicker":
      openPicker(m.side);
      return;
  }
});

function renderState(message?: string): void {
  byId("name-left").textContent = pair?.left ? sideLabel(pair.left) : localize("Pick a branch");
  byId("name-right").textContent = pair?.right ? sideLabel(pair.right) : localize("Pick a branch");
  const several = (side: string) => (candidates(side).length > 1 ? `\n${localize("Each repository uses the first of these it has")}` : "");
  byId("branch-left").title = `${localize("The branch to merge from")}${pair?.left ? `\n${sideLabel(pair.left)}${several(pair.left)}` : ""}`;
  byId("branch-right").title = `${localize("The branch it goes into")}${pair?.right ? `\n${sideLabel(pair.right)}${several(pair.right)}` : ""}`;
  byId("mode-files").setAttribute("aria-pressed", String(mode === "files"));
  byId("mode-commits").setAttribute("aria-pressed", String(mode === "commits"));
  // One control per setting: Files | Commits and Hide Files Already on Both apply to both sides,
  // so they live once in the toolbar (each side's header keeps only its own Collapse All).
  const hideButton = byId<HTMLButtonElement>("compare-hide-same");
  hideButton.disabled = mode !== "files";
  hideButton.title = localize(hideSame ? "Show Files Already on Both" : "Hide Files Already on Both");
  hideButton.setAttribute("aria-label", hideButton.title);
  hideButton.setAttribute("aria-pressed", String(hideSame));
  hideButton.innerHTML = codicon(hideSame ? "filter-filled" : "filter");
  renderConflictsButton();
  const msg = byId("message");
  msg.hidden = message === undefined;
  msg.textContent = message ?? "";
  list.hidden = byId("summary").hidden = message !== undefined;
}

/**
 * Show Only Conflicts: pressed while on, with how many files would conflict across the listed
 * repositories; off and grayed out when none would (it would change nothing).
 */
function renderConflictsButton(): void {
  const button = byId<HTMLButtonElement>("compare-only-conflicts");
  const files = rows.reduce((n, r) => n + (r.conflicts ?? 0), 0);
  button.disabled = mode !== "files" || (files === 0 && !onlyConflicts);
  button.title = mode !== "files" ? localize("Show Only Conflicts") : files === 0 && !onlyConflicts ? localize("No file would conflict")
    : localize(onlyConflicts ? "Show All Files" : "Show Only Conflicts");
  button.setAttribute("aria-label", button.title);
  button.setAttribute("aria-pressed", String(onlyConflicts));
  button.replaceChildren(codiconElement("warning"), ...(files > 0 ? [h("span", { class: "button-count" }, [String(files)])] : []));
}

function renderMissing(missing: string[]): void {
  const el = byId("missing");
  el.hidden = missing.length === 0 || !pair;
  if (!pair) return;
  byId("missing-title").textContent = localize("Missing a branch: {0} {1}", missing.length, localize(missing.length === 1 ? "repository" : "repositories"));
  const ul = byId("missing-list");
  clear(ul);
  for (const n of missing) ul.append(h("li", {}, [n]));
}
byId("missing-toggle").addEventListener("click", () => {
  const list = byId("missing-list"), toggle = byId("missing-toggle");
  list.hidden = !list.hidden;
  toggle.setAttribute("aria-expanded", String(!list.hidden));
  toggle.textContent = list.hidden ? "▸" : "▾";
});

/** The rows a selection can land on, in order: All repositories (two or more differ), then each repository. */
function entries(): string[] {
  const all = rows.filter((r) => r.status === "differs").length >= 2;
  return [...(all ? [ALL_REPOS] : []), ...rows.map((r) => r.repoId)];
}

/** A row's merge note: how many files would conflict, a check when it merges cleanly, a turning icon while it is checked, nothing when git cannot tell. */
function mergeNote(conflicts: number | null | undefined): HTMLElement | null {
  if (conflicts === undefined) return h("span", { class: "row-note checking", title: localize("Checking whether a merge would conflict…") }, [codiconElement("sync")]);
  if (conflicts === null) return null;
  return conflicts === 0
    ? h("span", { class: "row-note clean", title: localize("Merges cleanly") }, [codiconElement("pass")])
    : h("span", { class: "row-note conflict", title: localize("A merge would leave {0} conflicted", localize("{0} {1}", conflicts, localize(conflicts === 1 ? "file" : "files"))) }, [codiconElement("warning"), String(conflicts)]);
}

function renderRows(): void {
  clear(list);
  if (rows.length === 0 && empty) list.append(h("div", { class: "cempty", role: "presentation" }, [empty]));
  const ids = entries();
  if (ids[0] === ALL_REPOS) {
    const on = selected === ALL_REPOS;
    const differ = rows.filter((r) => r.status === "differs");
    const conflicted = differ.filter((r) => (r.conflicts ?? 0) > 0).length;
    list.append(h("div", { class: on ? "crepo all selected" : "crepo all", role: "option", id: "crepo-0", "aria-selected": String(on), "data-repo": ALL_REPOS,
      title: localize("Every repository whose files differ, in one tree") }, [
      h("span", { class: "twisty", "aria-hidden": "true" }), codiconElement("repo"),
      h("span", { class: "repo-name" }, [localize("All repositories")]),
      h("span", { class: "row-note" }, [String(differ.length)]),
      conflicted > 0 ? h("span", { class: "row-note conflict", title: localize("{0} with conflicts", conflicted) }, [codiconElement("warning"), String(conflicted)]) : null,
    ]));
  }
  const offset = ids[0] === ALL_REPOS ? 1 : 0;
  rows.forEach((r, n) => {
    const i = n + offset;
    const on = r.repoId === selected || pickedIds().includes(r.repoId);
    const dups = r.status === "differs" && r.same > 0;
    const unfolded = open.has(r.repoId);
    list.append(h("div", {
      class: on ? "crepo selected" : "crepo", role: "option", id: `crepo-${i}`, "aria-selected": String(on), "data-repo": r.repoId,
      title: r.status === "differs" ? localize("{0}: {1} only on {2}, {3} only on {4}, {5} on both (merges not counted)", r.name, r.left, pair?.left ?? "", r.right, pair?.right ?? "", r.same) : r.reason ?? r.name,
      "data-vscode-context": JSON.stringify({ webviewSection: "compareRepo", repoId: r.repoId, behind: r.behind, preventDefaultContextMenuItems: true }),
    }, [
      dups ? h("button", { class: "twisty", type: "button", tabindex: "-1", "data-twisty": r.repoId, "aria-expanded": String(unfolded), "aria-label": localize(unfolded ? "Collapse {0}" : "Expand {0}", r.name) }, [codiconElement(unfolded ? "chevron-down" : "chevron-right")]) : h("span", { class: "twisty", "aria-hidden": "true" }),
      h("span", { class: `repo-dot accent-${r.accent}`, "aria-hidden": "true" }),
      // A side with several names: which ones this repository uses, under its name.
      r.names ? h("span", { class: "repo-name two-line" }, [r.name, h("span", { class: "repo-names" }, [r.names])]) : h("span", { class: "repo-name" }, [r.name]),
      // Names only: commit counts mislead when the same change travels by cherry-pick (they are in the tooltip). The merge note says what matters.
      r.status === "differs" ? mergeNote(r.conflicts) : h("span", { class: r.status === "error" ? "row-note error" : "row-note" }, [r.status === "nobase" ? localize("no common history") : localize("git error")]),
    ]));
    if (unfolded) {
      const items = open.get(r.repoId);
      // Not options of the listbox: presentation rows, read with their repository.
      if (!items) list.append(h("div", { class: "dup", role: "presentation" }, [localize("Reading…")]));
      else for (const d of items) list.append(h("div", { class: "dup", role: "presentation", title: localize("The same change committed on each side (cherry-picked)") }, [
        h("span", { class: "same" }, ["="]), h("span", { class: "dup-subject" }, [d.subject]),
        d.left ? h("span", { class: "left mono" }, [`◀ ${d.left.slice(0, 7)}`]) : null,
        d.right ? h("span", { class: "right mono" }, [`▶ ${d.right.slice(0, 7)}`]) : null,
      ]));
    }
  });
  const i = ids.indexOf(selected ?? "");
  if (i >= 0) list.setAttribute("aria-activedescendant", `crepo-${i}`);
  else list.removeAttribute("aria-activedescendant");
}

renderState();
applyLayout();
post({ type: "ready" });
post({ type: "sideReady" });

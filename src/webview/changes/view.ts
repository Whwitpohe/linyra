import { localize } from "../../i18n";
import { detailHeight } from "../../changesPresentation";
import type { ChangeRow, ChangesMessage, ChangesPage, CommitDetails } from "../../changesProtocol";
import { byId, h } from "../dom";
import { codicon, codiconElement } from "../codicons";
import { attachSplitter } from "../splitter";
import { absoluteTime } from "../view";
import { changeLines, changeNote, changesFilter } from "./fileFilterModel";
import { containingBranches, referencePills } from "./referencePills";
import { FileTree, type RowParts } from "../ui/fileTree";
import { renderPill } from "../ui/pill";

export interface SavedState { detailHeight?: number; key?: string; collapsed?: string[]; detailsCollapsed?: boolean; fileFilter?: string }
export interface ChangesApi {
  viewId?: "main" | "editor";
  postMessage(message: ChangesMessage): void;
  getState(): SavedState | undefined;
  setState(state: SavedState): void;
}
export function mountChanges(api: ChangesApi, events: EventTarget = window): void {
  const post = (m: ChangesMessage) => api.postMessage(m);
  const saved = api.getState();
  const app = byId("changes");
  const treeToggle = byId<HTMLButtonElement>("changes-tree-toggle");
  const details = byId("commit-details");
  const splitter = byId("detail-splitter");
  const detailToggle = byId<HTMLButtonElement>("detail-toggle");
  const detailHeading = byId("detail-heading");
  const notice = byId("notice");
  const fileFilter = byId<HTMLInputElement>("file-filter");
  fileFilter.value = saved?.fileFilter ?? "";
  let page: ChangesPage | undefined;
  let key = saved?.key ?? "";
  let wantedHeight = saved?.detailHeight ?? 240;
  let detailsCollapsed = saved?.detailsCollapsed ?? false;
  let lastFocusId: string | undefined;
  const collapsedBranches = new Set<string>();
  const save = () => api.setState({ detailHeight: wantedHeight, key, collapsed: tree.closedIds, detailsCollapsed, fileFilter: fileFilter.value });
  const availableHeight = () => Math.max(0, app.clientHeight - detailHeading.offsetHeight);

  function resize(): void {
    const hasDetails = (page?.details.length ?? 0) > 0;
    detailHeading.hidden = !hasDetails;
    details.hidden = splitter.hidden = !hasDetails || detailsCollapsed;
    detailToggle.setAttribute("aria-expanded", String(!detailsCollapsed));
    detailToggle.title = localize(detailsCollapsed ? "Show commit details" : "Hide commit details");
    detailToggle.setAttribute("aria-label", detailToggle.title);
    const height = detailHeight(wantedHeight, availableHeight());
    app.style.setProperty("--detail-height", `${height}px`);
    splitter.setAttribute("aria-valuemin", String(detailHeight(0, availableHeight())));
    splitter.setAttribute("aria-valuemax", String(detailHeight(Infinity, availableHeight())));
    splitter.setAttribute("aria-valuenow", String(height));
    splitter.setAttribute("aria-valuetext", localize("Commit details: {0}px", height));
  }
  attachSplitter(splitter, {
    get: () => availableHeight() - detailHeight(wantedHeight, availableHeight()) - 6,
    set: (height) => {
      wantedHeight = detailHeight(availableHeight() - height - 6, availableHeight());
      resize();
    },
    commit: () => { document.body.classList.remove("resizing"); save(); },
  }, "y");
  splitter.addEventListener("pointerdown", (e) => { if (e.button === 0) document.body.classList.add("resizing"); });
  splitter.addEventListener("dblclick", () => { wantedHeight = 240; resize(); save(); });
  // The whole header folds the details, as a VS Code pane header does (the button's click reaches it too).
  detailHeading.addEventListener("click", () => { detailsCollapsed = !detailsCollapsed; resize(); save(); });
  new ResizeObserver(resize).observe(app);

  function icon(name: "copy", className: string): HTMLElement {
    return h("span", { class: className, "aria-hidden": "true" }, [codiconElement(name)]);
  }

  function context(node: ChangeRow): string {
    return JSON.stringify({ webviewSection: "changesRow", changesNodeId: node.id, changesViewId: api.viewId ?? "editor", viewItem: node.contextValue, preventDefaultContextMenuItems: true });
  }

  /** A row's parts: a file's name, old path, + − (or what it is: new, binary, staged) and letter; a folder's or repository's count. */
  function parts(node: ChangeRow): RowParts {
    if (node.kind !== "file") return { icon: node.kind === "repo" ? "repo" : "folder", label: node.label, description: node.description, title: node.tooltip, context: context(node) };
    return {
      icon: "file", label: node.label, status: node.unchanged ? undefined : node.status, untracked: node.untracked === true, letter: true, oldPath: node.oldPath,
      note: changeNote(node), lines: changeLines(node), title: node.tooltip, context: context(node),
    };
  }

  const tree = new FileTree<ChangeRow>({
    root: byId("file-tree"), idPrefix: "change-row", parts,
    isBranch: changesFilter.isBranch, isFile: changesFilter.isFile, filterText: changesFilter.text, remake: changesFilter.remake,
    // All Files: a folder with no changed file under it starts closed.
    startsClosed: (node) => node.collapsed === true,
    open: (node) => post({ type: "open", id: node.id }),
    // All Files reads a folder when it opens.
    opened: (node) => post({ type: "expand", id: node.id }),
    selectionChanged: (ids) => post({ type: "selection", ids }),
    closedChanged: () => save(),
    toggleButton: treeToggle,
    expandedAll: (searching) => { if (page?.allFiles && !searching) post({ type: "action", action: "expandAll" }); },
    refreshed: ({ searching, matched, total }) => {
      const count = byId("file-filter-count"), empty = byId("file-filter-empty");
      count.hidden = !searching;
      count.textContent = localize("{0} of {1} files", matched, total);
      empty.hidden = !searching || matched > 0 || !!page?.message;
      empty.textContent = localize("No files match “{0}”.", fileFilter.value.trim());
    },
  });
  tree.closedIds = saved?.collapsed ?? [];
  tree.bindFilter(fileFilter, save);
  document.addEventListener("keydown", (e) => {
    if (!(e.target instanceof Node) || !byId("changes-pane").contains(e.target)) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") { e.preventDefault(); fileFilter.focus(); fileFilter.select(); }
  });

  function renderDetail(commit: CommitDetails): HTMLElement {
    const copy = h("button", { class: "icon-button commit-copy", type: "button", title: localize("Copy Commit Message"), "aria-label": localize("Copy Commit Message") }, [icon("copy", "file-icon")]);
    copy.addEventListener("click", () => post({ type: "copy", sha: commit.sha, field: "message" }));
    const sha = h("button", { class: "sha", type: "button", title: `${localize("Copy Commit SHA")}\n${commit.sha}`, "aria-label": localize("Copy Commit SHA") }, [commit.sha.slice(0, 7)]);
    sha.addEventListener("click", () => post({ type: "copy", sha: commit.sha, field: "sha" }));
    // A parent hash selects that commit in the Log (the host says so when it is not loaded).
    const parents = (commit.parents ?? []).map((parent) => {
      const short = parent.slice(0, 7);
      const link = h("button", { class: "sha parent-sha", type: "button", title: `${localize("Select in the Log")}\n${parent}`,
        "aria-label": localize("Select parent commit {0} in the Log", short) }, [short]);
      link.addEventListener("click", () => post({ type: "selectCommit", repoId: commit.repoId, sha: parent }));
      return link;
    });
    const pills = referencePills(commit.refs ?? []).map((segments) => renderPill(segments));
    const containing = commit.containing && containingBranches(commit.refs ?? [], commit.containing);
    const branchList = h("div", { class: "containing-list" }, (containing?.pills ?? []).map((segments) => renderPill(segments)));
    const branchKey = `${commit.repoId}\0${commit.sha}`;
    branchList.hidden = collapsedBranches.has(branchKey);
    const toggleBranches = h("button", { class: "branches-toggle", type: "button", "aria-expanded": String(!branchList.hidden) }, [localize(branchList.hidden ? "Show" : "Hide")]);
    toggleBranches.addEventListener("click", () => {
      branchList.hidden = !branchList.hidden;
      if (branchList.hidden) collapsedBranches.add(branchKey);
      else collapsedBranches.delete(branchKey);
      toggleBranches.textContent = localize(branchList.hidden ? "Show" : "Hide");
      toggleBranches.setAttribute("aria-expanded", String(!branchList.hidden));
    });
    return h("article", { class: "commit", "data-vscode-context": JSON.stringify({ webviewSection: "commitDetails", repoId: commit.repoId, sha: commit.sha }) }, [
      h("div", { class: "commit-heading" }, [h("h2", { class: "commit-title" }, [commit.title]), copy]),
      commit.body ? h("pre", { class: "commit-body" }, [commit.body]) : null,
      h("div", { class: "commit-meta" }, [
        h("div", { class: "commit-info" }, [
          h("span", { class: `repo-marker accent-${commit.accent ?? 3}`, "aria-hidden": "true" }),
          h("span", { class: "commit-repo" }, [commit.repoName]), " · ", sha,
        ]),
        h("div", { class: "commit-byline" }, [
          h("span", { class: "commit-author" }, [commit.author]), " ",
          h("span", { class: "commit-email", title: commit.email }, [`<${commit.email}>`]), " · ",
          h("time", { class: "commit-date", datetime: new Date(commit.time * 1000).toISOString() }, [absoluteTime(commit.time)]),
        ]),
        parents.length ? h("div", { class: "commit-parents" }, [localize(parents.length > 1 ? "Parents:" : "Parent:"), " ", ...parents.flatMap((link, i) => i ? [" ", link] : [link])]) : null,
        pills.length ? h("div", { class: "commit-refs", "aria-label": localize("Commit references") }, pills) : null,
        containing ? h("div", { class: "containing-branches" }, [
          h("div", { class: "containing-heading" }, [containing.heading, containing.pills.length ? " " : null, containing.pills.length ? toggleBranches : null]),
          containing.pills.length ? branchList : null,
        ]) : null,
      ]),
    ]);
  }

  events.addEventListener("message", (event) => {
    const e = event as MessageEvent<ChangesPage | { type: "copied" }>;
    if (e.data.type === "copied") {
      byId("copy-status").textContent = localize("Copied");
      return;
    }
    if (e.data.type !== "changes") return;
    const changed = key !== e.data.key;
    page = e.data;
    const allFiles = byId<HTMLButtonElement>("changes-all-files");
    allFiles.title = localize(page.allFiles ? "Show Changed Files" : "Show All Files");
    allFiles.setAttribute("aria-label", allFiles.title);
    allFiles.setAttribute("aria-pressed", String(!!page.allFiles));
    allFiles.innerHTML = codicon("files");
    allFiles.disabled = page.details.length !== 1;
    byId<HTMLButtonElement>("changes-clear-selection").disabled = page.details.length < 2;
    for (const id of ["changes-copy-sha", "changes-copy-message", "changes-open-remote"]) byId<HTMLButtonElement>(id).disabled = page.details.length !== 1;
    if (page.details.length === 1) byId("changes-heading").setAttribute("data-vscode-context", JSON.stringify({ webviewSection: "commitDetails", repoId: page.details[0].repoId, sha: page.details[0].sha }));
    else byId("changes-heading").removeAttribute("data-vscode-context");
    if (changed) { key = page.key; tree.reset(); lastFocusId = undefined; details.scrollTop = 0; }
    byId("summary").textContent = page.description;
    notice.hidden = !page.message;
    notice.textContent = page.message ?? "";
    details.replaceChildren(...page.details.map(renderDetail));
    tree.setRoots(page.roots, page.searchRoots);
    // File History: its file, opened to and selected once.
    if (page.focusId && lastFocusId !== page.focusId) tree.reveal(page.focusId);
    lastFocusId = page.focusId;
    resize();
  });
  byId("changes-all-files").addEventListener("click", () => post({ type: "action", action: page?.allFiles ? "changedFiles" : "allFiles" }));
  byId("changes-clear-selection").addEventListener("click", () => post({ type: "action", action: "clearSelection" }));
  const more = byId<HTMLButtonElement>("changes-more"), menu = byId("changes-actions");
  const closeMenu = (focus = false) => { menu.hidden = true; more.setAttribute("aria-expanded", "false"); if (focus) more.focus(); };
  more.addEventListener("click", () => {
    if (!menu.hidden) return closeMenu();
    menu.hidden = false;
    more.setAttribute("aria-expanded", "true");
    const box = more.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(box.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(box.bottom + 3, innerHeight - menu.offsetHeight - 4))}px`;
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  });
  for (const [id, field] of [["changes-copy-sha", "sha"], ["changes-copy-message", "message"]] as const) byId(id).addEventListener("click", () => {
    closeMenu(true);
    if (page?.details.length === 1) post({ type: "copy", sha: page.details[0].sha, field });
  });
  byId("changes-open-remote").addEventListener("click", () => { closeMenu(true); post({ type: "action", action: "openOnRemote" }); });
  byId("changes-open-editor").addEventListener("click", () => { closeMenu(true); post({ type: "action", action: "openChangesEditor" }); });
  menu.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(); more.focus(); }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const items = [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      items[(index + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    }
  });
  const outsideMenu = (e: Event) => { if (!menu.hidden && !menu.contains(e.target as Node) && !more.contains(e.target as Node)) closeMenu(); };
  document.addEventListener("pointerdown", outsideMenu);
  document.addEventListener("focusin", outsideMenu);
  window.addEventListener("resize", () => closeMenu());
  post({ type: "ready" });
}

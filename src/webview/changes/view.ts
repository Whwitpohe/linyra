import { localize } from "../../i18n";
import { detailHeight } from "../../changesPresentation";
import type { ChangeRow, ChangesMessage, ChangesPage, CommitDetails } from "../../changesProtocol";
import { byId, h } from "../dom";
import { codicon, codiconElement } from "../codicons";
import { attachSplitter } from "../splitter";
import { absoluteTime, moveSelection } from "../view";
import { filterFiles } from "./fileFilterModel";
import { referencePills } from "./referencePills";
import { updateTreeToggle } from "../treeToggle";
import { renderLines } from "../ui/counts";
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
  const tree = byId("file-tree");
  const treeToggle = byId<HTMLButtonElement>("changes-tree-toggle");
  const details = byId("commit-details");
  const splitter = byId("detail-splitter");
  const detailToggle = byId<HTMLButtonElement>("detail-toggle");
  const detailHeading = byId("detail-heading");
  const notice = byId("notice");
  const fileFilter = byId<HTMLInputElement>("file-filter");
  fileFilter.value = saved?.fileFilter ?? "";
  const searchCollapsed = new Set<string>();
  const activeCollapsed = () => fileFilter.value.trim() ? searchCollapsed : collapsed;
  let page: ChangesPage | undefined;
  let key = saved?.key ?? "";
  let wantedHeight = saved?.detailHeight ?? 240;
  let detailsCollapsed = saved?.detailsCollapsed ?? false;
  let collapsed = new Set(saved?.collapsed ?? []);
  let selected = new Set<string>();
  let focused: string | undefined;
  let anchor: string | undefined;
  let rows: { node: ChangeRow; depth: number; parent?: string }[] = [];
  let seen = new Set<string>();
  let expandNewFolders = false;
  let lastFocusId: string | undefined;
  const elements = new Map<string, HTMLElement>();
  const collapsedBranches = new Set<string>();
  const save = () => api.setState({ detailHeight: wantedHeight, key, collapsed: [...collapsed], detailsCollapsed, fileFilter: fileFilter.value });
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

  // VS Code's own icons.
  const icons = { copy: "copy", twisty: "chevron-right", folder: "folder", file: "file" } as const;
  function icon(name: keyof typeof icons, className: string): HTMLElement {
    return h("span", { class: className, "aria-hidden": "true" }, [codiconElement(icons[name])]);
  }

  function fileIcon(node: ChangeRow): HTMLElement {
    const extension = node.label.split(".").pop()?.toLowerCase() ?? "";
    const label: Record<string, string> = { js: "JS", jsx: "JS", mjs: "JS", ts: "TS", tsx: "TS", vue: "V", json: "{}", css: "#", scss: "#", md: "M↓", html: "<>" };
    return label[extension] ? h("span", { class: `file-icon file-type-${extension}`, "aria-hidden": "true" }, [label[extension]]) : icon("file", "file-icon");
  }

  function context(node: ChangeRow): string {
    return JSON.stringify({ webviewSection: "changesRow", changesNodeId: node.id, changesViewId: api.viewId ?? "editor", viewItem: node.contextValue, preventDefaultContextMenuItems: true });
  }

  function paintSelection(reveal = false): void {
    for (const { node } of rows) {
      const el = elements.get(node.id)!;
      el.classList.toggle("selected", selected.has(node.id));
      el.classList.toggle("focused", node.id === focused);
      el.setAttribute("aria-selected", String(selected.has(node.id)));
    }
    const active = focused && elements.get(focused);
    if (active) {
      tree.setAttribute("aria-activedescendant", active.id);
      if (reveal) active.scrollIntoView({ block: "nearest" });
    } else tree.removeAttribute("aria-activedescendant");
    // A filtered folder represents only visible matches. Bulk file actions must not
    // expand that folder back to hidden files in the host's complete tree.
    const selectable = fileFilter.value.trim() ? new Set(rows.filter((r) => r.node.kind === "file").map((r) => r.node.id)) : undefined;
    post({ type: "selection", ids: [...selected].filter((id) => !selectable || selectable.has(id)) });
  }

  function renderTree(): void {
    const scrollTop = tree.scrollTop;
    const searching = fileFilter.value.trim() !== "";
    const filtered = filterFiles((searching ? page?.searchRoots : undefined) ?? page?.roots ?? [], fileFilter.value);
    byId("file-filter-count").hidden = !searching;
    byId("file-filter-count").textContent = localize("{0} of {1} files", filtered.matched, filtered.total);
    byId("file-filter-empty").hidden = !searching || filtered.matched > 0 || !!page?.message;
    byId("file-filter-empty").textContent = localize("No files match “{0}”.", fileFilter.value.trim());
    rows = [];
    elements.clear();
    const walk = (nodes: ChangeRow[], depth: number, parent?: string) => {
      for (const node of nodes) {
        rows.push({ node, depth, parent });
        if (node.children && !activeCollapsed().has(node.id)) walk(node.children, depth + 1, node.id);
      }
    };
    walk(filtered.roots, 1);
    const branches = rows.filter((row) => row.node.kind !== "file");
    updateTreeToggle(treeToggle, branches.length > 0, branches.some((row) => !activeCollapsed().has(row.node.id)));
    const visible = new Set(rows.map((r) => r.node.id));
    selected = new Set([...selected].filter((id) => visible.has(id)));
    if (focused && !visible.has(focused)) focused = undefined;
    if (anchor && !visible.has(anchor)) anchor = undefined;
    const fragment = document.createDocumentFragment();
    for (const { node, depth } of rows) {
      const folder = node.kind !== "file";
      const expanded = folder && !activeCollapsed().has(node.id);
      const el = h("div", { class: `tree-row${!node.unchanged && node.status ? ` change-${node.status}` : ""}`, id: `change-row-${elements.size}`, role: "treeitem", "aria-level": String(depth),
        "aria-expanded": folder ? String(expanded) : undefined, "data-node": encodeURIComponent(node.id),
        "data-vscode-context": context(node), title: node.tooltip });
      el.style.paddingLeft = `${8 + (depth - 1) * 14}px`;
      const twisty = folder ? h("button", { class: "twisty", tabindex: "-1", "data-toggle": "true", "aria-label": localize(expanded ? "Collapse {0}" : "Expand {0}", node.label) }, [icon("twisty", "")]) : h("span", { class: "twisty" });
      el.append(twisty, folder ? icon("folder", "folder-icon") : fileIcon(node), h("span", { class: "file-name" }, [node.label]));
      if (node.oldPath) el.append(h("span", { class: "old-path", title: node.oldPath }, [`← ${node.oldPath}`]));
      if (folder || node.combined || node.unchanged || node.untracked) {
        el.append(h("span", { class: "row-stats row-description" }, [node.description]));
      } else if (node.added !== null && node.added !== undefined) {
        const stats = h("span", { class: "row-stats" }, [
          node.staged ? h("span", { class: "row-description" }, [localize("staged")]) : null,
          renderLines(node.added, node.deleted ?? 0),
        ]);
        el.append(stats);
      } else el.append(h("span", { class: "row-stats row-description" }, [node.description]));
      if (!folder) el.append(h("span", { class: `status status-${node.status ?? ""}`, "aria-hidden": "true" }, [node.status ?? ""]));
      elements.set(node.id, el);
      fragment.append(el);
    }
    tree.replaceChildren(fragment);
    tree.scrollTop = scrollTop;
    paintSelection();
  }

  function toggle(node: ChangeRow): void {
    if (node.kind === "file") return;
    const closed = activeCollapsed();
    if (closed.has(node.id)) {
      closed.delete(node.id);
      post({ type: "expand", id: node.id });
    } else closed.add(node.id);
    save();
    renderTree();
  }

  function choose(id: string, range = false, additive = false): void {
    if (range) {
      const from = Math.max(0, rows.findIndex((r) => r.node.id === anchor));
      const to = rows.findIndex((r) => r.node.id === id);
      if (!additive) selected.clear();
      for (const r of rows.slice(Math.min(from, to), Math.max(from, to) + 1)) selected.add(r.node.id);
    } else {
      if (!additive) selected.clear();
      if (additive && selected.has(id)) selected.delete(id);
      else selected.add(id);
      anchor = id;
    }
    focused = id;
    paintSelection(true);
  }

  tree.addEventListener("click", (e) => {
    const el = (e.target as Element).closest<HTMLElement>("[data-node]");
    if (!el) return;
    const id = decodeURIComponent(el.dataset.node!);
    const node = rows.find((r) => r.node.id === id)!.node;
    tree.focus({ preventScroll: true });
    if ((e.target as Element).closest("[data-toggle]")) { focused = id; toggle(node); return; }
    choose(id, e.shiftKey, e.ctrlKey || e.metaKey);
    if (node.kind === "file" && !e.shiftKey && !e.ctrlKey && !e.metaKey) post({ type: "open", id });
    else if (node.kind !== "file" && !e.shiftKey && !e.ctrlKey && !e.metaKey) toggle(node);
  });
  tree.addEventListener("contextmenu", (e) => {
    const el = (e.target as Element).closest<HTMLElement>("[data-node]");
    if (!el) return;
    const id = decodeURIComponent(el.dataset.node!);
    if (!selected.has(id)) choose(id);
  });
  tree.addEventListener("keydown", (e) => {
    if (!rows.length) return;
    const index = Math.max(0, rows.findIndex((r) => r.node.id === focused));
    const row = rows[index];
    const next = moveSelection(e.key, index, rows.length, Math.max(1, Math.floor(tree.clientHeight / 25)));
    if (next !== null) { e.preventDefault(); choose(rows[next].node.id, e.shiftKey, e.ctrlKey || e.metaKey); return; }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (e.key === " ") choose(row.node.id, e.shiftKey, e.ctrlKey || e.metaKey);
      else if (row.node.kind !== "file") toggle(row.node);
      else post({ type: "open", id: row.node.id });
    } else if (e.key === "ArrowRight" && row.node.kind !== "file") {
      e.preventDefault();
      if (activeCollapsed().has(row.node.id)) toggle(row.node);
      else if (rows[index + 1]?.parent === row.node.id) choose(rows[index + 1].node.id);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (row.node.kind !== "file" && !activeCollapsed().has(row.node.id)) toggle(row.node);
      else if (row.parent) choose(row.parent);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      selected = new Set(rows.map((r) => r.node.id));
      paintSelection();
    }
  });
  treeToggle.addEventListener("click", () => {
    const collapse = treeToggle.dataset.action === "collapse";
    expandNewFolders = !collapse;
    if (collapse) {
      const walk = (nodes: ChangeRow[]) => nodes.forEach((node) => { if (node.kind !== "file") { activeCollapsed().add(node.id); walk(node.children ?? []); } });
      walk(fileFilter.value.trim() ? page?.searchRoots ?? page?.roots ?? [] : page?.roots ?? []);
    } else activeCollapsed().clear();
    renderTree();
    save();
    if (!collapse && page?.allFiles && !fileFilter.value.trim()) post({ type: "action", action: "expandAll" });
  });

  fileFilter.addEventListener("input", () => { searchCollapsed.clear(); tree.scrollTop = 0; renderTree(); save(); });
  fileFilter.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && fileFilter.value) {
      e.preventDefault();
      fileFilter.value = "";
      searchCollapsed.clear();
      renderTree();
      save();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const first = rows.find((r) => r.node.kind === "file");
      if (first) { choose(first.node.id); tree.focus(); post({ type: "open", id: first.node.id }); }
    }
  });
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
    const branches = commit.containingBranches;
    const branchList = h("div", { class: "containing-list" }, (branches ?? []).map((branch) => h("div", {}, [branch])));
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
        branches ? h("div", { class: "containing-branches" }, [
          h("div", { class: "containing-heading" }, [localize("In {0} branches:", branches.length), " ", branches.length ? toggleBranches : null]),
          branchList,
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
    if (changed) { key = page.key; expandNewFolders = false; collapsed = new Set(); searchCollapsed.clear(); seen = new Set(); selected.clear(); focused = undefined; anchor = undefined; lastFocusId = undefined; tree.scrollTop = 0; details.scrollTop = 0; }
    const defaults = (nodes: ChangeRow[]) => nodes.forEach((n) => { if (!expandNewFolders && !seen.has(n.id) && n.collapsed) collapsed.add(n.id); seen.add(n.id); if (n.children) defaults(n.children); });
    defaults(page.roots);
    byId("summary").textContent = page.description;
    notice.hidden = !page.message;
    notice.textContent = page.message ?? "";
    details.replaceChildren(...page.details.map(renderDetail));
    const reveal = !!page.focusId && lastFocusId !== page.focusId;
    if (reveal) {
      const expandParents = (nodes: ChangeRow[]): boolean => nodes.some((n) => {
        if (n.id === page!.focusId) return true;
        if (n.children && expandParents(n.children)) { collapsed.delete(n.id); return true; }
        return false;
      });
      expandParents(page.roots);
    }
    renderTree();
    if (reveal) {
      for (const { node } of rows) if (node.id === page.focusId) { selected = new Set([node.id]); focused = anchor = node.id; paintSelection(true); }
    }
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

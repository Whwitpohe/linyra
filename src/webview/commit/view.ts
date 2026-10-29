import { localize } from "../../i18n";
import type { CommitRow } from "../../commitModel";
import type { CommitHostMessage, CommitState, CommitWebviewMessage } from "../../commitProtocol";
import { codiconElement } from "../codicons";
import { byId, h } from "../dom";
import { attachSplitter } from "../splitter";
import { updateTreeToggle } from "../treeToggle";
import { moveSelection } from "../view";

export interface SavedState { collapsed?: string[]; formHeight?: number }
export interface CommitApi {
  postMessage(message: CommitWebviewMessage): void;
  getState(): SavedState | undefined;
  setState(state: SavedState): void;
}

/** The message area's height: the tree gets the rest, but never less than a few rows. */
const FORM_HEIGHT = 184;
const MIN_FORM = 112;
const MIN_TREE = 72;
const ROW_HEIGHT = 22;

/**
 * The Commit side bar: a checkbox tree of uncommitted work (Changes, Unversioned Files), the
 * commit message, and Commit / Commit and Push…. The host owns the checks; this draws them and
 * keeps what is only the view's: folds, selection, the message area's height.
 */
export function mountCommit(api: CommitApi, events: EventTarget = window): void {
  const post = (m: CommitWebviewMessage) => api.postMessage(m);
  const saved = api.getState();
  const app = byId("commit");
  const tree = byId("commit-tree");
  const notice = byId("commit-notice");
  const splitter = byId("commit-splitter");
  const toolbar = app.querySelector<HTMLElement>(".commit-toolbar")!;
  const message = byId<HTMLTextAreaElement>("commit-message");
  const amend = byId("commit-amend");
  const validation = byId("commit-validation");
  const commitButton = byId<HTMLButtonElement>("commit-button");
  const pushButton = byId<HTMLButtonElement>("commit-push-button");
  const treeToggle = byId<HTMLButtonElement>("commit-tree-toggle");
  let state: CommitState | undefined;
  const collapsed = new Set(saved?.collapsed ?? []);
  let formHeight = saved?.formHeight ?? FORM_HEIGHT;
  let selected = new Set<string>();
  let focused: string | undefined;
  let anchor: string | undefined;
  let rows: { node: CommitRow; depth: number; parent?: string }[] = [];
  const elements = new Map<string, HTMLElement>();
  const save = () => api.setState({ collapsed: [...collapsed], formHeight });

  // The tree above, the message below: the divider moves the message area's top edge.
  const room = () => Math.max(0, app.clientHeight - toolbar.offsetHeight - splitter.offsetHeight);
  const shownForm = () => Math.max(Math.min(MIN_FORM, room()), Math.min(formHeight, room() - MIN_TREE));
  function layout(): void {
    const height = shownForm();
    app.style.setProperty("--form-height", `${height}px`);
    splitter.setAttribute("aria-valuenow", String(Math.round(height)));
    splitter.setAttribute("aria-valuetext", localize("Commit message: {0}px", Math.round(height)));
  }
  attachSplitter(splitter, {
    get: () => room() - shownForm(),
    set: (treeHeight) => { formHeight = Math.max(MIN_FORM, room() - treeHeight); layout(); },
    commit: () => { document.body.classList.remove("resizing"); formHeight = shownForm(); save(); },
  }, "y");
  splitter.addEventListener("pointerdown", (e) => { if (e.button === 0) document.body.classList.add("resizing"); });
  splitter.addEventListener("dblclick", () => { formHeight = FORM_HEIGHT; layout(); save(); });
  new ResizeObserver(layout).observe(app);

  function checkBox(check: CommitRow["check"]): HTMLElement {
    return h("span", { class: `check check-${check}`, "data-check": "true", "aria-hidden": "true" },
      check === "off" ? [] : [codiconElement(check === "on" ? "check" : "dash")]);
  }

  function rowIcon(node: CommitRow): HTMLElement {
    if (node.kind === "repo") return h("span", { class: `repo-marker accent-${node.accent ?? 0}`, "aria-hidden": "true" });
    if (node.kind === "file") return h("span", { class: "file-icon", "aria-hidden": "true" }, [codiconElement("file")]);
    return h("span", { class: "folder-icon", "aria-hidden": "true" }, [codiconElement(node.kind === "list" ? "files" : "folder")]);
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
    post({ type: "selection", ids: [...selected] });
  }

  function renderTree(): void {
    const roots = state?.roots ?? [];
    rows = [];
    elements.clear();
    const walk = (nodes: readonly CommitRow[], depth: number, parent?: string) => {
      for (const node of nodes) {
        rows.push({ node, depth, parent });
        if (node.children && !collapsed.has(node.id)) walk(node.children, depth + 1, node.id);
      }
    };
    walk(roots, 1);
    const branches = rows.filter((r) => r.node.kind !== "file");
    updateTreeToggle(treeToggle, branches.length > 0, branches.some((r) => !collapsed.has(r.node.id)));
    const visible = new Set(rows.map((r) => r.node.id));
    selected = new Set([...selected].filter((id) => visible.has(id)));
    if (focused && !visible.has(focused)) focused = undefined;
    if (anchor && !visible.has(anchor)) anchor = undefined;
    const fragment = document.createDocumentFragment();
    for (const { node, depth } of rows) {
      const branch = node.kind !== "file";
      const expanded = branch && !collapsed.has(node.id);
      const el = h("div", {
        class: `tree-row row-${node.kind}${node.kind === "file" ? ` change-${node.untracked ? "U" : node.status ?? "M"}` : ""}`,
        id: `commit-row-${elements.size}`, role: "treeitem", "aria-level": String(depth), "aria-checked": node.check === "mixed" ? "mixed" : String(node.check === "on"),
        "aria-expanded": branch ? String(expanded) : undefined, "data-node": encodeURIComponent(node.id), title: node.tooltip,
        "data-vscode-context": JSON.stringify(node.context),
      });
      el.style.paddingLeft = `${4 + (depth - 1) * 14}px`;
      const twisty = branch
        ? h("button", { class: "twisty", type: "button", tabindex: "-1", "data-toggle": "true", "aria-label": localize(expanded ? "Collapse {0}" : "Expand {0}", node.label) }, [codiconElement("chevron-right")])
        : h("span", { class: "twisty" });
      el.append(twisty, checkBox(node.check), rowIcon(node), h("span", { class: "row-label" }, [node.label]));
      if (node.description) el.append(h("span", { class: "row-description" }, [node.description]));
      if (node.kind === "file") el.append(h("span", { class: "status", "aria-hidden": "true" }, [node.untracked ? "U" : node.status ?? ""]));
      elements.set(node.id, el);
      fragment.append(el);
    }
    const scrollTop = tree.scrollTop;
    tree.replaceChildren(fragment);
    tree.scrollTop = scrollTop;
    paintSelection();
  }

  function renderForm(): void {
    const busy = state?.busy === true;
    const none = (state?.checkedFiles ?? 0) === 0;
    commitButton.disabled = pushButton.disabled = busy || none;
    commitButton.textContent = busy ? localize("Committing…") : localize("Commit");
    byId("commit-checked").textContent = state?.checkedLabel ?? "";
    byId("commit-summary").textContent = state?.summary ?? "";
    const rollback = byId<HTMLButtonElement>("commit-rollback");
    rollback.disabled = busy || (selected.size === 0 && none);
    byId<HTMLButtonElement>("commit-diff").disabled = !rows.some((r) => r.node.kind === "file" && (r.node.id === focused || selected.has(r.node.id)));
  }

  function toggle(node: CommitRow): void {
    if (node.kind === "file") return;
    if (collapsed.has(node.id)) collapsed.delete(node.id);
    else collapsed.add(node.id);
    save();
    renderTree();
    renderForm();
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
    renderForm();
  }

  /** Space, or a click on a checkbox: check the rows, or uncheck them when all are checked already. */
  function check(ids: readonly string[]): void {
    const nodes = rows.filter((r) => ids.includes(r.node.id)).map((r) => r.node);
    if (nodes.length === 0) return;
    post({ type: "check", ids: nodes.map((n) => n.id), on: !nodes.every((n) => n.check === "on") });
  }

  const focusedFile = (): CommitRow | undefined => {
    const node = rows.find((r) => r.node.id === focused)?.node;
    return node?.kind === "file" ? node : rows.find((r) => selected.has(r.node.id) && r.node.kind === "file")?.node;
  };

  tree.addEventListener("click", (e) => {
    const el = (e.target as Element).closest<HTMLElement>("[data-node]");
    if (!el) return;
    const id = decodeURIComponent(el.dataset.node!);
    const node = rows.find((r) => r.node.id === id)?.node;
    if (!node) return;
    tree.focus({ preventScroll: true });
    if ((e.target as Element).closest("[data-check]")) { focused = id; check([id]); return; }
    if ((e.target as Element).closest("[data-toggle]")) { focused = id; toggle(node); return; }
    choose(id, e.shiftKey, e.ctrlKey || e.metaKey);
    if (e.shiftKey || e.ctrlKey || e.metaKey) return;
    if (node.kind === "file") post({ type: "diff", id, preview: true });
    else toggle(node);
  });
  tree.addEventListener("dblclick", (e) => {
    const el = (e.target as Element).closest<HTMLElement>("[data-node]");
    if (!el || (e.target as Element).closest("[data-check], [data-toggle]")) return;
    const node = rows.find((r) => r.node.id === decodeURIComponent(el.dataset.node!))?.node;
    if (node?.kind === "file" && node.status !== "D") post({ type: "openFile", id: node.id });
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
    if (e.key === " ") {
      e.preventDefault();
      check(selected.size > 0 ? [...selected] : [row.node.id]);
      return;
    }
    const next = moveSelection(e.key, index, rows.length, Math.max(1, Math.floor(tree.clientHeight / ROW_HEIGHT)));
    if (next !== null) { e.preventDefault(); choose(rows[next].node.id, e.shiftKey, e.ctrlKey || e.metaKey); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      if (row.node.kind === "file") post({ type: "diff", id: row.node.id, preview: false });
      else toggle(row.node);
    } else if (e.key === "F4") {
      e.preventDefault();
      if (row.node.kind === "file" && row.node.status !== "D") post({ type: "openFile", id: row.node.id });
    } else if (e.key === "ArrowRight" && row.node.kind !== "file") {
      e.preventDefault();
      if (collapsed.has(row.node.id)) toggle(row.node);
      else if (rows[index + 1]?.parent === row.node.id) choose(rows[index + 1].node.id);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (row.node.kind !== "file" && !collapsed.has(row.node.id)) toggle(row.node);
      else if (row.parent) choose(row.parent);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      selected = new Set(rows.map((r) => r.node.id));
      paintSelection();
      renderForm();
    }
  });
  treeToggle.addEventListener("click", () => {
    if (treeToggle.dataset.action === "collapse") {
      const walk = (nodes: readonly CommitRow[]) => nodes.forEach((n) => { if (n.kind !== "file") { collapsed.add(n.id); walk(n.children ?? []); } });
      walk(state?.roots ?? []);
    } else collapsed.clear();
    save();
    renderTree();
    renderForm();
  });
  byId("commit-refresh").addEventListener("click", () => post({ type: "refresh" }));
  byId("commit-rollback").addEventListener("click", () => post({ type: "rollback" }));
  byId("commit-diff").addEventListener("click", () => { const file = focusedFile(); if (file) post({ type: "diff", id: file.id, preview: false }); });

  // The commit message: kept as a draft while typed, Amend beside it.
  let draftTimer: ReturnType<typeof setTimeout> | undefined;
  const isAmend = () => amend.getAttribute("aria-checked") === "true";
  const saveDraft = () => { clearTimeout(draftTimer); draftTimer = setTimeout(() => post({ type: "draft", text: message.value, amend: isAmend() }), 300); };
  function setAmend(on: boolean): void {
    amend.setAttribute("aria-checked", String(on));
    amend.querySelector(".check")!.replaceChildren(...(on ? [codiconElement("check")] : []));
    amend.querySelector(".check")!.className = `check check-${on ? "on" : "off"}`;
  }
  function flipAmend(): void {
    setAmend(!isAmend());
    post({ type: "amend", on: isAmend(), text: message.value });
    saveDraft();
  }
  amend.addEventListener("click", flipAmend);
  amend.addEventListener("keydown", (e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); flipAmend(); } });
  message.addEventListener("input", () => { validation.hidden = true; saveDraft(); });

  function commit(push: boolean): void {
    if (commitButton.disabled) return;
    if (message.value.trim() === "") {
      validation.textContent = localize("Write a commit message first.");
      validation.hidden = false;
      message.focus();
      return;
    }
    post({ type: "commit", message: message.value, amend: isAmend(), push });
  }
  commitButton.addEventListener("click", () => commit(false));
  pushButton.addEventListener("click", () => commit(true));
  // The JetBrains keys: Ctrl+Enter commits from the message, Ctrl+Alt+K commits and pushes, Ctrl+Alt+Z rolls back.
  message.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === "Enter") { e.preventDefault(); commit(false); }
  });
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || !e.altKey) return;
    const key = e.key.toLowerCase();
    if (key === "k") { e.preventDefault(); commit(true); }
    else if (key === "z" && document.activeElement !== message) { e.preventDefault(); post({ type: "rollback" }); }
  });

  events.addEventListener("message", (event) => {
    const m = (event as MessageEvent<CommitHostMessage>).data;
    if (!m || typeof m !== "object") return;
    if (m.type === "draft") {
      message.value = m.text;
      setAmend(m.amend);
      return;
    }
    if (m.type === "amendMessage") {
      if (message.value.trim() === "") { message.value = m.text; saveDraft(); }
      return;
    }
    if (m.type === "committed") {
      message.value = "";
      setAmend(false);
      validation.hidden = true;
      return;
    }
    if (m.type !== "state") return;
    state = m;
    notice.hidden = !m.notice;
    notice.textContent = m.notice ?? "";
    tree.hidden = !!m.notice;
    renderTree();
    renderForm();
    layout();
  });
  layout();
  post({ type: "ready" });
}

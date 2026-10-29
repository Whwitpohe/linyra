import type { CompareSidePage, CompareTreeRow, ReposWebview } from "../../compareProtocol";
import { localize } from "../../i18n";
import { codicon, codiconElement } from "../codicons";
import { byId, h } from "../dom";
import { moveSelection } from "../view";
import { updateTreeToggle } from "../treeToggle";
import { renderLines } from "../ui/counts";
import { nameClass, renderStatus } from "../ui/fileStatus";

/** Rows that open onto others: a folder, a commit (its files), a repository (All repositories). */
const isBranch = (node: CompareTreeRow) => node.kind === "folder" || node.kind === "commit" || node.kind === "repo";

/**
 * One side of Compare, drawn in the page: a tree of folders and files, or of commits, under each
 * repository in All repositories. Ctrl/Shift-click selects several (Cherry-Pick takes them all);
 * the filter box keeps the rows whose name, path or description has the text, and their parents.
 */
export class CompareTree {
  private readonly root: HTMLElement;
  private page: CompareSidePage | undefined;
  private key = "";
  private closed = new Set<string>();
  private readonly seen = new Set<string>();
  private readonly requested = new Set<string>();
  private allExpanded = false;
  private selected: string | undefined;
  /** Every selected row (Ctrl/Shift-click); `selected` is the one with the focus. */
  private picked = new Set<string>();
  private query = "";
  private rows: { node: CompareTreeRow; depth: number; parent?: string }[] = [];
  private readonly elements = new Map<string, HTMLElement>();

  constructor(private readonly side: "left" | "right", private readonly post: (message: ReposWebview) => void) {
    this.root = byId(`compare-${side}-tree`);
    this.root.addEventListener("click", (event) => {
      const target = (event.target as Element).closest<HTMLElement>("[data-node]");
      if (!target) return;
      const id = target.dataset.node!;
      const node = this.rows.find((row) => row.node.id === id)?.node;
      if (!node) return;
      if (event.ctrlKey || event.metaKey || event.shiftKey) {
        this.extend(id, event.shiftKey);
        return;
      }
      this.select(id);
      if ((event.target as Element).closest("[data-expand]")) this.toggle(node);
      else if (node.kind === "file" || node.kind === "more") this.post({ type: "sideOpen", side, id });
    });
    // Shift-click selects rows, not their text.
    this.root.addEventListener("mousedown", (event) => { if (event.shiftKey) event.preventDefault(); });
    this.root.addEventListener("contextmenu", (event) => {
      const row = (event.target as Element).closest<HTMLElement>("[data-node]");
      // Right-click inside the selection keeps it (the menu acts on all of it); outside, it selects that row.
      if (row && !this.picked.has(row.dataset.node!)) this.select(row.dataset.node!);
    });
    const filter = byId<HTMLInputElement>(`compare-${side}-filter`);
    filter.addEventListener("input", () => { this.query = filter.value.trim().toLowerCase(); this.render(); });
    filter.addEventListener("keydown", (event) => { if (event.key === "Escape" && filter.value) { event.preventDefault(); filter.value = ""; this.query = ""; this.render(); } });
    this.root.addEventListener("keydown", (event) => {
      if (!this.rows.length) return;
      const index = Math.max(0, this.rows.findIndex((row) => row.node.id === this.selected));
      const row = this.rows[index];
      const next = moveSelection(event.key, index, this.rows.length, Math.max(1, Math.floor(this.root.clientHeight / 25)));
      if (next !== null) { event.preventDefault(); this.select(this.rows[next].node.id); return; }
      if (event.key === "Enter") {
        event.preventDefault();
        if (isBranch(row.node)) this.toggle(row.node);
        else this.post({ type: "sideOpen", side, id: row.node.id });
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        if (this.closed.has(row.node.id)) this.toggle(row.node);
        else if (this.rows[index + 1]?.parent === row.node.id) this.select(this.rows[index + 1].node.id);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        if (isBranch(row.node) && !this.closed.has(row.node.id)) this.toggle(row.node);
        else if (row.parent) this.select(row.parent);
      }
    });
    const toggle = byId<HTMLButtonElement>(`compare-${side}-tree-toggle`);
    toggle.addEventListener("click", () => toggle.dataset.action === "collapse" ? this.collapseAll() : this.expandAll());
  }

  receive(page: CompareSidePage): void {
    if (page.key !== this.key) {
      this.key = page.key;
      this.closed.clear(); this.seen.clear(); this.requested.clear(); this.selected = undefined; this.picked.clear(); this.allExpanded = false;
      this.root.scrollTop = 0;
    }
    this.page = page;
    byId(`compare-${this.side}-description`).textContent = page.description;
    const notice = byId(`compare-${this.side}-message`);
    notice.hidden = !page.message;
    notice.textContent = page.message ?? "";
    const defaults = (nodes: CompareTreeRow[]) => nodes.forEach((node) => {
      if (!this.seen.has(node.id) && node.kind === "commit" && !this.allExpanded) this.closed.add(node.id);
      this.seen.add(node.id);
      if (node.loaded) this.requested.delete(node.id);
      defaults(node.children ?? []);
    });
    defaults(page.rows);
    this.render();
  }

  focus(): void { this.root.focus(); }

  private select(id: string): void {
    this.selected = id;
    this.picked = new Set([id]);
    this.paint();
  }

  /** Ctrl-click adds or removes a row; Shift-click selects every row from the focused one to it. */
  private extend(id: string, range: boolean): void {
    if (range && this.selected) {
      const ids = this.rows.map((row) => row.node.id);
      const [a, b] = [ids.indexOf(this.selected), ids.indexOf(id)].sort((x, y) => x - y);
      this.picked = new Set(a < 0 ? [id] : ids.slice(a, b + 1));
    } else if (this.picked.has(id) && this.picked.size > 1) this.picked.delete(id);
    else this.picked.add(id);
    if (!range) this.selected = id;
    this.paint();
  }

  private paint(): void {
    this.root.focus({ preventScroll: true });
    for (const [key, element] of this.elements) {
      element.classList.toggle("selected", this.picked.has(key));
      element.classList.toggle("focus", key === this.selected);
      element.setAttribute("aria-selected", String(this.picked.has(key)));
    }
    const selected = this.selected && this.elements.get(this.selected);
    if (selected) { this.root.setAttribute("aria-activedescendant", selected.id); selected.scrollIntoView({ block: "nearest" }); }
    this.post({ type: "sideSelect", side: this.side, ids: [...this.picked] });
  }

  private toggle(node: CompareTreeRow): void {
    if (!isBranch(node)) return;
    if (this.closed.has(node.id)) { this.closed.delete(node.id); this.requested.delete(node.id); }
    else this.closed.add(node.id);
    this.render();
  }

  private collapseAll(): void {
    this.allExpanded = false;
    const walk = (nodes: CompareTreeRow[]) => nodes.forEach((node) => { if (isBranch(node)) this.closed.add(node.id); walk(node.children ?? []); });
    walk(this.page?.rows ?? []);
    this.render();
  }

  private expandAll(): void {
    this.allExpanded = true;
    this.closed.clear();
    const walk = (nodes: CompareTreeRow[]) => nodes.forEach((node) => { if (node.kind === "commit" && !node.loaded) this.requested.add(node.id); walk(node.children ?? []); });
    walk(this.page?.rows ?? []);
    this.render();
    this.post({ type: "sideExpandAll", side: this.side });
  }

  private render(): void {
    const scroll = this.root.scrollTop;
    this.rows = [];
    this.elements.clear();
    // The filter: a row shows when it or a row under it matches; a parent with a match under it opens.
    const q = this.query;
    const matches = (node: CompareTreeRow): boolean => q === "" || `${node.label}\n${node.tooltip}\n${node.description}`.toLowerCase().includes(q);
    const hit = new Map<string, boolean>();
    const shows = (node: CompareTreeRow): boolean => {
      const had = hit.get(node.id);
      if (had !== undefined) return had;
      const yes = matches(node) || (node.children ?? []).some(shows);
      hit.set(node.id, yes);
      return yes;
    };
    const walk = (nodes: CompareTreeRow[], depth: number, parent?: string) => nodes.forEach((node) => {
      if (q !== "" && !shows(node)) return;
      this.rows.push({ node, depth, parent });
      const opened = !this.closed.has(node.id) || (q !== "" && !matches(node) && (node.children ?? []).some(shows));
      if (opened) {
        walk(node.children ?? [], depth + 1, node.id);
        if (node.kind === "commit" && !node.loaded && !this.requested.has(node.id)) {
          this.requested.add(node.id);
          this.post({ type: "sideExpand", side: this.side, id: node.id });
        }
      }
    });
    walk(this.page?.rows ?? [], 1);
    const branches = this.rows.filter(({ node }) => isBranch(node));
    updateTreeToggle(byId<HTMLButtonElement>(`compare-${this.side}-tree-toggle`), branches.length > 0, branches.some(({ node }) => !this.closed.has(node.id)));
    const fragment = document.createDocumentFragment();
    for (const { node, depth } of this.rows) {
      const branch = isBranch(node);
      const expanded = branch && (!this.closed.has(node.id) || this.rows.some((r) => r.parent === node.id));
      const row = h("div", { class: `compare-tree-row${node.status ? ` status-${node.status}` : ""}${node.same ? " same-file" : ""}${node.conflict ? " conflict-file" : ""}${this.picked.has(node.id) ? " selected" : ""}${this.selected === node.id ? " focus" : ""}`,
        role: "treeitem", id: `compare-${this.side}-row-${this.elements.size}`, "data-node": node.id, title: node.tooltip,
        "aria-level": String(depth), "aria-selected": String(this.picked.has(node.id)), "aria-expanded": branch ? String(expanded) : undefined,
        "data-vscode-context": JSON.stringify({ webviewSection: "compareSideRow", compareSide: this.side, compareNodeId: node.id, viewItem: node.contextValue, preventDefaultContextMenuItems: true }) });
      row.style.paddingLeft = `${5 + (depth - 1) * 14}px`;
      const arrow = branch ? h("button", { type: "button", class: "compare-twisty", tabindex: "-1", "data-expand": "true", "aria-label": localize(expanded ? "Collapse {0}" : "Expand {0}", node.label) }, [codiconElement(expanded ? "chevron-down" : "chevron-right")])
        : h("span", { class: "compare-twisty", "aria-hidden": "true" });
      const icon = h("span", { class: "compare-file-icon", "aria-hidden": "true" });
      const ext = node.label.split(".").pop()?.toLowerCase();
      if (node.kind === "file" && ["js", "jsx", "ts", "tsx", "vue", "json", "css"].includes(ext ?? "")) {
        icon.textContent = ext === "vue" ? "V" : ext === "json" ? "{}" : ext!.toUpperCase();
        icon.classList.add(`filetype-${ext}`);
      } else icon.innerHTML = codicon(node.kind === "folder" ? "folder" : node.kind === "commit" ? "git-commit" : node.kind === "repo" ? "repo" : "file");
      if (node.kind === "file") {
        // As the Changes view draws a file: the old name and the note muted, + and − in their own colors, the letter last.
        row.append(arrow, icon, h("span", { class: nameClass("compare-node-label", node.status) }, [node.label]), h("span", { class: "compare-node-description compare-file-stats" }, [
          node.oldPath ? h("span", { class: "compare-old-path" }, [`← ${node.oldPath}`]) : null,
          node.note ? h("span", { class: "compare-note" }, [node.note]) : null,
          node.lines ? renderLines(node.lines.added, node.lines.deleted) : null,
        ]), renderStatus(node.status, node.untracked === true));
      } else row.append(arrow, icon, h("span", { class: `compare-node-label${node.kind === "more" ? " load-more" : ""}` }, [node.label]), h("span", { class: "compare-node-description" }, [node.description]));
      this.elements.set(node.id, row);
      fragment.append(row);
    }
    this.root.replaceChildren(fragment);
    this.root.scrollTop = scroll;
    const selected = this.selected && this.elements.get(this.selected);
    if (selected) this.root.setAttribute("aria-activedescendant", selected.id);
    else this.root.removeAttribute("aria-activedescendant");
  }
}

import type { CompareSidePage, CompareTreeRow, ReposWebview } from "../../compareProtocol";
import { localize } from "../../i18n";
import { codicon, codiconElement } from "../codicons";
import { byId, h } from "../dom";
import { moveSelection } from "../view";
import { updateTreeToggle } from "../treeToggle";


export class CompareTree {
  private readonly root: HTMLElement;
  private page: CompareSidePage | undefined;
  private key = "";
  private closed = new Set<string>();
  private readonly seen = new Set<string>();
  private readonly requested = new Set<string>();
  private allExpanded = false;
  private selected: string | undefined;
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
      this.select(id);
      if ((event.target as Element).closest("[data-expand]")) this.toggle(node);
      else if (node.kind === "file" || node.kind === "more") this.post({ type: "sideOpen", side, id });
    });
    this.root.addEventListener("contextmenu", (event) => {
      const row = (event.target as Element).closest<HTMLElement>("[data-node]");
      if (row) this.select(row.dataset.node!);
    });
    this.root.addEventListener("keydown", (event) => {
      if (!this.rows.length) return;
      const index = Math.max(0, this.rows.findIndex((row) => row.node.id === this.selected));
      const row = this.rows[index];
      const next = moveSelection(event.key, index, this.rows.length, Math.max(1, Math.floor(this.root.clientHeight / 25)));
      if (next !== null) { event.preventDefault(); this.select(this.rows[next].node.id); return; }
      if (event.key === "Enter") {
        event.preventDefault();
        if (row.node.kind === "folder" || row.node.kind === "commit") this.toggle(row.node);
        else this.post({ type: "sideOpen", side, id: row.node.id });
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        if (this.closed.has(row.node.id)) this.toggle(row.node);
        else if (this.rows[index + 1]?.parent === row.node.id) this.select(this.rows[index + 1].node.id);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        if ((row.node.kind === "folder" || row.node.kind === "commit") && !this.closed.has(row.node.id)) this.toggle(row.node);
        else if (row.parent) this.select(row.parent);
      }
    });
    const toggle = byId<HTMLButtonElement>(`compare-${side}-tree-toggle`);
    toggle.addEventListener("click", () => toggle.dataset.action === "collapse" ? this.collapseAll() : this.expandAll());
  }

  receive(page: CompareSidePage): void {
    if (page.key !== this.key) {
      this.key = page.key;
      this.closed.clear(); this.seen.clear(); this.requested.clear(); this.selected = undefined; this.allExpanded = false;
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
    this.root.focus({ preventScroll: true });
    for (const [key, element] of this.elements) {
      element.classList.toggle("selected", key === id);
      element.setAttribute("aria-selected", String(key === id));
    }
    const selected = this.elements.get(id);
    if (selected) { this.root.setAttribute("aria-activedescendant", selected.id); selected.scrollIntoView({ block: "nearest" }); }
  }

  private toggle(node: CompareTreeRow): void {
    if (node.kind !== "folder" && node.kind !== "commit") return;
    if (this.closed.has(node.id)) { this.closed.delete(node.id); this.requested.delete(node.id); }
    else this.closed.add(node.id);
    this.render();
  }

  private collapseAll(): void {
    this.allExpanded = false;
    const walk = (nodes: CompareTreeRow[]) => nodes.forEach((node) => { if (node.kind === "folder" || node.kind === "commit") this.closed.add(node.id); walk(node.children ?? []); });
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
    const walk = (nodes: CompareTreeRow[], depth: number, parent?: string) => nodes.forEach((node) => {
      this.rows.push({ node, depth, parent });
      if (!this.closed.has(node.id)) {
        walk(node.children ?? [], depth + 1, node.id);
        if (node.kind === "commit" && !node.loaded && !this.requested.has(node.id)) {
          this.requested.add(node.id);
          this.post({ type: "sideExpand", side: this.side, id: node.id });
        }
      }
    });
    walk(this.page?.rows ?? [], 1);
    const branches = this.rows.filter(({ node }) => node.kind === "folder" || node.kind === "commit");
    updateTreeToggle(byId<HTMLButtonElement>(`compare-${this.side}-tree-toggle`), branches.length > 0, branches.some(({ node }) => !this.closed.has(node.id)));
    const fragment = document.createDocumentFragment();
    for (const { node, depth } of this.rows) {
      const branch = node.kind === "folder" || node.kind === "commit";
      const expanded = branch && !this.closed.has(node.id);
      const row = h("div", { class: `compare-tree-row${node.status ? ` status-${node.status}` : ""}${node.same ? " same-file" : ""}${this.selected === node.id ? " selected" : ""}`,
        role: "treeitem", id: `compare-${this.side}-row-${this.elements.size}`, "data-node": node.id, title: node.tooltip,
        "aria-level": String(depth), "aria-selected": String(this.selected === node.id), "aria-expanded": branch ? String(expanded) : undefined,
        "data-vscode-context": JSON.stringify({ webviewSection: "compareSideRow", compareSide: this.side, compareNodeId: node.id, viewItem: node.contextValue, preventDefaultContextMenuItems: true }) });
      row.style.paddingLeft = `${5 + (depth - 1) * 14}px`;
      const arrow = branch ? h("button", { type: "button", class: "compare-twisty", tabindex: "-1", "data-expand": "true", "aria-label": localize(expanded ? "Collapse {0}" : "Expand {0}", node.label) }, [codiconElement(expanded ? "chevron-down" : "chevron-right")])
        : h("span", { class: "compare-twisty", "aria-hidden": "true" });
      const icon = h("span", { class: "compare-file-icon", "aria-hidden": "true" });
      const ext = node.label.split(".").pop()?.toLowerCase();
      if (node.kind === "file" && ["js", "jsx", "ts", "tsx", "vue", "json", "css"].includes(ext ?? "")) {
        icon.textContent = ext === "vue" ? "V" : ext === "json" ? "{}" : ext!.toUpperCase();
        icon.classList.add(`filetype-${ext}`);
      } else icon.innerHTML = codicon(node.kind === "folder" ? "folder" : node.kind === "commit" ? "git-commit" : "file");
      row.append(arrow, icon, h("span", { class: `compare-node-label${node.kind === "more" ? " load-more" : ""}` }, [node.label]), h("span", { class: "compare-node-description" }, [node.description]));
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

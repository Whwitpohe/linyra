import { branchGroupKey, branchRevision, DEFAULT_BRANCH_SIDEBAR, sidebarState, type BranchSidebarState } from "../branchModel";
import { selectedBranches, type FilterState } from "../filterModel";
import { localize } from "../i18n";
import type { HostMessage, WebviewMessage } from "../protocol";
import type { Repo } from "../types";
import { syncLabel } from "../upstream";
import { branchRows, type BranchRow, type BranchTreeData } from "./branchPaneModel";
import { byId, clear, h } from "./dom";
import { accentOf, assignAccents } from "./view";

export class BranchPane {
  private state = sidebarState(DEFAULT_BRANCH_SIDEBAR);
  private repos: readonly Repo[] = [];
  private filter: FilterState | undefined;
  private readonly data = new Map<string, BranchTreeData>();
  private rows: BranchRow[] = [];
  private active = 0;
  private readonly root = byId("branch-tree");
  private readonly search = byId<HTMLInputElement>("repo-filter");
  private readonly tabs = { repos: byId<HTMLButtonElement>("sidebar-repos"), branches: byId<HTMLButtonElement>("sidebar-branches") };

  constructor(private readonly post: (m: WebviewMessage) => void) {
    for (const [mode, button] of Object.entries(this.tabs) as ["repos" | "branches", HTMLButtonElement][]) {
      button.addEventListener("click", () => this.setMode(mode));
      button.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const next = mode === "repos" ? "branches" : "repos";
        this.setMode(next); this.tabs[next].focus();
      });
    }
    byId("branch-refresh").addEventListener("click", () => this.post({ type: "branchSidebar", action: "refresh" }));
    this.search.addEventListener("input", () => { if (this.mode === "branches") { this.active = 0; this.render(); } });
    this.search.addEventListener("keydown", (e) => {
      if (this.mode !== "branches") return;
      if (e.key === "ArrowDown") { e.preventDefault(); this.root.focus(); }
      if (e.key === "Enter") {
        const row = this.rows.find((r) => r.kind === "branch");
        if (row) { e.preventDefault(); this.activate(row); }
      }
    });
    this.root.addEventListener("click", (e) => {
      const target = e.target as Element, el = target.closest<HTMLElement>("[data-branch-row]");
      if (!el) return;
      this.active = Number(el.dataset.branchRow);
      const row = this.rows[this.active];
      if (target.closest(".branch-star") && row.branch) {
        this.post({ type: "branchSidebar", action: "favorite", repoId: row.repo!.id, ref: row.branch.ref });
      } else { this.root.focus(); this.activate(row); }
    });
    this.root.addEventListener("keydown", (e) => this.keydown(e));
  }

  get mode(): "repos" | "branches" { return this.state.mode; }

  update(repos: readonly Repo[], filter: FilterState): void {
    this.repos = repos; this.filter = filter;
    for (const id of this.data.keys()) if (!repos.some((r) => r.id === id)) this.data.delete(id);
    if (this.mode === "branches") this.render();
  }

  applyState(state: BranchSidebarState): void { this.state = sidebarState(state); this.showMode(); }

  receive(message: Extract<HostMessage, { type: "branchTree" }>): void {
    const previous = this.data.get(message.repoId);
    this.data.set(message.repoId, { ...previous, ...message, loading: message.loading === true });
    if (this.mode === "branches") this.render();
  }

  private setMode(mode: "repos" | "branches"): void { this.state = { ...this.state, mode }; this.showMode(); this.save(); }
  private save(): void { this.post({ type: "branchSidebar", action: "state", state: this.state }); }
  private showMode(): void {
    const branches = this.mode === "branches";
    byId("repo-rows").hidden = branches;
    this.root.hidden = !branches;
    byId("branch-refresh").hidden = !branches;
    this.search.placeholder = localize(branches ? "Search repositories or branches" : "Filter repositories");
    this.search.setAttribute("aria-label", this.search.placeholder);
    for (const [mode, tab] of Object.entries(this.tabs)) { tab.setAttribute("aria-selected", String(this.mode === mode)); tab.tabIndex = this.mode === mode ? 0 : -1; }
    if (branches) this.render();
  }

  private activate(row: BranchRow): void {
    if (row.branch && row.repo) { this.post({ type: "branchSidebar", action: "select", repoId: row.repo.id, ref: row.branch.ref }); return; }
    if (row.kind === "message") return;
    const expanded = new Set(this.state.expanded);
    if (expanded.has(row.key)) expanded.delete(row.key); else expanded.add(row.key);
    this.state = { ...this.state, expanded: [...expanded] };
    // Expanding a previously failed repository is also a retry.
    if (row.kind === "repo" && row.repo && expanded.has(row.key) && this.data.get(row.repo.id)?.error) this.data.delete(row.repo.id);
    this.render(); this.save();
  }

  private request(repoId: string): void {
    if (this.data.has(repoId)) return;
    this.data.set(repoId, { loading: true });
    this.post({ type: "branchSidebar", action: "load", repoId });
  }

  private render(): void {
    const expanded = new Set(this.state.expanded), searching = this.search.value.trim() !== "";
    for (const repo of this.repos) if (searching || expanded.has(branchGroupKey("local", repo.id)) || expanded.has(branchGroupKey("remote", repo.id))) this.request(repo.id);
    const activeKey = this.rows[this.active]?.key;
    this.rows = branchRows(this.repos, this.data, this.state, this.search.value);
    const keep = this.rows.findIndex((r) => r.key === activeKey);
    this.active = keep < 0 ? Math.min(this.active, Math.max(0, this.rows.length - 1)) : keep;
    const accents = assignAccents(this.repos), fragment = document.createDocumentFragment();
    this.rows.forEach((row, i) => {
      const b = row.branch;
      const data = row.repo && this.data.get(row.repo.id)?.data;
      const selected = b && data && this.filter && selectedBranches(this.filter).some((ref) => ref === b.ref || ref === branchRevision(b, data)) && this.filter.repoIds?.length === 1 && this.filter.repoIds[0] === row.repo?.id;
      const title = b ? [b.name, b.upstream ? localize("Tracks {0}", b.upstream) : "", syncLabel(b)?.title ?? ""].filter(Boolean).join("\n") : row.label;
      const el = h("div", { class: `branch-row${selected ? " selected" : ""}${i === this.active ? " active" : ""}${row.kind === "message" ? " branch-message" : ""}`,
        id: `branch-row-${i}`, "data-branch-row": String(i), role: "treeitem", "aria-level": String(row.depth + 1),
        "aria-expanded": row.expanded === undefined ? undefined : String(row.expanded), "aria-selected": String(!!selected), title,
        "data-vscode-context": b ? JSON.stringify({ webviewSection: "branch", repoId: row.repo!.id, ref: b.ref, branchLocal: b.kind === "local", branchRemote: b.kind === "remote", branchCurrent: b.current, preventDefaultContextMenuItems: true }) : undefined,
      }, [
        h("span", { class: "branch-twisty", "aria-hidden": "true" }, [row.expanded === undefined ? "" : row.expanded ? "▾" : "▸"]),
        row.kind === "repo" ? h("span", { class: `repo-dot accent-${accentOf(accents, row.repo!.id)}`, "aria-hidden": "true" })
          : b ? h("span", { class: `branch-mark${b.current ? " current" : ""}`, "aria-hidden": "true" }, [b.current ? "✓" : "◇"]) : null,
        h("span", { class: "branch-name" }, [row.kind === "group" || row.kind === "message" ? localize(row.label) : row.label]),
        b ? h("button", { class: `branch-star${row.favorite ? " favorite" : ""}`, type: "button", tabindex: "-1", "aria-pressed": String(!!row.favorite), title: localize(row.favorite ? "Remove from Favorites" : "Add to Favorites"), "aria-label": localize("Favorite branch {0}", b.name) }, [row.favorite ? "★" : "☆"]) : null,
      ]);
      el.style.paddingLeft = `${6 + row.depth * 12}px`;
      fragment.append(el);
    });
    clear(this.root); this.root.append(fragment);
    if (this.rows.length) this.root.setAttribute("aria-activedescendant", `branch-row-${this.active}`);
    else this.root.removeAttribute("aria-activedescendant");
  }

  private keydown(e: KeyboardEvent): void {
    if (e.target !== this.root) return;
    const row = this.rows[this.active];
    if (!row) return;
    const move = e.key === "ArrowDown" ? this.active + 1 : e.key === "ArrowUp" ? this.active - 1 : e.key === "Home" ? 0 : e.key === "End" ? this.rows.length - 1 : undefined;
    if (move !== undefined) { e.preventDefault(); this.active = Math.max(0, Math.min(this.rows.length - 1, move)); this.render(); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.activate(row); }
    else if ((e.key === "ArrowRight" && row.expanded === false) || (e.key === "ArrowLeft" && row.expanded === true)) { e.preventDefault(); this.activate(row); }
    else if (e.key === "ArrowRight" && row.expanded === true && this.rows[this.active + 1]?.parent === row.key) { e.preventDefault(); this.active++; this.render(); }
    else if (e.key === "ArrowLeft" && row.parent) { e.preventDefault(); this.active = Math.max(0, this.rows.findIndex((r) => r.key === row.parent)); this.render(); }
    this.root.querySelector(`#branch-row-${this.active}`)?.scrollIntoView({ block: "nearest" });
  }
}

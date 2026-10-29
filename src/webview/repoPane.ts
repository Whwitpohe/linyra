import { localize } from "../i18n";
import { branchGroupKey, branchRevision, DEFAULT_BRANCH_SIDEBAR, sidebarState, type BranchSidebarState } from "../branchModel";
import { selectedBranches, type FilterState } from "../filterModel";
import type { HostMessage, WebviewMessage } from "../protocol";
import type { Repo } from "../types";
import { codiconElement } from "./codicons";
import { byId, clear, h } from "./dom";
import { fitName, textStyle } from "./measure";
import { fuzzyMatch, isChecked, pickOnly, toggleRepo } from "./repoPaneModel";
import { collapseAll, expandAll, parentIndex, treeRows, wantedBranchData, type BranchTreeData, type TreeRow } from "./repoTreeModel";
import { profileFilter, type ResolvedProfile } from "../profileModel";
import { syncLabel, type AheadBehind } from "../upstream";
import { absoluteTime, accentOf, assignAccents } from "./view";

/**
 * The Repositories pane: one tree, as the JetBrains Branches panel groups a multi-root project.
 * Each repository is a row that edits the Log's repo filter — click a name to show only that
 * repo; tick boxes (or Ctrl/Cmd-click) to add and remove — and opens onto its Local, Remote and
 * Tags branches. A branch row filters the Log to it; its right-click holds the branch actions.
 * One tab stop, arrow keys inside.
 */
export class RepoPane {
  private accents: ReadonlyMap<string, number> = new Map();
  private readonly filterInput = byId<HTMLInputElement>("repo-filter");
  private readonly list = byId("repo-rows");
  private repos: readonly Repo[] = [];
  private repoIds: string[] | null = null;
  private rows: TreeRow[] = [];
  private profiles: readonly ResolvedProfile[] = [];
  private active = 0;
  /** Opened rows and favorite branches, saved by the host. */
  private state = sidebarState(DEFAULT_BRANCH_SIDEBAR);
  /** Each repository's branches, read when it is first opened (or searched). */
  private readonly data = new Map<string, BranchTreeData>();
  /** The Log's filter: the branch it shows is marked. */
  private filter: FilterState | undefined;
  private get hidden(): boolean { return this.list.hidden; }

  constructor(private readonly onChange: (repoIds: string[] | null) => void, private readonly post: (m: WebviewMessage) => void = () => undefined) {
    // Right-click the Repo List's empty area: Save Selection as Profile… (package.json webview/context).
    this.list.dataset.vscodeContext = JSON.stringify({ webviewSection: "repoList", preventDefaultContextMenuItems: true });
    // A press on a box would focus its inner input, inside an aria-hidden element that the
    // re-render then destroys, leaving focus on <body> and the arrow keys dead. Keep focus on
    // the list; the click still ticks the box.
    this.list.addEventListener("mousedown", (e) => {
      if ((e.target as Element).closest(".repo-check")) {
        e.preventDefault();
        this.list.focus();
      }
    });
    // Dragging the divider resizes the pane without a window resize.
    new ResizeObserver(() => this.fitNames()).observe(this.list);
    this.filterInput.addEventListener("input", () => {
      if (this.hidden) return;
      this.active = 0;
      this.render();
    });
    this.filterInput.addEventListener("keydown", (e) => {
      if (this.hidden) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        this.list.focus();
      } else if (e.key === "Enter" && this.filterInput.value.trim()) {
        // Enter picks the best match: a repository, else a branch.
        const best = this.rows.findIndex((r) => r.kind === "repo");
        const target = best >= 0 ? best : this.rows.findIndex((r) => r.kind === "branch");
        if (target < 0) return;
        e.preventDefault();
        this.active = target;
        this.activate(target, false);
      }
    });
    this.list.addEventListener("click", (e) => {
      const target = e.target as Element;
      const el = target.closest<HTMLElement>("[data-row]");
      if (!el) return;
      const i = Number(el.dataset.row);
      this.active = i;
      const row = this.rows[i];
      if (target.closest(".tree-twisty") && "expanded" in row && row.expanded !== undefined) { this.list.focus(); this.toggle(row); return; }
      if (target.closest(".branch-star") && row.kind === "branch") {
        this.post({ type: "branchSidebar", action: "favorite", repoId: row.repo.id, ref: row.branch.ref });
        return;
      }
      const onBox = target.closest(".repo-check") !== null;
      this.activate(i, onBox || e.ctrlKey || e.metaKey);
    });
    this.list.addEventListener("keydown", (e) => this.onKey(e));
    // Expand All opens every repository on its Local branches; Collapse All closes everything.
    byId("repo-expand-all").addEventListener("click", () => this.saveState(expandAll(this.repos, this.state)));
    byId("repo-collapse-all").addEventListener("click", () => { this.active = 0; this.saveState(collapseAll(this.state)); });
  }

  private saveState(next: BranchSidebarState): void {
    this.state = { ...next, mode: "repos" };
    this.post({ type: "branchSidebar", action: "state", state: this.state });
    this.render();
  }

  update(repos: readonly Repo[], repoIds: string[] | null, profiles: readonly ResolvedProfile[] = []): void {
    // Every filter change comes here (each Search keystroke too): rebuild only when the
    // pane would look different.
    const reposKey = `${repos.map((r) => `${r.id}\0${r.name}`).join("\n")}\n${JSON.stringify(profiles)}`;
    const idsKey = repoIds === null ? null : repoIds.join("\n");
    if (reposKey === this.reposKey && idsKey === this.idsKey) return;
    if (reposKey !== this.reposKey) this.accents = assignAccents(repos);
    for (const id of this.data.keys()) if (!repos.some((r) => r.id === id)) this.data.delete(id);
    this.reposKey = reposKey;
    this.idsKey = idsKey;
    this.repos = repos;
    this.repoIds = repoIds;
    this.profiles = profiles;
    this.render();
  }
  private reposKey: string | undefined;
  /** Each repository's distance from its upstream (only those ahead or behind). */
  private sync: Readonly<Record<string, AheadBehind>> = {};

  setSync(byRepo: Readonly<Record<string, AheadBehind>>): void {
    if (JSON.stringify(byRepo) === JSON.stringify(this.sync)) return;
    this.sync = byRepo;
    // Arrives on its own (a fetch in any repo): never scroll the list the user is reading.
    this.render(false);
  }
  private idsKey: string | null | undefined;

  /** Share adjacency repairs without moving the repository list's scroll position. */
  setAccents(accents: ReadonlyMap<string, number>): void {
    if (this.accents === accents) return;
    this.accents = accents;
    this.render(false);
  }

  /** The Log's filter changed: the branch row it shows is marked. */
  setFilter(filter: FilterState): void {
    this.filter = filter;
    if (this.rows.some((r) => r.kind === "branch")) this.render(false);
  }

  /** A branch pill in the Log was clicked: open these rows, then put the cursor on row `key` once it is listed. */
  reveal(key: string, expand: readonly string[]): void {
    this.revealing = key;
    this.list.focus();
    this.saveState({ ...this.state, expanded: [...new Set([...this.state.expanded, ...expand])] });
  }
  private revealing: string | undefined;

  /** Opened rows and favorites, as the host saved them. */
  applyBranchState(state: BranchSidebarState): void {
    this.state = sidebarState(state);
    this.render(false);
  }

  /** A repository's branches arrived (or failed, or are being read again). */
  receiveBranches(message: Extract<HostMessage, { type: "branchTree" }>): void {
    const previous = this.data.get(message.repoId);
    this.data.set(message.repoId, { ...previous, ...message, loading: message.loading === true });
    this.render(false);
  }

  /** toggle: tick/untick (checkbox, Space, Ctrl/Cmd-click); otherwise show only this repo. */
  private activate(i: number, toggle: boolean): void {
    const row = this.rows[i];
    if (!row) return;
    if (row.kind === "branch") {
      this.post({ type: "branchSidebar", action: "select", repoId: row.repo.id, ref: row.branch.ref });
      return;
    }
    if (row.kind === "stash") {
      this.post({ type: "branchSidebar", action: "stashShow", repoId: row.repo.id, ref: row.stash.ref });
      return;
    }
    if (row.kind === "group" || row.kind === "remote") { this.toggle(row); return; }
    if (row.kind === "message") return;
    const allIds = this.repos.map((r) => r.id);
    // A box ticks itself when clicked; the pane must be rebuilt even when the filter comes out
    // the same (All when all are shown, or the last repo), or the boxes stop telling the truth.
    this.idsKey = undefined;
    if (row.kind === "all") this.onChange(null);
    else if (row.kind === "profile") this.onChange(profileFilter(row.profile, allIds));
    else this.onChange(toggle ? toggleRepo(this.repoIds, row.id, allIds) : pickOnly(row.id));
  }

  /** Opens or closes a repository, group or remote. A repository opens on its Local branches the first time. */
  private toggle(row: TreeRow): void {
    const expanded = new Set(this.state.expanded);
    if (expanded.has(row.key)) expanded.delete(row.key);
    else {
      expanded.add(row.key);
      if (row.kind === "repo") {
        const repoId = row.id;
        if (!(["local", "remote", "tag"] as const).some((kind) => expanded.has(branchGroupKey(kind, repoId)))) expanded.add(branchGroupKey("local", repoId));
        // Opening a repository whose read failed is also a retry.
        if (this.data.get(repoId)?.error) this.data.delete(repoId);
      }
    }
    this.saveState({ ...this.state, expanded: [...expanded] });
  }

  private onKey(e: KeyboardEvent): void {
    const last = this.rows.length - 1;
    const row = this.rows[this.active];
    const move = (i: number) => {
      e.preventDefault();
      this.active = Math.max(0, Math.min(last, i));
      this.render();
    };
    const expandable = row && "expanded" in row && row.expanded !== undefined;
    switch (e.key) {
      case "ArrowDown": return move(this.active + 1);
      case "ArrowUp": return this.active === 0 ? (e.preventDefault(), this.filterInput.focus()) : move(this.active - 1);
      case "Home": return move(0);
      case "End": return move(last);
      case "ArrowRight":
        if (!expandable) return;
        e.preventDefault();
        if (row.expanded) move(this.active + 1); else this.toggle(row);
        return;
      case "ArrowLeft": {
        if (expandable && row.expanded) { e.preventDefault(); this.toggle(row); return; }
        const parent = parentIndex(this.rows, this.active);
        if (parent >= 0) move(parent);
        return;
      }
      case " ": e.preventDefault(); return this.activate(this.active, true);
      case "Enter": e.preventDefault(); return this.activate(this.active, false);
    }
  }

  /**
   * Names wider than the pane are cut in the middle to what fits, so repos that share a
   * prefix stay apart. Not while searching: the highlighted letters need the whole name.
   */
  private fitNames(): void {
    if (this.filterInput.value.trim()) return;
    const spans = [...this.list.querySelectorAll<HTMLElement>(".repo-name[data-name]")];
    if (spans.length === 0) return;
    // Write, read, write: one layout for the whole list instead of one per row.
    for (const span of spans) span.textContent = span.dataset.name ?? "";
    const room = spans.map((span) => (span.scrollWidth > span.clientWidth ? span.clientWidth : -1));
    const { font } = textStyle(spans[0]);
    spans.forEach((span, i) => {
      if (room[i] >= 0) span.textContent = fitName(font, span.dataset.name ?? "", room[i]);
    });
  }

  /** The name with the letters the fuzzy search matched wrapped for highlighting. */
  private highlighted(name: string): (string | HTMLElement)[] {
    const m = this.filterInput.value.trim() ? fuzzyMatch(this.filterInput.value, name) : null;
    if (!m || m.positions.length === 0) return [name];
    const hit = new Set(m.positions);
    const parts: (string | HTMLElement)[] = [];
    let run = "";
    let inHit = false;
    const flush = () => {
      if (run) parts.push(inHit ? h("span", { class: "hit" }, [run]) : run);
      run = "";
    };
    for (let i = 0; i < name.length; i++) {
      if (hit.has(i) !== inHit) {
        flush();
        inHit = hit.has(i);
      }
      run += name[i];
    }
    flush();
    return parts;
  }

  private twisty(expanded: boolean | undefined): HTMLElement {
    return h("span", { class: "tree-twisty", "aria-hidden": "true" }, expanded === undefined ? [] : [codiconElement(expanded ? "chevron-down" : "chevron-right")]);
  }

  private render(reveal = true): void {
    const query = this.filterInput.value;
    for (const repo of wantedBranchData(this.repos, this.state, query)) {
      if (this.data.has(repo.id)) continue;
      this.data.set(repo.id, { loading: true });
      this.post({ type: "branchSidebar", action: "load", repoId: repo.id });
    }
    this.rows = treeRows(this.repos, query, this.profiles, this.repoIds, this.data, this.state);
    const revealed = this.revealing === undefined ? -1 : this.rows.findIndex((r) => r.key === this.revealing);
    if (revealed >= 0) { this.active = revealed; this.revealing = undefined; reveal = true; }
    this.active = Math.min(this.active, this.rows.length - 1);
    const count = this.repoIds === null ? String(this.repos.length) : `${this.repoIds.length}/${this.repos.length}`;
    const shown = this.filter ? selectedBranches(this.filter) : [];
    clear(this.list);
    this.rows.forEach((row, i) => {
      const base = (extra: string) => ({
        class: `${i === this.active ? "repo-row active" : "repo-row"}${extra}`, role: "treeitem", id: `repo-row-${i}`, "data-row": String(i),
        "aria-level": String(row.depth + 1),
      });
      const indent = (el: HTMLElement) => { if (row.depth) el.style.paddingLeft = `${10 + row.depth * 14}px`; return el; };
      if (row.kind === "group" || row.kind === "remote") {
        this.list.append(indent(h("div", { ...base(" tree-group"), "aria-expanded": String(row.expanded), "aria-selected": "false" },
          [this.twisty(row.expanded), h("span", { class: "repo-name" }, [row.kind === "group" ? localize(row.label) : row.label])])));
        return;
      }
      if (row.kind === "stash") {
        const s = row.stash;
        this.list.append(indent(h("div", { ...base(" branch-row stash-row"), "aria-selected": "false", title: `${s.subject}\n${s.ref} · ${absoluteTime(s.time)}`,
          "data-vscode-context": JSON.stringify({ webviewSection: "stash", repoId: row.repo.id, ref: s.ref, preventDefaultContextMenuItems: true }),
        }, [this.twisty(undefined), h("span", { class: "branch-mark", "aria-hidden": "true" }, [codiconElement("archive")]), h("span", { class: "branch-name" }, [row.label])])));
        return;
      }
      if (row.kind === "message") {
        this.list.append(indent(h("div", { ...base(" branch-message"), "aria-selected": "false" }, [this.twisty(undefined), h("span", { class: "repo-name" }, [localize(row.label)])])));
        return;
      }
      if (row.kind === "branch") {
        const b = row.branch, data = this.data.get(row.repo.id)?.data;
        const selected = !!data && shown.some((ref) => ref === b.ref || ref === branchRevision(b, data)) && this.filter?.repoIds?.length === 1 && this.filter.repoIds[0] === row.repo.id;
        const title = [b.name, b.upstream ? localize("Tracks {0}", b.upstream) : "", syncLabel(b)?.title ?? ""].filter(Boolean).join("\n");
        this.list.append(indent(h("div", { ...base(`${selected ? " selected" : ""} branch-row`), "aria-selected": String(selected), title,
          "data-vscode-context": JSON.stringify({ webviewSection: "branch", repoId: row.repo.id, ref: b.ref, branchLocal: b.kind === "local", branchRemote: b.kind === "remote",
            branchTag: b.kind === "tag", branchCurrent: b.current, preventDefaultContextMenuItems: true }),
        }, [
          this.twisty(undefined),
          h("span", { class: `branch-mark${b.current ? " current" : ""}`, "aria-hidden": "true" }, [codiconElement(b.current ? "check" : b.kind === "tag" ? "tag" : "git-branch")]),
          h("span", { class: "branch-name" }, [row.label]),
          h("button", { class: `branch-star${row.favorite ? " favorite" : ""}`, type: "button", tabindex: "-1", "aria-pressed": String(row.favorite),
            title: localize(row.favorite ? "Remove from Favorites" : "Add to Favorites"), "aria-label": localize("Favorite branch {0}", b.name) }, [codiconElement(row.favorite ? "star-full" : "star-empty")]),
        ])));
        return;
      }
      if (row.kind === "profile") {
        const p = row.profile;
        const names = p.ids.map((id) => this.repos.find((r) => r.id === id)?.name ?? id).join(", ");
        const missing = p.missing.length > 0 ? localize("\n{0} not in this workspace: {1} (skipped)", p.missing.length, p.missing.join(", ")) : "";
        this.list.append(h("div", {
          ...base(` profile-row${row.active ? " current" : ""}`), "aria-selected": String(row.active),
          title: `${p.name}: ${names || localize("no repository found")}${missing}`,
          "aria-label": localize("Profile {0}, {1} repositories{2}", p.name, p.ids.length, p.missing.length ? localize(", {0} not found", p.missing.length) : ""),
          // Right-click a profile: Show, Update, Rename, Delete (package.json webview/context).
          "data-vscode-context": JSON.stringify({ webviewSection: "profile", profile: p.name, updatable: !(row.active && p.missing.length === 0), preventDefaultContextMenuItems: true }),
        }, [
          this.twisty(undefined),
          h("span", { class: "profile-icon", "aria-hidden": "true" }),
          h("span", { class: "repo-name" }, [p.name]),
          p.missing.length > 0 ? h("span", { class: "profile-missing", "aria-hidden": "true" }, ["⚠"]) : null,
          h("span", { class: "repo-count" }, [String(p.ids.length)]),
        ]));
        return;
      }
      // A line between All and the profiles, and the repositories.
      if (row.kind === "repo" && i > 0 && this.rows[i - 1].kind !== "repo" && this.rows[i - 1].depth === 0 && this.rows.some((r) => r.kind === "profile")) {
        this.list.append(h("div", { class: "repo-divider", role: "presentation" }));
      }
      const id = row.kind === "repo" ? row.id : null;
      const name = row.kind === "repo" ? row.name : localize("All repositories");
      const checked = id === null ? this.repoIds === null : isChecked(this.repoIds, id);
      const accent = id === null ? null : accentOf(this.accents, id);
      const ab = id === null ? undefined : this.sync[id];
      const badge = ab ? syncLabel(ab) : null;
      // VS Code Elements' checkbox, for VS Code's own box, tick and hover. Presentational:
      // the row is the tree item and handles the click and the keyboard.
      const box = document.createElement("vscode-checkbox");
      box.className = "repo-check";
      box.setAttribute("aria-hidden", "true");
      box.tabIndex = -1;
      box.checked = checked;
      // "All repositories" shows a dash while only some are picked.
      box.indeterminate = id === null && this.repoIds !== null && this.repoIds.length > 0;
      this.list.append(h("div", {
        ...base(""),
        "aria-selected": String(checked),
        "aria-expanded": row.kind === "repo" ? String(row.expanded === true) : undefined,
        title: id ?? localize("Show commits from every repository"),
        // The visible name may be cut in the middle (fitNames): screen readers get the whole one.
        "aria-label": id === null ? `${name}, ${count}` : badge ? `${name}, ${badge.title}` : name,
        // Right-click a repository: Show Only, Hide, Exclude… (package.json webview/context).
        // behind: the menu offers Pull (package.json webview/context).
        "data-vscode-context": JSON.stringify(id === null ? { webviewSection: "repoList", preventDefaultContextMenuItems: true } : { webviewSection: "repo", repoId: id, behind: (ab?.behind ?? 0) > 0, preventDefaultContextMenuItems: true }),
      }, [
        this.twisty(row.kind === "repo" ? row.expanded === true : undefined),
        box,
        accent === null ? h("span", { class: "repo-dot all", "aria-hidden": "true" }) : h("span", { class: `repo-dot accent-${accent}`, "aria-hidden": "true" }),
        h("span", { class: "repo-name", "data-name": id === null ? undefined : name }, id === null ? [name] : this.highlighted(name)),
        id === null ? h("span", { class: "repo-count" }, [count]) : null,
        // ↓ to pull and ↑ to push, each in its own color (as the JetBrains branch widget: incoming blue, outgoing green).
        badge && ab ? h("span", { class: badge.behind ? "repo-sync behind" : "repo-sync", title: badge.title, "aria-hidden": "true" }, [
          ab.behind > 0 ? h("span", { class: "sync-in" }, [`↓${ab.behind}`]) : null,
          ab.ahead > 0 ? h("span", { class: "sync-out" }, [`↑${ab.ahead}`]) : null,
        ]) : null,
      ]));
    });
    if (this.rows.every((r) => r.kind !== "repo") && this.repos.length > 0 && query.trim()) this.list.append(h("p", { class: "hint" }, [localize("No repositories match.")]));
    this.fitNames();
    this.list.setAttribute("aria-activedescendant", `repo-row-${this.active}`);
    if (reveal) this.list.querySelector(".repo-row.active")?.scrollIntoView({ block: "nearest" });
  }
}

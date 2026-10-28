import { localize } from "../i18n";
import type { Repo } from "../types";
import { byId, clear, h } from "./dom";
import { fitName, textStyle } from "./measure";
import { fuzzyMatch, isChecked, paneRows, pickOnly, toggleRepo, type PaneRow } from "./repoPaneModel";
import { profileFilter, type ResolvedProfile } from "../profileModel";
import { syncLabel, type AheadBehind } from "../upstream";
import { accentOf, assignAccents } from "./view";

/**
 * The Repositories pane: a searchable, multi-pick list that edits the Log's
 * repo filter. Click a name to show only that repo; tick boxes (or
 * Ctrl/Cmd-click) to add and remove. One tab stop, arrow keys inside.
 */
export class RepoPane {
  private accents: ReadonlyMap<string, number> = new Map();
  private readonly filterInput = byId<HTMLInputElement>("repo-filter");
  private readonly list = byId("repo-rows");
  private repos: readonly Repo[] = [];
  private repoIds: string[] | null = null;
  private rows: PaneRow[] = [];
  private profiles: readonly ResolvedProfile[] = [];
  private active = 0;
  private get hidden(): boolean { return this.list.hidden; }

  constructor(private readonly onChange: (repoIds: string[] | null) => void, private readonly onSave: () => void) {
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
      } else if (e.key === "Enter" && this.filterInput.value.trim() && this.rows.length > 1) {
        // Enter picks the best match (row 0 is "All repositories").
        e.preventDefault();
        this.active = 1;
        this.activate(1, false);
      }
    });
    this.list.addEventListener("click", (e) => {
      const el = (e.target as Element).closest<HTMLElement>("[data-row]");
      if (!el) return;
      const i = Number(el.dataset.row);
      this.active = i;
      const onBox = (e.target as Element).closest(".repo-check") !== null;
      this.activate(i, onBox || e.ctrlKey || e.metaKey);
    });
    this.list.addEventListener("keydown", (e) => this.onKey(e));
  }

  update(repos: readonly Repo[], repoIds: string[] | null, profiles: readonly ResolvedProfile[] = []): void {
    // Every filter change comes here (each Search keystroke too): rebuild only when the
    // pane would look different.
    const reposKey = `${repos.map((r) => `${r.id}\0${r.name}`).join("\n")}\n${JSON.stringify(profiles)}`;
    const idsKey = repoIds === null ? null : repoIds.join("\n");
    if (reposKey === this.reposKey && idsKey === this.idsKey) return;
    if (reposKey !== this.reposKey) this.accents = assignAccents(repos);
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

  /** Share any adjacency repairs made by the displayed commit list. */
  setAccents(accents: ReadonlyMap<string, number>): void {
    if (this.accents === accents) return;
    this.accents = accents;
    this.render();
  }

  /** toggle: tick/untick (checkbox, Space, Ctrl/Cmd-click); otherwise show only this repo. */
  private activate(i: number, toggle: boolean): void {
    const row = this.rows[i];
    if (!row) return;
    const allIds = this.repos.map((r) => r.id);
    // A box ticks itself when clicked; the pane must be rebuilt even when the filter comes out
    // the same (All when all are shown, or the last repo), or the boxes stop telling the truth.
    this.idsKey = undefined;
    if (row.kind === "all") this.onChange(null);
    else if (row.kind === "profile") this.onChange(profileFilter(row.profile, allIds));
    else if (row.kind === "save") this.onSave();
    else this.onChange(toggle ? toggleRepo(this.repoIds, row.id, allIds) : pickOnly(row.id));
  }

  private onKey(e: KeyboardEvent): void {
    const last = this.rows.length - 1;
    const move = (i: number) => {
      e.preventDefault();
      this.active = Math.max(0, Math.min(last, i));
      this.render();
    };
    switch (e.key) {
      case "ArrowDown": return move(this.active + 1);
      case "ArrowUp": return this.active === 0 ? (e.preventDefault(), this.filterInput.focus()) : move(this.active - 1);
      case "Home": return move(0);
      case "End": return move(last);
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

  private render(reveal = true): void {
    this.rows = paneRows(this.repos, this.filterInput.value, this.profiles, this.repoIds);
    this.active = Math.min(this.active, this.rows.length - 1);
    const count = this.repoIds === null ? String(this.repos.length) : `${this.repoIds.length}/${this.repos.length}`;
    clear(this.list);
    this.rows.forEach((row, i) => {
      const rowClass = (extra: string) => `${i === this.active ? "repo-row active" : "repo-row"}${extra}`;
      if (row.kind === "profile") {
        const p = row.profile;
        const names = p.ids.map((id) => this.repos.find((r) => r.id === id)?.name ?? id).join(", ");
        const missing = p.missing.length > 0 ? localize("\n{0} not in this workspace: {1} (skipped)", p.missing.length, p.missing.join(", ")) : "";
        this.list.append(h("div", {
          class: rowClass(` profile-row${row.active ? " current" : ""}`),
          role: "option", id: `repo-row-${i}`, "aria-selected": String(row.active), "data-row": String(i),
          title: `${p.name}: ${names || localize("no repository found")}${missing}`,
          "aria-label": localize("Profile {0}, {1} repositories{2}", p.name, p.ids.length, p.missing.length ? localize(", {0} not found", p.missing.length) : ""),
          // Right-click a profile: Show, Update, Rename, Delete (package.json webview/context).
          "data-vscode-context": JSON.stringify({ webviewSection: "profile", profile: p.name, updatable: !(row.active && p.missing.length === 0), preventDefaultContextMenuItems: true }),
        }, [
          h("span", { class: "profile-icon", "aria-hidden": "true" }),
          h("span", { class: "repo-name" }, [p.name]),
          p.missing.length > 0 ? h("span", { class: "profile-missing", "aria-hidden": "true" }, ["⚠"]) : null,
          h("span", { class: "repo-count" }, [String(p.ids.length)]),
        ]));
        return;
      }
      if (row.kind === "save") {
        this.list.append(h("div", {
          class: rowClass(" save-row"),
          role: "option", id: `repo-row-${i}`, "aria-selected": "false", "data-row": String(i),
          title: localize("Save the ticked repositories as a profile"),
          "aria-label": localize("Save {0} ticked repositories as a profile", row.count),
          "data-vscode-context": JSON.stringify({ webviewSection: "repoList", preventDefaultContextMenuItems: true }),
        }, [h("span", { class: "save-icon", "aria-hidden": "true" }, ["+"]), h("span", { class: "repo-name" }, [localize("Save as profile…")]), h("span", { class: "repo-count" }, [String(row.count)])]));
        return;
      }
      // A line between All, the profiles and the save row, and the repositories.
      if (row.kind === "repo" && i > 0 && this.rows[i - 1].kind !== "repo" && this.rows.some((r) => r.kind === "profile" || r.kind === "save")) {
        this.list.append(h("div", { class: "repo-divider", role: "presentation" }));
      }
      const id = row.kind === "repo" ? row.id : null;
      const name = row.kind === "repo" ? row.name : localize("All repositories");
      const checked = id === null ? this.repoIds === null : isChecked(this.repoIds, id);
      const accent = id === null ? null : accentOf(this.accents, id);
      const ab = id === null ? undefined : this.sync[id];
      const badge = ab ? syncLabel(ab) : null;
      // VS Code Elements' checkbox, for VS Code's own box, tick and hover. Presentational:
      // the row is the listbox option and handles the click and the keyboard.
      const box = document.createElement("vscode-checkbox");
      box.className = "repo-check";
      box.setAttribute("aria-hidden", "true");
      box.tabIndex = -1;
      box.checked = checked;
      // "All repositories" shows a dash while only some are picked.
      box.indeterminate = id === null && this.repoIds !== null && this.repoIds.length > 0;
      this.list.append(h("div", {
        class: rowClass(""),
        role: "option",
        id: `repo-row-${i}`,
        "aria-selected": String(checked),
        "data-row": String(i),
        title: id ?? localize("Show commits from every repository"),
        // The visible name may be cut in the middle (fitNames): screen readers get the whole one.
        "aria-label": id === null ? `${name}, ${count}` : badge ? `${name}, ${badge.title}` : name,
        // Right-click a repository: Show Only, Hide, Exclude… (package.json webview/context).
        // behind: the menu offers Pull (package.json webview/context).
        "data-vscode-context": JSON.stringify(id === null ? { webviewSection: "repoList", preventDefaultContextMenuItems: true } : { webviewSection: "repo", repoId: id, behind: (ab?.behind ?? 0) > 0, preventDefaultContextMenuItems: true }),
      }, [
        box,
        accent === null ? h("span", { class: "repo-dot all", "aria-hidden": "true" }) : h("span", { class: `repo-dot accent-${accent}`, "aria-hidden": "true" }),
        h("span", { class: "repo-name", "data-name": id === null ? undefined : name }, id === null ? [name] : this.highlighted(name)),
        id === null ? h("span", { class: "repo-count" }, [count]) : null,
        badge ? h("span", { class: badge.behind ? "repo-sync behind" : "repo-sync", title: badge.title, "aria-hidden": "true" }, [badge.text]) : null,
      ]));
    });
    if (this.rows.every((r) => r.kind !== "repo") && this.repos.length > 0 && this.filterInput.value.trim()) this.list.append(h("p", { class: "hint" }, [localize("No repositories match.")]));
    this.fitNames();
    this.list.setAttribute("aria-activedescendant", `repo-row-${this.active}`);
    if (reveal) this.list.querySelector(".repo-row.active")?.scrollIntoView({ block: "nearest" });
  }
}

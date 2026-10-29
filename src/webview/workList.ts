import "./workList.css";
import { sumKinds } from "../changeKinds";
import type { WorkRow } from "../protocol";
import { clear, h } from "./dom";
import { renderCounts } from "./ui/counts";
import { renderPill } from "./ui/pill";
import { accentOf } from "./view";
import { meterParts, totalsTitle, workPill } from "./workListModel";

/** A row's counts with its change meter under them: each kind's share of the files, in its color. */
function countsCell(r: WorkRow): HTMLElement {
  return h("span", { class: "work-counts" }, [
    renderCounts(r.counts),
    h("span", { class: "meter", "aria-hidden": "true" }, meterParts(r.counts).map((p) => {
      const seg = h("i", { class: p.kind });
      seg.style.flex = String(p.share);
      return seg;
    })),
  ]);
}

/**
 * The Log's Uncommitted side: one row per repository with uncommitted work, as GitLens draws its
 * WIP row: the repository, its files by kind (+3 ✎2 −1) over a meter, their names, what is
 * staged, the branch and its upstream, and when a file was last edited. Few rows (one per
 * repository), so no virtual list; a listbox with ↑/↓, Home/End, and the selected row's files
 * shown in the Changes view.
 */
export class WorkList {
  private rows: WorkRow[] = [];
  private selected: string | undefined;
  /** What the rows drew last: a render that changes none of it leaves them. */
  private drawn = "";

  constructor(
    private readonly root: HTMLElement,
    private readonly onSelect: (repoId: string) => void,
  ) {
    root.addEventListener("click", (e) => {
      const row = (e.target as Element).closest<HTMLElement>("[data-repo]");
      if (row) this.select(row.dataset.repo!);
    });
    root.addEventListener("keydown", (e) => {
      const i = this.rows.findIndex((r) => r.repoId === this.selected);
      const to = e.key === "ArrowDown" ? i + 1 : e.key === "ArrowUp" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? this.rows.length - 1 : null;
      if (to === null || this.rows.length === 0) return;
      e.preventDefault();
      this.select(this.rows[Math.max(0, Math.min(this.rows.length - 1, to))].repoId);
    });
  }

  /** New rows: the selection stays on its repository while it is listed, else the first row. */
  update(rows: WorkRow[], names: ReadonlyMap<string, string>, accents: ReadonlyMap<string, number>, behind: ReadonlySet<string>): void {
    this.rows = rows;
    const keep = rows.some((r) => r.repoId === this.selected);
    if (!keep) this.selected = rows[0]?.repoId;
    const drawn = JSON.stringify(rows.map((r) => [r, names.get(r.repoId), accentOf(accents, r.repoId), behind.has(r.repoId)]));
    if (drawn !== this.drawn) {
      this.drawn = drawn;
      this.draw(names, accents, behind);
    }
    for (const el of this.root.querySelectorAll<HTMLElement>("[data-repo]")) el.setAttribute("aria-selected", String(el.dataset.repo === this.selected));
    const i = rows.findIndex((r) => r.repoId === this.selected);
    if (i >= 0) this.root.setAttribute("aria-activedescendant", `work-${i}`);
    else this.root.removeAttribute("aria-activedescendant");
    // The host shows the selected repository's files; tell it when the selection moved on its own.
    if (!keep && this.selected) this.onSelect(this.selected);
  }

  private draw(names: ReadonlyMap<string, string>, accents: ReadonlyMap<string, number>, behind: ReadonlySet<string>): void {
    clear(this.root);
    this.rows.forEach((r, i) => {
      const name = names.get(r.repoId) ?? r.repoId;
      this.root.append(h("div", {
        class: "work-row", role: "option", id: `work-${i}`, "aria-selected": "false", "data-repo": r.repoId,
        // Right-click: the repository's menu (Pull, Show Only…), as on its commits, and Discard All Changes.
        "data-vscode-context": JSON.stringify({ webviewSection: "uncommitted", repoId: r.repoId, behind: behind.has(r.repoId), canStage: r.canStage, hasStaged: r.hasStaged, hasChanges: r.hasChanges, preventDefaultContextMenuItems: true }),
      }, [
        h("span", { class: `chip accent-${accentOf(accents, r.repoId)}`, title: name }, [name]),
        countsCell(r),
        h("span", { class: "work-preview", title: r.preview }, [r.preview]),
        h("span", { class: "work-badges" }, [
          ...r.tags.map((tag) => h("span", { class: r.hasStaged ? "work-tag staged" : "work-tag" }, [tag])),
          // No context of its own: right-clicking the pill opens the row's menu.
          r.branch ? renderPill(workPill(r.branch, r.head), undefined, "work-pill") : null,
        ]),
        h("span", { class: "work-edited" }, [r.edited]),
      ]));
    });
  }

  private select(repoId: string): void {
    if (repoId === this.selected) return;
    this.selected = repoId;
    for (const el of this.root.querySelectorAll<HTMLElement>("[data-repo]")) el.setAttribute("aria-selected", String(el.dataset.repo === repoId));
    const i = this.rows.findIndex((r) => r.repoId === repoId);
    this.root.setAttribute("aria-activedescendant", `work-${i}`);
    this.root.querySelector<HTMLElement>(`#work-${i}`)?.scrollIntoView({ block: "nearest" });
    this.onSelect(repoId);
  }
}

/**
 * The header's totals beside the switch on the Uncommitted side: the rows' files by kind, summed
 * (+3 ✎5 −1); how many repositories and lines in its tooltip. Nothing on the Commits side.
 */
export function renderWorkTotals(target: HTMLElement, rows: readonly WorkRow[], totals: { files: number; repos: number; added: number; deleted: number }): void {
  const key = rows.length === 0 || totals.files === 0 ? "" : JSON.stringify([rows.map((r) => r.counts), totals]);
  if (target.dataset.drawn === key) return;
  target.dataset.drawn = key;
  clear(target);
  if (key === "") return;
  const kinds = sumKinds(rows.map((r) => r.counts));
  const counts = renderCounts(kinds);
  const title = totalsTitle(kinds, totals);
  counts.title = title;
  counts.setAttribute("aria-label", title.replace("\n", ", "));
  target.append(counts);
}

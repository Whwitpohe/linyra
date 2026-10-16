import type { WorkRow } from "../protocol";
import { clear, h } from "./dom";
import { accentOf, meterParts } from "./view";

/**
 * The Log's Uncommitted side: one row per repository with uncommitted work. Few rows (one per
 * repository), so no virtual list; a listbox with ↑/↓, Home/End, and the selected row's files
 * shown in the Changes view.
 */
export class WorkList {
  private rows: WorkRow[] = [];
  private selected: string | undefined;

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
    clear(this.root);
    for (const r of rows) {
      const name = names.get(r.repoId) ?? r.repoId;
      const on = r.repoId === this.selected;
      this.root.append(h("div", {
        class: "work-row", role: "option", id: `work-${rows.indexOf(r)}`, "aria-selected": String(on), "data-repo": r.repoId,
        // Right-click: the repository's menu (Pull, Show Only…), as on its commits, and Discard All Changes.
        "data-vscode-context": JSON.stringify({ webviewSection: "uncommitted", repoId: r.repoId, behind: behind.has(r.repoId), canStage: r.canStage, hasStaged: r.hasStaged, hasChanges: r.hasChanges, preventDefaultContextMenuItems: true }),
      }, [
        h("span", { class: `chip accent-${accentOf(accents, r.repoId)}`, title: name }, [name]),
        h("span", { class: "work-what" }, [
          h("span", { class: "work-preview", title: r.preview }, [r.preview]),
          h("span", { class: "meter", "aria-hidden": "true" }, meterParts(r.meter).map((p) => {
            const seg = h("i", { class: p.kind });
            seg.style.flex = String(p.share);
            return seg;
          })),
        ]),
        h("span", { class: "work-tags" }, r.tags.map((t) => h("span", { class: t.endsWith("staged") ? "work-tag staged" : "work-tag" }, [t]))),
        h("span", { class: "work-edited" }, [r.edited]),
      ]));
    }
    const i = rows.findIndex((r) => r.repoId === this.selected);
    if (i >= 0) this.root.setAttribute("aria-activedescendant", `work-${i}`);
    else this.root.removeAttribute("aria-activedescendant");
    // The host shows the selected repository's files; tell it when the selection moved on its own.
    if (!keep && this.selected) this.onSelect(this.selected);
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

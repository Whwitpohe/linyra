import { localize } from "../i18n";
import { codiconElement } from "./codicons";
import { h } from "./dom";
import { GRAPH_INSET } from "./graph";
import type { ChangesMode } from "../changeStats";
import type { ChangesStage } from "./changeViz";
import { changesCell } from "./changesColumn";
import type { ColumnId } from "./logColumns";
import { renderCounts, renderLines } from "./ui/counts";
import type { WorkSummary } from "./workSummary";

const SVG = "http://www.w3.org/2000/svg";
/** Past this many, the rest of the repositories are one "+N". */
const CHIPS = 3;

export interface WorkRowOptions {
  summary: WorkSummary;
  name: (repoId: string) => string;
  accent: (repoId: string) => number;
  /** The columns the commits show (logColumns.ts): the row has the same cells, so it lines up. */
  shown: ReadonlySet<ColumnId>;
  graphWidth: number;
  rowHeight: number;
  /** The repository column has room for names (otherwise only its strip). */
  repoNames: boolean;
  /** Whose work the Changes view shows when this row is selected. */
  shownRepo: string | undefined;
  /** The repository has commits to pull: its menu offers Pull. */
  behind: (repoId: string) => boolean;
  /** The Changes column's drawing and how much it draws at this width: the lines go there, as a commit's do. */
  changes?: { mode: Exclude<ChangesMode, "off">; stage: ChangesStage };
  /** The latest edit as the date column words a commit's ("2m ago"), or "" when not known. */
  when: string;
}

/** "Uncommitted changes in acme-web, 12 files": the row's accessible name. */
export function workRowLabel(o: WorkRowOptions): string {
  const s = o.summary;
  const where = s.repos.length === 1 ? o.name(s.repos[0].repoId) : localize("{0} repositories", s.repos.length);
  return [localize("Uncommitted changes"), where, localize(s.files === 1 ? "{0} file" : "{0} files", s.files),
    localize("{0} lines added, {1} deleted", s.added, s.deleted), s.edited].filter(Boolean).join(", ");
}

/**
 * The summary row's cells, in the commits' columns: the repository (its strip, or a dashed one for
 * several), a dashed node where the commits' first lane is, "Uncommitted changes" with a chip per
 * repository when there are several (a click shows that one's files), the files by kind and the
 * lines, the latest edit in the date column, and Commit… over the row's end on hover.
 */
export function workRowCells(o: WorkRowOptions): Node[] {
  const s = o.summary;
  const one = s.repos.length === 1 ? s.repos[0] : undefined;
  const accent = one ? o.accent(one.repoId) : undefined;
  const graph = document.createElementNS(SVG, "svg");
  for (const [k, v] of Object.entries({ class: "commit-graph summary-graph", width: o.graphWidth, height: o.rowHeight, viewBox: `0 0 ${o.graphWidth} ${o.rowHeight}`, "aria-hidden": "true" })) graph.setAttribute(k, String(v));
  const node = document.createElementNS(SVG, "circle");
  for (const [k, v] of Object.entries({ class: `summary-node${accent === undefined ? "" : ` accent-${accent}`}`, cx: GRAPH_INSET, cy: o.rowHeight / 2, r: 4.5 })) node.setAttribute(k, String(v));
  graph.append(node);
  const label = one ? o.name(one.repoId) : localize("{0} repositories", s.repos.length);
  const chips = one ? [] : s.repos.slice(0, CHIPS).map((r) => {
    const name = o.name(r.repoId);
    return h("span", {
      class: `chip summary-chip accent-${o.accent(r.repoId)}`, "data-work-repo": r.repoId, "aria-current": r.repoId === o.shownRepo ? "true" : undefined,
      title: localize("Show the uncommitted changes in {0}", name),
      // Right-click: that repository's menu on the Uncommitted side (Commit…, Stage All…).
      "data-vscode-context": JSON.stringify(workContext(r, o.behind(r.repoId))),
    }, [name]);
  });
  const rest = s.repos.slice(CHIPS);
  return [
    h("span", { class: `repo-band band-start band-end${accent === undefined ? " summary-band" : ` accent-${accent}`}`, role: "gridcell", title: label },
      o.repoNames ? [h("span", { class: "repo-label" }, [label])] : []),
    graph,
    h("span", { class: "commit-message summary-message", role: "gridcell" }, [
      h("span", { class: "subject summary-subject" }, [localize("Uncommitted changes")]),
      renderCounts(s.kinds, "summary-kinds"),
      // Without a Changes column the lines stay here.
      o.shown.has("changes") && o.changes ? null : renderLines(s.added, s.deleted, "summary-lines"),
      ...chips,
      rest.length ? h("span", { class: "summary-more", title: rest.map((r) => o.name(r.repoId)).join("\n") }, [`+${rest.length}`]) : null,
    ]),
    o.shown.has("hash") ? h("span", { class: "hash", role: "gridcell" }) : null,
    o.shown.has("author") ? h("span", { class: "author", role: "gridcell" }) : null,
    o.shown.has("changes") ? (o.changes ? changesCell({ files: s.files, added: s.added, deleted: s.deleted }, o.changes.mode, o.changes.stage) : h("span", { class: "changes-cell", role: "gridcell" })) : null,
    o.shown.has("date") ? h("span", { class: "date", role: "gridcell", title: s.edited || undefined },
      [o.when]) : null,
    h("span", { class: "row-actions" }, [h("button", { class: "row-action summary-commit", type: "button", title: localize("Commit…"), "aria-label": localize("Commit…") },
      [codiconElement("check")])]),
  ].filter((n): n is HTMLElement | SVGSVGElement => n !== null);
}

/** One repository's right-click on the Uncommitted side (workList.ts): the same menu here. */
export function workContext(r: WorkSummary["repos"][number], behind = false): Record<string, unknown> {
  return { webviewSection: "uncommitted", repoId: r.repoId, behind, canStage: r.canStage, hasStaged: r.hasStaged, hasChanges: r.hasChanges, preventDefaultContextMenuItems: true };
}

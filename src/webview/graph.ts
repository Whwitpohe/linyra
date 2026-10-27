import { localize } from "../i18n";
import type { Commit } from "../types";
import type { GraphRail, GraphRow } from "./graphModel";

export interface FoldAction { id: string; count: number; expand?: boolean }
export interface GraphFoldOptions {
  node?: FoldAction;
  folded?: FoldAction;
  edges?: ReadonlyMap<string, FoldAction>;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number>): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

/** One row's SVG reaches its exact top/bottom, joining adjacent virtual rows. */
export function renderGraph(row: GraphRow, commit: Commit, columns: number, width: number, height: number, folds: GraphFoldOptions = {}): SVGSVGElement {
  const x = (column: number) => 6 + column * Math.min(16, (width - 12) / Math.max(1, columns - 1));
  const middle = height / 2;
  const root = svg("svg", { class: "commit-graph", viewBox: `0 0 ${width} ${height}`, width, height, role: "gridcell",
    "aria-label": folds.folded ? localize("Expand {0} hidden commits", folds.folded.count) : localize("Commit {0}; parents: {1}", commit.sha.slice(0, 7), commit.parents.map((p) => p.slice(0, 7)).join(", ") || "—") });
  const actionEdges: SVGGElement[] = [];
  const line = (from: number, to: number, y1: number, y2: number, accent: number, dashed = false, rail?: GraphRail) => {
    const d = from === to ? `M ${x(from)} ${y1} V ${y2}` : `M ${x(from)} ${y1} C ${x(from)} ${y1 + (y2 - y1) / 2} ${x(to)} ${y1 + (y2 - y1) / 2} ${x(to)} ${y2}`;
    const path = svg("path", { class: `graph-edge accent-${accent}${dashed ? " graph-cut" : ""}`, d });
    const action = rail?.targetKey ? folds.edges?.get(rail.targetKey) : undefined;
    if (action) {
      const group = svg("g", { class: "graph-fold-edge", "data-fold-collapse": action.id });
      const title = svg("title", {}); title.textContent = localize("Collapse {0} linear commits", action.count);
      group.append(title, svg("path", { class: "graph-edge-hit", d }), path); actionEdges.push(group);
    } else root.append(path);
  };
  for (const rail of row.through) line(rail.column, rail.column, 0, height, rail.accent, false, rail);
  if (row.incoming) line(row.node.column, row.node.column, 0, middle, row.node.accent, !!folds.folded);
  for (const rail of row.outgoing) line(row.node.column, rail.column, middle, height, rail.accent, !!folds.folded, rail);
  if (row.missing) {
    line(row.node.column, row.missing.column, middle, height - 2, row.missing.accent, true);
    const title = svg("title", {});
    title.textContent = localize("Some parents are outside the loaded results");
    root.append(title);
  }
  root.append(...actionEdges);
  const action = folds.folded ?? folds.node;
  const expanding = folds.folded !== undefined || folds.node?.expand === true;
  const label = action ? localize(expanding ? "Expand {0} hidden commits" : "Collapse {0} linear commits", action.count) : localize("Select commit {0}", commit.sha.slice(0, 7));
  const point = svg("g", { class: `graph-point${action ? " graph-fold-control" : ""}`, role: "button", tabindex: "-1", "data-graph-node": commit.sha,
    ...(action ? { [expanding ? "data-fold-expand" : "data-fold-collapse"]: action.id, "aria-expanded": String(!expanding) } : {}), "aria-label": label });
  const title = svg("title", {});
  title.textContent = action ? label : `${commit.sha.slice(0, 7)} · ${commit.subject}`;
  point.append(title);
  if (action) {
    const cx = x(row.node.column);
    point.append(svg("rect", { class: "graph-hit", x: cx - 8, y: middle - 8, width: 16, height: 16 }));
    point.append(svg("rect", { class: `graph-fold-box accent-${row.node.accent}`, x: cx - 5.5, y: middle - 5.5, width: 11, height: 11, rx: 1.5 }));
    point.append(svg("path", { class: `graph-fold-sign accent-${row.node.accent}`,
      d: `M ${cx - 3} ${middle} H ${cx + 3}${expanding ? ` M ${cx} ${middle - 3} V ${middle + 3}` : ""}` }));
    root.append(point);
    return root;
  }
  point.append(svg("circle", { class: "graph-hit", cx: x(row.node.column), cy: middle, r: 7 }));
  const marked = commit.parents.length > 1 || commit.refs?.some((ref) => ref.kind === "head" || ref.kind === "local" || ref.kind === "remote");
  point.append(svg("circle", { class: `graph-node accent-${row.node.accent}${marked ? " graph-merge" : ""}`,
    cx: x(row.node.column), cy: middle, r: marked ? 4.5 : 3.2 }));
  if (commit.parents.length > 1) point.append(svg("circle", { class: `graph-node accent-${row.node.accent}`, cx: x(row.node.column), cy: middle, r: 1.6 }));
  root.append(point);
  return root;
}

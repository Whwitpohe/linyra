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

/** A drawn rail that folds the linear history it leads into, from (x1, y1) to (x2, y2) in its row. */
export interface RailAction { x1: number; x2: number; y1: number; y2: number; d: string; action: FoldAction }
/**
 * Each drawn row's foldable rails. A row draws its rails as one path per color, so the rail under
 * the pointer is found by position (railAt) rather than by an element of its own: a row with many
 * lanes stays a handful of nodes, which is what keeps scrolling smooth.
 */
const railActions = new WeakMap<Element, RailAction[]>();

/** How far from a rail the pointer may be and still hit it (the old hit path's half width). */
const HIT = 5;

/** The foldable rail of `svg` under the pointer, if any. */
export function railAt(graph: Element, clientX: number, clientY: number): RailAction | undefined {
  const rails = railActions.get(graph);
  if (!rails?.length) return undefined;
  const box = graph.getBoundingClientRect();
  const px = clientX - box.left, py = clientY - box.top;
  let best: RailAction | undefined, bestDistance = HIT;
  for (const r of rails) {
    if (py < Math.min(r.y1, r.y2) - HIT || py > Math.max(r.y1, r.y2) + HIT) continue;
    // A rail is straight, or the S-curve renderGraph draws: its x at this height, near enough.
    const t = r.y2 === r.y1 ? 0 : Math.max(0, Math.min(1, (py - r.y1) / (r.y2 - r.y1)));
    const distance = Math.abs(px - (r.x1 + (r.x2 - r.x1) * t * t * (3 - 2 * t)));
    if (distance <= bestDistance) { best = r; bestDistance = distance; }
  }
  return best;
}

/** Highlight the rail under the pointer (or none), and say what a click does. */
export function hoverRail(graph: Element, rail: RailAction | undefined): void {
  let mark = graph.querySelector<SVGPathElement>(":scope > .graph-edge-hover");
  graph.classList.toggle("rail-hover", rail !== undefined);
  if (!rail) { mark?.remove(); graph.querySelector(":scope > title.rail-title")?.remove(); return; }
  if (!mark) { mark = svg("path", { class: "graph-edge-hover" }); graph.append(mark); }
  mark.setAttribute("d", rail.d);
  let title = graph.querySelector(":scope > title.rail-title");
  if (!title) { title = svg("title", { class: "rail-title" }); graph.prepend(title); }
  title.textContent = localize("Collapse {0} linear commits", rail.action.count);
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number>): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

/**
 * One row's SVG reaches its exact top/bottom, joining adjacent virtual rows. Its rails are one
 * path per color (and per dashed style): a merged log of many repositories runs dozens of lanes
 * through every row, and an element per lane made each row ~90 nodes to build while scrolling.
 */
export function renderGraph(row: GraphRow, commit: Commit, columns: number, width: number, height: number, folds: GraphFoldOptions = {}): SVGSVGElement {
  const x = (column: number) => 6 + column * Math.min(16, (width - 12) / Math.max(1, columns - 1));
  const middle = height / 2;
  const root = svg("svg", { class: "commit-graph", viewBox: `0 0 ${width} ${height}`, width, height, role: "gridcell",
    "aria-label": folds.folded ? localize("Expand {0} hidden commits", folds.folded.count) : localize("Commit {0}; parents: {1}", commit.sha.slice(0, 7), commit.parents.map((p) => p.slice(0, 7)).join(", ") || "—") });
  const strokes = new Map<string, string[]>();
  const actions: RailAction[] = [];
  const line = (from: number, to: number, y1: number, y2: number, accent: number, dashed = false, rail?: GraphRail) => {
    const d = from === to ? `M ${x(from)} ${y1} V ${y2}` : `M ${x(from)} ${y1} C ${x(from)} ${y1 + (y2 - y1) / 2} ${x(to)} ${y1 + (y2 - y1) / 2} ${x(to)} ${y2}`;
    const style = `graph-edge accent-${accent}${dashed ? " graph-cut" : ""}`;
    const list = strokes.get(style);
    if (list) list.push(d); else strokes.set(style, [d]);
    const action = rail?.targetKey ? folds.edges?.get(rail.targetKey) : undefined;
    if (action) actions.push({ x1: x(from), x2: x(to), y1, y2, d, action });
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
  for (const [style, ds] of strokes) root.append(svg("path", { class: style, d: ds.join(" ") }));
  if (actions.length) railActions.set(root, actions);
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

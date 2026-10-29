// The Files and Commits treemaps: a tree of paths, the part of it one view sends, and the
// squarified layout (Bruls, Huizing, van Wijk 2000) the webview draws. Pure: no vscode, no DOM.

/** A folder or file: its total (bytes or commits) and how many files it holds. */
export interface TreeNode {
  name: string;
  value: number;
  files: number;
  /** Repository-relative ("" for a repository or the scope's root). */
  path: string;
  repoId?: string;
  kind: "root" | "repo" | "folder" | "file";
  children?: Map<string, TreeNode>;
}

/** What a view sends of a node: its biggest children, a few levels deep. */
export interface TreeNodeMsg {
  name: string;
  value: number;
  files: number;
  kind: "root" | "repo" | "folder" | "file" | "rest";
  repoId?: string;
  path?: string;
  /** A file's type: what follows its last dot ("" for none). */
  ext?: string;
  children?: TreeNodeMsg[];
  /** A folder whose children were not sent (deeper than the view, or past the budget): open it to see them. */
  more?: boolean;
}

export const extOf = (path: string): string => {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
};

function child(parent: TreeNode, name: string, kind: TreeNode["kind"], path: string, repoId: string): TreeNode {
  parent.children ??= new Map();
  let node = parent.children.get(name);
  if (!node) parent.children.set(name, (node = { name, value: 0, files: 0, path, repoId, kind }));
  return node;
}

/**
 * Repositories, then folders, then files. With one repository the repository is the root; with
 * several, a root holds them. Values of 0 or less are left out (an empty file has no area).
 */
export function buildTree(repos: readonly { id: string; name: string; entries: readonly { path: string; value: number }[] }[]): TreeNode {
  const root: TreeNode = { name: "", value: 0, files: 0, path: "", kind: "root" };
  for (const repo of repos) {
    const top = child(root, repo.id, "repo", "", repo.id);
    top.name = repo.name;
    for (const e of repo.entries) {
      if (!(e.value > 0)) continue;
      const parts = e.path.split("/");
      let node = top;
      node.value += e.value;
      node.files++;
      for (let i = 0; i < parts.length; i++) {
        const last = i === parts.length - 1;
        node = child(node, parts[i], last ? "file" : "folder", parts.slice(0, i + 1).join("/"), repo.id);
        node.value += e.value;
        node.files++;
      }
    }
    root.value += top.value;
    root.files += top.files;
  }
  if (repos.length === 1) return root.children?.get(repos[0].id) ?? { name: repos[0].name, value: 0, files: 0, path: "", repoId: repos[0].id, kind: "repo" };
  return root;
}

/** The node at `names` under `root` (each a child's key: a repository's id, then folder names). */
export function findNode(root: TreeNode, names: readonly string[]): TreeNode | undefined {
  let node: TreeNode | undefined = root;
  for (const name of names) node = node?.children?.get(name);
  return node;
}

/** The keys from `root` down to `path` in `repoId` (a path scope's folder), or undefined. */
export function keysOf(root: TreeNode, repoId: string, path: string): string[] | undefined {
  const keys = root.kind === "root" ? [repoId] : [];
  if (path) keys.push(...path.split("/"));
  return findNode(root, keys) ? keys : undefined;
}

const byValue = (a: TreeNode, b: TreeNode) => b.value - a.value || a.name.localeCompare(b.name);

/**
 * `node` and its descendants `depth` levels down, breadth first so the top levels fill before the
 * budget runs out: at most `perFolder` children each (the rest summed as one "rest" node) and
 * `budget` nodes in all. A 200,000-file repository crosses the webview boundary a view at a time.
 */
export function pruneTree(node: TreeNode, depth = 6, perFolder = 200, budget = 5000): TreeNodeMsg {
  const msg = (n: TreeNode): TreeNodeMsg => ({ name: n.name, value: n.value, files: n.files, kind: n.kind, ...(n.repoId ? { repoId: n.repoId } : {}),
    ...(n.kind === "file" ? { path: n.path, ext: extOf(n.path) } : n.kind === "folder" || n.kind === "repo" ? { path: n.path } : {}) });
  const top = msg(node);
  const queue: [TreeNode, TreeNodeMsg, number][] = [[node, top, 0]];
  let left = budget;
  while (queue.length) {
    const [n, m, level] = queue.shift()!;
    if (!n.children?.size) continue;
    if (level >= depth || left <= 0) { m.more = true; continue; }
    const kids = [...n.children.values()].sort(byValue);
    const room = Math.max(1, Math.min(perFolder, left));
    const shown = kids.length > room ? kids.slice(0, room - 1) : kids;
    m.children = shown.map((k) => {
      const km = msg(k);
      queue.push([k, km, level + 1]);
      return km;
    });
    const rest = kids.slice(shown.length);
    if (rest.length) m.children.push({ name: "", kind: "rest", value: rest.reduce((s, k) => s + k.value, 0), files: rest.reduce((s, k) => s + k.files, 0) });
    left -= m.children.length;
  }
  return top;
}

/** The file types holding the most of the total (bytes), biggest first: the legend's colors. */
export function rankExtensions(files: readonly { path: string; value: number }[], k = 7): { ext: string; value: number }[] {
  const totals = new Map<string, number>();
  for (const f of files) if (f.value > 0) totals.set(extOf(f.path), (totals.get(extOf(f.path)) ?? 0) + f.value);
  return [...totals].map(([ext, value]) => ({ ext, value })).sort((a, b) => b.value - a.value || a.ext.localeCompare(b.ext)).slice(0, k);
}

/**
 * Heat for Commits: the counts that start steps 1, 2 and 3 (the files in the top 40%, 30%, 10%),
 * each above the commonest low count, so a range where every file was touched once is not all hot.
 */
export function heatSteps(values: readonly number[]): number[] {
  const sorted = values.filter((v) => v > 0).sort((a, b) => b - a);
  if (sorted.length === 0) return [];
  const floor = sorted[sorted.length - 1] + 1;
  // The count of the last file inside the top `share` of files.
  const at = (share: number) => Math.max(floor, sorted[Math.max(0, Math.ceil(sorted.length * share) - 1)]);
  return [at(0.4), at(0.3), at(0.1)];
}

export const heatLevel = (value: number, steps: readonly number[]): number => steps.filter((s) => value >= s).length;

/** The legend's steps: each level a tile can reach, and the counts it covers (`to` undefined: and up). */
export function heatLegend(steps: readonly number[]): { level: number; from: number; to?: number }[] {
  const bounds = [1, ...steps];
  const out: { level: number; from: number; to?: number }[] = [];
  for (let level = 0; level < bounds.length; level++) {
    const from = bounds[level], next = bounds[level + 1];
    // Two steps at one count: the lower level is never drawn (heatLevel counts both).
    if (next !== undefined && next <= from) continue;
    out.push(next === undefined ? { level, from } : { level, from, to: next - 1 });
  }
  return out;
}

export interface Rect { x: number; y: number; w: number; h: number }

/** The worst aspect ratio of a row of areas laid along a side (the algorithm's measure). */
function worst(sum: number, max: number, min: number, side: number): number {
  const s2 = sum * sum, w2 = side * side;
  return Math.max((w2 * max) / s2, s2 / (w2 * min));
}

/**
 * Squarified treemap: rectangles for `values` (biggest first) filling `rect`, each as close to a
 * square as rows along the shorter side allow. A value of 0 gets an empty rectangle.
 */
export function squarify(values: readonly number[], rect: Rect): Rect[] {
  const out: Rect[] = values.map(() => ({ x: rect.x, y: rect.y, w: 0, h: 0 }));
  const total = values.reduce((s, v) => s + (v > 0 ? v : 0), 0);
  if (total <= 0 || rect.w <= 0 || rect.h <= 0) return out;
  const scale = (rect.w * rect.h) / total;
  const items = values.map((v, i) => ({ i, a: v > 0 ? v * scale : 0 })).filter((x) => x.a > 0);
  let r = { ...rect };
  let i = 0;
  while (i < items.length) {
    const side = Math.min(r.w, r.h);
    let sum = items[i].a, max = items[i].a, min = items[i].a;
    let j = i + 1;
    while (j < items.length) {
      const a = items[j].a;
      if (worst(sum + a, Math.max(max, a), Math.min(min, a), side) > worst(sum, max, min, side)) break;
      sum += a; max = Math.max(max, a); min = Math.min(min, a);
      j++;
    }
    // The last row takes what is left, so rounding never leaves a sliver.
    const last = j === items.length;
    if (r.w >= r.h) {
      const w = last ? r.w : sum / r.h;
      let y = r.y;
      for (let k = i; k < j; k++) {
        const h = k === j - 1 ? r.y + r.h - y : items[k].a / w;
        out[items[k].i] = { x: r.x, y, w, h };
        y += h;
      }
      r = { x: r.x + w, y: r.y, w: r.w - w, h: r.h };
    } else {
      const h = last ? r.h : sum / r.w;
      let x = r.x;
      for (let k = i; k < j; k++) {
        const w = k === j - 1 ? r.x + r.w - x : items[k].a / h;
        out[items[k].i] = { x, y: r.y, w, h };
        x += w;
      }
      r = { x: r.x, y: r.y + h, w: r.w, h: r.h - h };
    }
    i = j;
  }
  return out;
}

export interface Tile extends Rect {
  node: TreeNodeMsg;
  depth: number;
  /** A folder drawn as a frame: its name in a header strip, its children inside. */
  frame: boolean;
  /** Room for a label. */
  label: boolean;
}

export interface LayoutOptions {
  /** A frame's header strip. */
  header: number;
  /** The gap inside a frame. */
  pad: number;
  /** Smaller tiles are not drawn (their folder's background shows their share). */
  min: number;
}

export const LAYOUT: LayoutOptions = { header: 18, pad: 2, min: 2 };

/**
 * The tiles of `node`'s children in `rect`, nested: a folder with children and room for them is a
 * frame around its own tiles; anything else is one tile. Parents come before their children.
 */
export function layoutTreemap(node: TreeNodeMsg, rect: Rect, o: LayoutOptions = LAYOUT, depth = 1): Tile[] {
  // Biggest first, as squarify wants (the summed "rest" can outweigh the smallest shown child).
  const kids = (node.children ?? []).filter((k) => k.value > 0).sort((a, b) => b.value - a.value);
  const rects = squarify(kids.map((k) => k.value), rect);
  const tiles: Tile[] = [];
  kids.forEach((k, i) => {
    const r = rects[i];
    if (r.w < o.min || r.h < o.min) return;
    const inner = { x: r.x + o.pad, y: r.y + o.header, w: r.w - 2 * o.pad, h: r.h - o.header - o.pad };
    const frame = !!k.children?.length && inner.w >= 24 && inner.h >= 16;
    tiles.push({ ...r, node: k, depth, frame, label: r.w >= 36 && r.h >= 15 });
    if (frame) tiles.push(...layoutTreemap(k, inner, o, depth + 1));
  });
  return tiles;
}

/**
 * The tile an arrow key moves to: the nearest one whose center lies that way (a tile straight
 * ahead beats a closer one off to the side). Tiles: their rectangles; undefined at the edge.
 */
export function nearestTile(tiles: readonly Rect[], from: number, key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown"): number | undefined {
  const c = (t: Rect) => ({ x: t.x + t.w / 2, y: t.y + t.h / 2 });
  const a = c(tiles[from]);
  let best: number | undefined, score = Infinity;
  tiles.forEach((t, i) => {
    if (i === from) return;
    const b = c(t);
    const dx = b.x - a.x, dy = b.y - a.y;
    const ahead = key === "ArrowRight" ? dx : key === "ArrowLeft" ? -dx : key === "ArrowDown" ? dy : -dy;
    const side = key === "ArrowRight" || key === "ArrowLeft" ? Math.abs(dy) : Math.abs(dx);
    if (ahead <= 0.5) return;
    const s = ahead + 2 * side;
    if (s < score) { score = s; best = i; }
  });
  return best;
}

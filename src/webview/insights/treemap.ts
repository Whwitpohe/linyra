// Files and Commits: a squarified treemap of one folder, its folders nested inside. HTML tiles, theme colors only.
import { heatLevel, layoutTreemap, nearestTile, type Tile, type TreeNodeMsg } from "../../insights/treemap";
import type { InsightsRepo, TreeData } from "../../insights/protocol";
import { formatBytes, formatNumber } from "../../insights/format";
import { localize } from "../../i18n";
import { h } from "../dom";

export interface TreemapContext {
  repos: ReadonlyMap<string, InsightsRepo>;
  /** Show the folder at these keys (below the scope's root). */
  drill(path: string[]): void;
  select(node: TreeNodeMsg | undefined): void;
  tooltip(content: HTMLElement[] | undefined, at?: DOMRect): void;
  announce(text: string): void;
}

const ARROWS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

export const bytes = formatBytes;
const count = formatNumber;

/** A tile's measure in words: its size (Files) or its commits (Commits). */
export function valueText(tab: TreeData["tab"], value: number): string {
  return tab === "files" ? bytes(value) : localize(value === 1 ? "{0} commit" : "{0} commits", count(value));
}

/** What a tile is called: a "rest" tile sums the smaller files of its folder. */
export function nodeName(n: TreeNodeMsg): string {
  return n.kind === "rest" ? localize("{0} smaller files", count(n.files)) : n.name;
}

/** What a tile says to a screen reader and in its tooltip's first line. */
export function describeNode(tab: TreeData["tab"], n: TreeNodeMsg): string {
  const what = n.kind === "file" ? (n.path ?? n.name) : nodeName(n);
  return n.kind === "file" ? `${what}, ${valueText(tab, n.value)}` : localize("{0}, {1} in {2} files", what, valueText(tab, n.value), count(n.files));
}

export class TreemapView {
  private data: TreeData | undefined;
  private ctx: TreemapContext | undefined;
  private tiles: Tile[] = [];
  private els: HTMLElement[] = [];
  private focused: number | undefined;
  /** The focus ring, over the focused tile: a frame raised above its own tiles would hide them. */
  private readonly ring = h("div", { class: "tile-ring", "aria-hidden": "true", hidden: true });
  private selected: string | undefined;
  private frame = 0;
  /** The file types of the legend, in color order. */
  private types = new Map<string, number>();

  constructor(private readonly host: HTMLElement) {
    new ResizeObserver(() => this.schedule()).observe(host);
    host.addEventListener("keydown", (e) => this.key(e));
    host.addEventListener("focus", () => this.setFocus(this.focused ?? 0, true));
    host.addEventListener("blur", () => this.ctx?.tooltip(undefined));
    host.addEventListener("pointerover", (e) => {
      const i = this.indexOf(e.target);
      if (i !== undefined) this.ctx?.tooltip(this.tip(this.tiles[i].node), this.els[i].getBoundingClientRect());
    });
    host.addEventListener("pointerleave", () => this.ctx?.tooltip(undefined));
    host.addEventListener("click", (e) => {
      const i = this.indexOf(e.target);
      if (i === undefined) return;
      this.setFocus(i, false);
      this.activate(i);
    });
  }

  render(data: TreeData, ctx: TreemapContext): void {
    const changed = this.data?.node !== data.node;
    this.data = data;
    this.ctx = ctx;
    this.types = new Map(data.legend.map((l, i) => [l.ext, i]));
    if (changed) this.focused = undefined;
    this.draw();
  }

  /** The file whose strip shows below the map (kept across drawings by its key). */
  setSelected(key: string | undefined): void {
    this.selected = key;
    this.els.forEach((el, i) => el.classList.toggle("selected", key !== undefined && keyOf(this.tiles[i].node) === key));
  }

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.data && this.host.offsetParent !== null) this.draw();
    });
  }

  private placeRing(): void {
    const t = this.focused === undefined ? undefined : this.tiles[this.focused];
    this.ring.hidden = !t;
    if (!t) return;
    this.ring.style.left = `${t.x}px`;
    this.ring.style.top = `${t.y}px`;
    this.ring.style.width = `${t.w}px`;
    this.ring.style.height = `${t.h}px`;
  }

  private indexOf(target: EventTarget | null): number | undefined {
    const el = (target as Element | null)?.closest?.("[data-i]") as HTMLElement | null;
    const i = el ? Number(el.dataset.i) : NaN;
    return Number.isInteger(i) ? i : undefined;
  }

  private colorClass(n: TreeNodeMsg): string {
    const data = this.data!;
    if (n.kind === "rest") return "tile-rest";
    if (n.kind !== "file") return n.kind === "repo" ? `tile-folder accent-${this.ctx?.repos.get(n.repoId ?? "")?.accent ?? 0}` : "tile-folder";
    if (data.tab === "commits") return `heat-${heatLevel(n.value, data.heat)}`;
    const t = this.types.get(n.ext ?? "");
    return t === undefined ? "type-other" : `type-${t}`;
  }

  private tip(n: TreeNodeMsg): HTMLElement[] {
    const data = this.data!;
    const repo = n.repoId ? this.ctx?.repos.get(n.repoId) : undefined;
    const name = n.kind === "file" || n.kind === "folder" ? n.path ?? n.name : nodeName(n);
    const hint = n.kind === "file" ? localize("Click or press Enter to choose it") : n.kind === "rest" ? "" : n.children?.length || n.more ? localize("Click or press Enter to open it") : "";
    const lines: HTMLElement[] = [
      h("div", { class: "tip-subject" }, [name]),
      h("div", { class: "tip-line" }, [
        repo ? h("span", { class: `tip-repo accent-${repo.accent}` }, [repo.name]) : null,
        h("span", {}, [valueText(data.tab, n.value)]),
        n.kind === "file" ? null : h("span", { class: "tip-muted" }, [localize(n.files === 1 ? "{0} file" : "{0} files", count(n.files))]),
      ]),
    ];
    if (hint) lines.push(h("div", { class: "tip-hint" }, [hint]));
    return lines;
  }

  private draw(): void {
    const data = this.data;
    if (!data) return;
    const w = this.host.clientWidth, hgt = this.host.clientHeight;
    this.tiles = w > 0 && hgt > 0 ? layoutTreemap(data.node, { x: 0, y: 0, w, h: hgt }) : [];
    this.els = this.tiles.map((t, i) => {
      const n = t.node;
      const value = valueText(data.tab, n.value);
      const el = h("div", { class: `tile ${t.frame ? "frame" : "leaf"} kind-${n.kind} depth-${Math.min(t.depth, 4)} ${this.colorClass(n)}`, "data-i": String(i), "aria-hidden": "true" });
      el.style.left = `${t.x}px`;
      el.style.top = `${t.y}px`;
      el.style.width = `${t.w}px`;
      el.style.height = `${t.h}px`;
      if (t.label) {
        el.append(h("span", { class: "tile-name" }, [nodeName(n)]));
        if (t.frame || t.h >= 32) el.append(h("span", { class: "tile-value" }, [value]));
      }
      if (keyOf(n) === this.selected) el.classList.add("selected");
      return el;
    });
    this.host.replaceChildren(...this.els, this.ring);
    if (this.focused !== undefined && this.focused >= this.els.length) this.focused = undefined;
    this.placeRing();
  }

  /** A folder opens (it has children to show); a file is chosen (its strip below the map). */
  private activate(i: number): void {
    const n = this.tiles[i]?.node;
    if (!n || !this.data || !this.ctx) return;
    if (n.kind === "file") { this.ctx.select(n); return; }
    if (n.kind === "rest" || !(n.children?.length || n.more)) return;
    this.ctx.drill([...this.data.path, ...this.keysTo(i)]);
  }

  /**
   * The keys from the shown folder down to tile i: its frames, then itself. Tiles come parents
   * first (layoutTreemap), so a tile's frame is the nearest one before it a level up.
   */
  private keysTo(i: number): string[] {
    const keys: string[] = [];
    let depth = this.tiles[i].depth;
    for (let j = i; j >= 0 && depth > 0; j--) {
      if (this.tiles[j].depth !== depth) continue;
      const n = this.tiles[j].node;
      keys.unshift(n.kind === "repo" ? n.repoId! : n.name);
      depth--;
    }
    return keys;
  }

  private key(e: KeyboardEvent): void {
    if (!this.tiles.length || !this.data) return;
    if (ARROWS.has(e.key)) {
      e.preventDefault();
      const next = this.focused === undefined ? 0 : nearestTile(this.tiles, this.focused, e.key as "ArrowLeft");
      if (next !== undefined) this.setFocus(next, true);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      this.setFocus(e.key === "Home" ? 0 : this.tiles.length - 1, true);
    } else if ((e.key === "Enter" || e.key === " ") && this.focused !== undefined) {
      e.preventDefault();
      this.activate(this.focused);
    } else if ((e.key === "Backspace" || (e.key === "ArrowUp" && e.altKey)) && this.data.path.length) {
      e.preventDefault();
      this.ctx?.drill(this.data.path.slice(0, -1));
    } else if (e.key === "Escape") {
      this.ctx?.tooltip(undefined);
    }
  }

  private setFocus(i: number, announce: boolean): void {
    if (!this.els.length) return;
    i = Math.max(0, Math.min(this.els.length - 1, i));
    this.focused = i;
    this.placeRing();
    if (!announce || !this.data || !this.ctx) return;
    const n = this.tiles[i].node;
    this.ctx.tooltip(this.tip(n), this.els[i].getBoundingClientRect());
    this.ctx.announce(describeNode(this.data.tab, n));
  }
}

/** A file's identity across drawings: its repository and path. */
export const keyOf = (n: TreeNodeMsg): string | undefined => (n.kind === "file" ? `${n.repoId}\0${n.path}` : undefined);

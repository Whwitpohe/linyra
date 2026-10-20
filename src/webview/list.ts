import { commitKey, type Commit } from "../types";
import { clear, h } from "./dom";
import { fitName, textStyle } from "./measure";
import { absoluteTime, accentOf, moveSelection, relativeTime, visibleRange } from "./view";

/** How a row was selected: a click (with Ctrl/⌘ or Shift), a key, or a right-click. */
export type Gesture = { kind: "click"; ctrl: boolean; shift: boolean } | { kind: "arrow"; shift: boolean } | { kind: "context" };

export interface ListProps {
  rows: readonly Commit[];
  repoNames: ReadonlyMap<string, string>;
  /** Each repository's hue (view.ts assignAccents), fixed for the repo list. */
  accents: ReadonlyMap<string, number>;
  /** Repositories with commits to pull: their rows' menu offers Pull. */
  behind?: ReadonlySet<string>;
  /** File history: the file's current path, to flag rows where it had another name. */
  historyPath?: string;
  /** The active row (the keyboard's). */
  selected: number;
  /** Every selected row, as commitKey: several for Combined Changes. */
  selectedKeys: ReadonlySet<string>;
  now: number;
  skeleton: boolean;
}

const SKELETON_ROWS = 8;

/**
 * Virtualized commit grid. Only visible rows exist in the DOM. The grid is one
 * tab stop; the selected row is exposed through aria-activedescendant because
 * recycled rows cannot hold focus themselves.
 */
export class CommitList {
  private rowHeight = 0;
  private frame = 0;
  /** The repo column's width, read once per layout change rather than on every scroll paint. */
  private column: number | undefined;
  private props: ListProps = { rows: [], repoNames: new Map(), accents: new Map(), historyPath: undefined, selected: -1, selectedKeys: new Set(), now: 0, skeleton: false };

  constructor(
    private readonly root: HTMLElement,
    private readonly body: HTMLElement,
    private readonly onSelect: (index: number, how: Gesture) => void,
    private readonly onOpen: () => void,
  ) {
    // Ctrl/⌘ and Shift select several commits (Combined Changes).
    root.setAttribute("aria-multiselectable", "true");
    // Several scroll events can arrive per frame: paint once, before the frame.
    root.addEventListener("scroll", () => {
      if (this.frame) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.paint();
      });
    }, { passive: true });
    window.addEventListener("resize", () => {
      this.rowHeight = 0;
      this.column = undefined;
      this.paint();
    });
    // Dragging a divider narrows the Log without a window resize: re-fit the repo names.
    new ResizeObserver(() => {
      this.column = undefined;
      this.fitChips();
    }).observe(root);
    root.addEventListener("keydown", (e) => this.onKey(e));
    body.addEventListener("click", (e) => {
      const row = (e.target as Element).closest<HTMLElement>(".row[data-index]");
      if (!row) return;
      root.focus();
      this.onSelect(Number(row.dataset.index), { kind: "click", ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });
    });
    // A right-click outside the selection selects that row first, as VS Code's lists do.
    body.addEventListener("contextmenu", (e) => {
      const row = (e.target as Element).closest<HTMLElement>(".row[data-index]");
      if (row) this.onSelect(Number(row.dataset.index), { kind: "context" });
    });
  }

  update(next: ListProps): void {
    const moved = next.selected !== this.props.selected;
    this.props = next;
    this.column = undefined; // the repo column may have changed with the repo list
    if (moved && next.selected >= 0) this.scrollToIndex(next.selected);
    this.paint();
  }

  resetScroll(): void {
    this.root.scrollTop = 0;
  }

  private height(): number {
    if (this.rowHeight === 0) {
      const probe = h("div", { class: "row" }, [h("span", { class: "subject" }, ["M"])]);
      probe.style.visibility = "hidden";
      this.body.append(probe);
      this.rowHeight = probe.offsetHeight || 40;
      probe.remove();
    }
    return this.rowHeight;
  }

  private place(el: HTMLElement, i: number): HTMLElement {
    el.style.transform = `translateY(${i * this.height()}px)`;
    return el;
  }

  private paint(): void {
    const { rows, selected, skeleton } = this.props;
    const rh = this.height();
    clear(this.body);
    this.root.setAttribute("aria-busy", String(skeleton));
    if (skeleton) {
      this.body.style.height = `${SKELETON_ROWS * rh}px`;
      for (let i = 0; i < SKELETON_ROWS; i++) {
        this.body.append(this.place(h("div", { class: "row skeleton", "aria-hidden": "true" }, [
          h("span", { class: "bar short" }), h("span", { class: "bar" }), h("span", { class: "bar short" }), h("span", { class: "bar short" }),
        ]), i));
      }
      this.root.setAttribute("aria-rowcount", "0");
      this.root.removeAttribute("aria-activedescendant");
      return;
    }
    this.body.style.height = `${rows.length * rh}px`;
    this.root.setAttribute("aria-rowcount", String(rows.length));
    const { start, end } = visibleRange(this.root.scrollTop, this.root.clientHeight, rh, rows.length);
    for (let i = start; i < end; i++) this.body.append(this.place(this.renderRow(rows[i], i), i));
    this.fitChips();
    if (selected >= 0 && selected < rows.length) this.root.setAttribute("aria-activedescendant", `row-${selected}`);
    else this.root.removeAttribute("aria-activedescendant");
  }

  /**
   * A repo name longer than its column is cut in the middle, to exactly what fits: repos
   * that share a prefix differ at the end, and the browser's own ellipsis would hide it.
   * The full name stays in the chip's tooltip and accessible name.
   */
  private fitChips(): void {
    const first = this.body.querySelector<HTMLElement>(".row:not(.skeleton)");
    if (!first) return;
    const column = (this.column ??= parseFloat(getComputedStyle(first).gridTemplateColumns.split(" ")[0]));
    if (!Number.isFinite(column)) {
      this.column = undefined;
      return;
    }
    const chips = [...this.body.querySelectorAll<HTMLElement>(".row .chip")];
    if (chips.length === 0) return;
    // Every chip shares one font and padding: read them once, then only write.
    const { font, paddingX } = textStyle(chips[0]);
    for (const chip of chips) chip.textContent = fitName(font, chip.dataset.name ?? "", column - paddingX);
  }

  /** One line, like an IDE log: repo chip | subject | author | date. */
  private renderRow(c: Commit, i: number): HTMLElement {
    const accent = accentOf(this.props.accents, c.repoId);
    const name = this.props.repoNames.get(c.repoId) ?? c.repoId;
    const focus = i === this.props.selected;
    return h("div", {
      class: focus ? "row focus" : "row",
      role: "row",
      id: `row-${i}`,
      "aria-rowindex": String(i + 1),
      "aria-selected": String(this.props.selectedKeys.has(commitKey(c))),
      "data-index": String(i),
      // Right-click: the commit's and its repository's menu (package.json webview/context), not
      // Cut/Copy/Paste. File History is one file of one repository: no repo filter items there.
      "data-vscode-context": JSON.stringify({ webviewSection: this.props.historyPath ? "historyCommit" : "commit", repoId: c.repoId, sha: c.sha, behind: this.props.behind?.has(c.repoId) === true, preventDefaultContextMenuItems: true }),
    }, [
      h("span", { class: `chip accent-${accent}`, role: "gridcell", title: c.ref ? `${name} — ${c.ref}` : name, "aria-label": c.ref ? `${name} — ${c.ref}` : name, "data-name": name }, [name]),
      h("span", { class: "subject", role: "gridcell", title: c.subject }, [
        c.subject,
        // File history: the file had another name in this commit.
        this.props.historyPath && c.file && c.file.path !== this.props.historyPath ? h("span", { class: "was-path" }, [` — ${c.file.path}`]) : null,
      ]),
      h("span", { class: "author", role: "gridcell" }, [c.author]),
      h("span", { class: "date", role: "gridcell", title: absoluteTime(c.time) }, [relativeTime(this.props.now, c.time)]),
    ]);
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === "Enter") {
      e.preventDefault();
      this.onOpen();
      return;
    }
    const page = Math.max(1, Math.floor(this.root.clientHeight / this.height()) - 1);
    const next = moveSelection(e.key, this.props.selected, this.props.rows.length, page);
    if (next === null) return;
    e.preventDefault();
    this.onSelect(next, { kind: "arrow", shift: e.shiftKey });
  }

  private scrollToIndex(i: number): void {
    const rh = this.height();
    const top = i * rh;
    if (top < this.root.scrollTop) this.root.scrollTop = top;
    else if (top + rh > this.root.scrollTop + this.root.clientHeight) this.root.scrollTop = top + rh - this.root.clientHeight;
  }
}

import "./hoverCard.css";
import type { RefSegment } from "../commitReferences";
import { localize } from "../i18n";
import { authorLabel, bodyOf, filesLabel, mergeTargetLabel, whenLabel, type HoverDetail, type MergeTarget } from "../hoverModel";
import type { HostMessage, WebviewMessage } from "../protocol";
import type { Commit } from "../types";
import { codiconElement, type Codicon } from "./codicons";
import { clear, h } from "./dom";
import { pillElement } from "./refPills";
import { authorDiscHtml } from "./ui/authorDisc";
import { renderCounts, renderLines } from "./ui/counts";
import type { HostRoutes } from "./hostRoutes";

/** What the card draws the moment it opens, from the row alone (CommitList.hoverRow). */
export interface HoverRow {
  commit: Commit;
  repoName: string;
  accent: number;
  /** The repository's user.email wrote it: the card says "You". */
  mine: boolean;
  pills: RefSegment[][];
  now: number;
}

export interface HoverSource {
  /** The commit at a row's data-index (cheap: asked on every pointer move). */
  commit(index: number): Commit | undefined;
  row(index: number): HoverRow | undefined;
}

type Action = Extract<WebviewMessage, { type: "hoverAction" }>["action"];

/** Where on a row the card is offered: the subject, the graph's node, the author, the date, the hash, the "+N" of hidden pills. */
const TRIGGERS = ".subject, [data-graph-node]:not(.graph-fold-control), .author, .date, .hash, .row-ref-more";
/** The pointer rests this long on a row before the card opens (VS Code's hover waits about as long). */
export const SHOW_MS = 500;
/** Time to cross from the row into the card, or back, before it closes. */
const LEAVE_MS = 250;
const GAP = 2;
const MARGIN = 8;

const keyOf = (c: Pick<Commit, "repoId" | "sha">) => `${c.repoId}\0${c.sha}`;

/**
 * The commit hover card, as GitLens shows one over its graph: who, when, which repository and
 * branches, at once from the row; then the whole message and what changed, from one git show the
 * host runs only once the card is open (never for rows the pointer merely crosses) and kills when
 * it closes. Leaving the row, a scroll, a key or the window losing focus closes it; the pointer
 * can move into it to use its links, and it never takes focus.
 */
export class HoverCard {
  private readonly el = h("div", { class: "hover-card", id: "hover-card", role: "tooltip", hidden: true });
  private restTimer: ReturnType<typeof setTimeout> | undefined;
  private leaveTimer: ReturnType<typeof setTimeout> | undefined;
  private copiedTimer: ReturnType<typeof setTimeout> | undefined;
  private pointer = { x: 0, y: 0 };
  private shown: {
    index: number; key: string; row: HoverRow; anchor: DOMRect; below: boolean;
    detail?: HoverDetail; error?: string; explain?: boolean; target?: MergeTarget; copied?: boolean;
  } | undefined;
  /** A pill in the card was clicked: the branch in the Repo List (main.ts). */
  onReveal: (repoId: string, ref: string) => void = () => undefined;

  constructor(scroller: HTMLElement, private readonly rows: HTMLElement, private readonly source: HoverSource, private readonly post: (m: WebviewMessage) => void) {
    document.body.append(this.el);
    rows.addEventListener("pointermove", (e) => this.move(e));
    rows.addEventListener("pointerleave", () => this.leaveSoon());
    // In the card: it stays, and a row crossed on the way in opens nothing.
    this.el.addEventListener("pointerenter", () => { clearTimeout(this.leaveTimer); clearTimeout(this.restTimer); });
    this.el.addEventListener("pointerleave", () => this.leaveSoon());
    // A press in the card leaves focus where it was (the Log's list, a box): it is a tooltip.
    this.el.addEventListener("mousedown", (e) => e.preventDefault());
    this.el.addEventListener("click", (e) => this.click(e));
    scroller.addEventListener("scroll", () => this.hide(), { passive: true });
    window.addEventListener("blur", () => this.hide());
    // Any key closes it (Esc too); capture, so a key the list handles closes it as well.
    document.addEventListener("keydown", () => this.hide(), true);
  }

  get open(): boolean { return this.shown !== undefined; }

  private move(e: PointerEvent): void {
    if (e.pointerType === "touch") return;
    const target = e.target as Element;
    const rowEl = target.closest<HTMLElement>(".row[data-index]");
    const index = rowEl && !rowEl.classList.contains("folded-row") && target.closest(TRIGGERS) ? Number(rowEl.dataset.index) : undefined;
    const commit = index === undefined ? undefined : this.source.commit(index);
    if (commit && this.shown?.key === keyOf(commit)) { clearTimeout(this.leaveTimer); return; }
    clearTimeout(this.restTimer);
    if (this.shown) this.leaveSoon();
    if (index === undefined || !commit) return;
    // Rests: every move starts the wait again, so a pointer passing over rows opens nothing.
    this.pointer = { x: e.clientX, y: e.clientY };
    this.restTimer = setTimeout(() => this.show(index), SHOW_MS);
  }

  private leaveSoon(): void {
    clearTimeout(this.restTimer);
    clearTimeout(this.leaveTimer);
    if (this.shown) this.leaveTimer = setTimeout(() => this.hide(), LEAVE_MS);
  }

  private show(index: number): void {
    const rowEl = this.rows.querySelector<HTMLElement>(`.row[data-index="${index}"]`);
    const row = rowEl ? this.source.row(index) : undefined;
    if (!rowEl || !row) return;
    this.hide();
    const anchor = rowEl.getBoundingClientRect();
    // Below the row unless the panel has more room above it; the side holds while the detail arrives.
    const below = window.innerHeight - anchor.bottom >= 220 || window.innerHeight - anchor.bottom >= anchor.top;
    this.shown = { index, key: keyOf(row.commit), row, anchor, below };
    this.render();
    this.el.hidden = false;
    this.place();
    this.post({ type: "hover", repoId: row.commit.repoId, sha: row.commit.sha });
  }

  /** Closes the card and kills its read. A card about to open does not open. */
  hide(): void {
    clearTimeout(this.restTimer);
    clearTimeout(this.leaveTimer);
    clearTimeout(this.copiedTimer);
    if (!this.shown) return;
    this.shown = undefined;
    this.el.hidden = true;
    clear(this.el);
    this.post({ type: "hoverEnd" });
  }

  /** The host's git show (and the HEAD row's merge target) for the card, if it still shows that commit. */
  register(routes: HostRoutes): void {
    routes.on("hoverDetail", (m) => this.receive(m));
  }

  receive(m: Extract<HostMessage, { type: "hoverDetail" }>): void {
    const s = this.shown;
    if (!s || s.key !== keyOf(m)) return;
    if (m.detail || m.error !== undefined) Object.assign(s, { detail: m.detail, error: m.error, explain: m.explain === true });
    if (m.target) s.target = m.target;
    this.render();
    this.place();
  }

  private place(): void {
    const s = this.shown;
    if (!s) return;
    const width = Math.min(440, window.innerWidth - 2 * MARGIN);
    this.el.style.width = `${width}px`;
    this.el.style.left = `${Math.max(MARGIN, Math.min(this.pointer.x - 16, window.innerWidth - width - MARGIN))}px`;
    // The edge at the row stays put: a card that grows with its detail grows away from the pointer.
    if (s.below) {
      this.el.style.top = `${s.anchor.bottom + GAP}px`;
      this.el.style.bottom = "";
      this.el.style.maxHeight = `${Math.max(120, window.innerHeight - s.anchor.bottom - GAP - MARGIN)}px`;
    } else {
      this.el.style.top = "";
      this.el.style.bottom = `${window.innerHeight - s.anchor.top + GAP}px`;
      this.el.style.maxHeight = `${Math.max(120, s.anchor.top - GAP - MARGIN)}px`;
    }
  }

  private click(e: MouseEvent): void {
    const s = this.shown;
    if (!s) return;
    const pill = (e.target as Element).closest<HTMLElement>(".pill-part[data-ref], .pill[data-ref]");
    if (pill?.dataset.repo && pill.dataset.ref) {
      const { repo, ref } = pill.dataset;
      this.hide();
      this.onReveal(repo, ref);
      return;
    }
    const action = (e.target as Element).closest<HTMLElement>("[data-action]")?.dataset.action as Action | undefined;
    if (!action) return;
    this.post({ type: "hoverAction", action, repoId: s.row.commit.repoId, sha: s.row.commit.sha });
    if (action !== "copySha") { this.hide(); return; }
    s.copied = true;
    this.render();
    clearTimeout(this.copiedTimer);
    this.copiedTimer = setTimeout(() => { if (this.shown === s) { s.copied = false; this.render(); } }, 1500);
  }

  private link(action: Action, icon: Codicon, label: string): HTMLElement {
    return h("button", { type: "button", class: "link hover-link", tabindex: "-1", "data-action": action }, [codiconElement(icon, "hover-icon"), label]);
  }

  private render(): void {
    const s = this.shown;
    if (!s) return;
    const { row } = s, c = row.commit;
    const hash = h("button", { type: "button", class: "link hover-hash", tabindex: "-1", "data-action": "copySha", "aria-label": localize("Copy Commit SHA") },
      s.copied ? [codiconElement("check", "hover-icon"), localize("Copied")] : [codiconElement("git-commit", "hover-icon"), c.sha.slice(0, 8)]);
    const body = s.detail ? bodyOf(s.detail.message) : "";
    const main = h("div", { class: "hover-main" }, [
      h("div", { class: "hover-head" }, [
        authorDiscHtml({ name: c.author, email: c.email, accent: row.accent, mine: row.mine }, 32),
        h("div", { class: "hover-who" }, [
          h("div", { class: "hover-line" }, [h("span", { class: "hover-author" }, [authorLabel(c.author, row.mine)]), h("span", { class: "hover-when" }, [whenLabel(row.now, c.time)])]),
          h("div", { class: "hover-line" }, [h("span", { class: `hover-repo accent-${row.accent}` }, [row.repoName]), hash]),
        ]),
      ]),
      h("div", { class: "hover-subject" }, [c.subject]),
      body ? h("div", { class: "hover-body" }, [body]) : null,
      s.error !== undefined ? h("div", { class: "hover-note" }, [localize("Could not read the commit: {0}", s.error)])
        : s.detail ? null : h("div", { class: "hover-note hover-loading" }, [localize("Reading the commit…")]),
      row.pills.length ? h("div", { class: "hover-refs" }, row.pills.map((p) => pillElement(c.repoId, p))) : null,
      s.detail ? h("div", { class: "hover-stats" }, [
        renderCounts(s.detail.kinds), h("span", { class: "hover-files" }, [filesLabel(s.detail.files)]), renderLines(s.detail.added, s.detail.deleted),
      ]) : null,
      s.target ? h("div", { class: "hover-target" }, [
        codiconElement("target", "hover-icon"), h("span", { class: "hover-target-label" }, [mergeTargetLabel(s.target)]), this.link("compare", "git-compare", localize("Compare")),
      ]) : null,
    ]);
    clear(this.el);
    this.el.append(main, h("div", { class: "hover-actions" }, [
      this.link("copySha", "copy", localize("Copy Hash")),
      this.link("openOnRemote", "cloud", localize("Open on Remote")),
      s.explain ? this.link("explain", "sparkle", localize("Explain")) : null,
    ]));
  }
}

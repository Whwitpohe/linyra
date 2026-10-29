import "./branchSheet.css";
import { acrossActions, acrossState, acrossSummary, acrossText, kindLabel, nextSteps, targetCard, upstreamCard, worktreeName, type AcrossRow, type BranchSheetData, type SheetAction, type SheetCard, type SheetKind } from "../branchSheetModel";
import { localize } from "../i18n";
import type { HostMessage, WebviewMessage } from "../protocol";
import { codiconElement } from "./codicons";
import { byId, h } from "./dom";
import { absoluteTime, relativeTime } from "./view";
import type { HostRoutes } from "./hostRoutes";

type SheetMessage = Extract<HostMessage, { type: "branchSheet" }>;

const kindOf = (ref: string): SheetKind => (ref.startsWith("refs/remotes/") ? "remote" : ref.startsWith("refs/tags/") ? "tag" : "local");
const nameOf = (ref: string): string => ref.replace(/^refs\/(heads|remotes|tags)\//, "");
const ICONS: Record<SheetKind, "git-branch" | "cloud" | "tag"> = { local: "git-branch", remote: "cloud", tag: "tag" };
let ids = 0;

/**
 * The branch sheet: a branch pill's click shows the branch in the Changes view's details area, in
 * place of the commit details — its tip, upstream and merge target, and the next steps, each a
 * button for a command Linyra already has. Selecting another row, Esc or × brings the details back.
 */
export class BranchSheetView {
  private readonly root = byId("branch-sheet");
  private readonly changes = byId("changes");
  /** Read out once the sheet is read (opening it moves nothing a screen reader would notice). */
  private readonly announce = h("div", { class: "sheet-announce", role: "status" });
  private shown: { repoId: string; ref: string; focus: boolean } | undefined;
  /** The sheet's data, for the Across repositories card drawn when its read arrives. */
  private data: BranchSheetData | undefined;

  constructor(private readonly post: (m: WebviewMessage) => void, private readonly host: {
    /** The Repo List's place for the branch (the pill click's old meaning, now the sheet's first button). */
    reveal(repoId: string, ref: string): void;
    accent(repoId: string): number;
    repoName(repoId: string): string;
    /** The tip's id: select that commit in the Log. */
    selectCommit(repoId: string, sha: string): void;
    /** The sheet opened for this branch (its pills are marked in the Log); no argument: it closed. */
    mark(repoId?: string, ref?: string): void;
  }) {
    document.body.append(this.announce);
    this.root.addEventListener("click", (e) => {
      // A card's branch name: that branch's own sheet (from the keyboard, the focus goes with it).
      const link = (e.target as Element).closest<HTMLButtonElement>("button[data-open]");
      if (link && this.shown) { this.open(this.shown.repoId, link.dataset.open!, e.detail === 0); return; }
      // Across repositories: a row is that repository's sheet of the same ref.
      const other = (e.target as Element).closest<HTMLButtonElement>("button[data-open-repo]");
      if (other && this.shown) { this.open(other.dataset.openRepo!, this.shown.ref, e.detail === 0); return; }
      const read = (e.target as Element).closest<HTMLButtonElement>('button[data-action="across"]');
      if (read) { read.disabled = true; read.textContent = localize("Reading the ticked repositories…"); }
      const button = (e.target as Element).closest<HTMLButtonElement>("button[data-action]");
      if (!button || !this.shown) return;
      const { repoId, ref } = this.shown;
      const action = button.dataset.action!;
      if (action === "close") { this.close(true); return; }
      if (action === "reveal") { this.host.reveal(repoId, ref); return; }
      if (action === "tip") { this.host.selectCommit(repoId, button.dataset.sha ?? ""); return; }
      this.post({ type: "branchSheet", action: action as SheetAction | "copy", repoId, ref });
    });
    this.root.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this.close(true); } });
  }

  isOpen(): boolean {
    return this.shown !== undefined;
  }

  /**
   * Opens the sheet: the header at once, the rest once the host has read it. `focus`: opened from
   * the keyboard (the pill's Show Branch Details), so the sheet takes the focus once it is read.
   */
  open(repoId: string, ref: string, focus = false): void {
    this.shown = { repoId, ref, focus };
    this.host.mark(repoId, ref);
    this.changes.classList.add("branch-open");
    // Folded details unfold: the sheet is what was asked for.
    const toggle = document.getElementById("detail-toggle");
    if (toggle?.getAttribute("aria-expanded") === "false") document.getElementById("detail-heading")?.click();
    this.render({ kind: kindOf(ref), name: nameOf(ref), repoId, current: false }, [h("p", { class: "sheet-note" }, [localize("Reading…")])]);
    this.post({ type: "branchSheet", action: "open", repoId, ref });
  }

  /** The commit details again (another row selected, Esc, ×); the focus back on the Log when it was in the sheet. */
  close(focusList = false): void {
    if (!this.shown) return;
    const { repoId, ref } = this.shown;
    this.shown = undefined;
    this.host.mark();
    this.changes.classList.remove("branch-open");
    this.root.replaceChildren();
    this.post({ type: "branchSheet", action: "close", repoId, ref });
    if (focusList) document.getElementById("list")?.focus();
  }

  register(routes: HostRoutes): void {
    routes.on("branchSheet", (m) => this.receive(m));
  }

  receive(m: SheetMessage): void {
    if (!this.shown || this.shown.repoId !== m.repoId || this.shown.ref !== m.ref) return;
    if (m.across) { this.showAcross(m.across); return; }
    const head = { kind: kindOf(m.ref), name: nameOf(m.ref), repoId: m.repoId, current: m.data?.current ?? false, worktree: m.data?.worktree };
    const gone = localize("This branch no longer exists.");
    if (m.missing) { this.render(head, [h("p", { class: "sheet-note" }, [gone])]); this.say(gone); return; }
    if (m.error || !m.data) { this.render(head, [h("p", { class: "sheet-note error" }, [localize("Linyra could not read the branch: {0}", m.error ?? "")])]); return; }
    const d = this.data = m.data;
    // One thing to do next: the first card's primary button stays primary, later ones are secondary.
    let primaryShown = false;
    const shownCards = [upstreamCard(d), targetCard(d)].filter((c): c is SheetCard => !!c);
    const cards = shownCards.map((c) => {
      const card = this.card({ ...c, buttons: c.buttons.map((b) => ({ ...b, primary: b.primary && !primaryShown })) });
      if (c.buttons.some((b) => b.primary)) primaryShown = true;
      return card;
    });
    const steps = nextSteps(d);
    this.render(head, [
      this.tip(d),
      ...cards,
      this.group({ title: localize("Next steps") }, steps.map((s) => h("div", { class: "sheet-step" }, [
        h("span", { class: "step-icon", "aria-hidden": "true" }, [codiconElement(s.icon)]), h("span", { class: "step-text" }, [s.text]), this.button(s.action, s.label)])), "sheet-steps"),
      // Where else the ref is: read when asked (one git process per ticked repository).
      this.group({ title: localize("Across repositories") }, [
        h("p", { class: "card-status" }, [localize("Where {0} is in the other ticked repositories, and how it stands there.", d.name)]),
        h("div", { class: "card-buttons" }, [this.button("across", localize("Show in All Repositories"))]),
      ], "sheet-across"),
    ]);
    // "Branch develop. Diverged, origin/develop. 2 files conflict, origin/main."
    this.say([`${kindLabel(d.kind)} ${d.name}`, ...shownCards.map((c) => [c.chip?.text ?? c.status, c.subject].filter(Boolean).join(", "))].join(". "));
    if (this.shown.focus) { this.shown.focus = false; this.root.focus(); }
  }

  /** Across repositories, read: the summary, each repository that has the ref, the rest in one line, what to do. */
  private showAcross(rows: readonly AcrossRow[]): void {
    const d = this.data, card = this.root.querySelector<HTMLElement>(".sheet-across");
    if (!d || !card) return;
    const have = rows.filter((r) => r.has), missing = rows.filter((r) => !r.has);
    const summary = acrossSummary(d.kind, d.name, rows);
    const list = h("ul", { class: "across-list" }, have.map((r) => h("li", {}, [
      h("button", { type: "button", class: `across-row${r.repoId === d.repoId ? " here" : ""}`, "data-open-repo": r.repoId,
        title: localize("Show {0} in {1}", d.name, r.repoName) }, [
        h("span", { class: `repo-dot accent-${this.host.accent(r.repoId)}`, "aria-hidden": "true" }),
        h("span", { class: "across-name" }, [r.repoName]),
        r.current ? h("span", { class: "sheet-badge" }, [localize("checked out")]) : null,
        h("span", { class: `across-state ${acrossState(d.kind, r)}` }, [acrossText(d.kind, r)]),
      ]),
    ])));
    const names = missing.map((r) => r.repoName).join(", ");
    const actions = acrossActions(d.kind, rows);
    card.replaceChildren(...[
      card.querySelector(".card-title"),
      h("p", { class: "card-status" }, [summary]),
      have.length ? list : null,
      missing.length ? h("p", { class: "card-hint", title: names }, [missing.length <= 4 ? localize("Not in {0}.", names) : localize("Not in {0} other repositories.", missing.length)]) : null,
      actions.length ? h("div", { class: "card-buttons" }, actions.map((a) => this.button(a.action, a.label))) : null,
    ].filter((x): x is Element => !!x));
    this.say(summary);
  }

  private say(text: string): void {
    this.announce.textContent = "";
    // A fresh text: read out even when it is the same as the last one.
    requestAnimationFrame(() => { this.announce.textContent = text; });
  }

  private render(head: { kind: SheetKind; name: string; repoId: string; current: boolean; worktree?: string }, body: (HTMLElement | null)[]): void {
    const accent = this.host.accent(head.repoId);
    const kind = kindLabel(head.kind);
    // The details heading says what the area shows: Branch, Remote Branch or Tag.
    const heading = document.querySelector(".detail-heading-branch");
    if (heading) heading.textContent = kind;
    this.root.replaceChildren(
      h("header", { class: "sheet-head" }, [
        h("span", { class: "sheet-kind", "aria-hidden": "true" }, [codiconElement(ICONS[head.kind])]),
        h("h3", { class: "sheet-name", title: head.name }, [head.name]),
        head.current ? h("span", { class: "sheet-badge" }, [localize("checked out")])
          : head.worktree ? h("span", { class: "sheet-badge", title: head.worktree }, [localize("in worktree {0}", worktreeName(head.worktree))]) : null,
        h("span", { class: "sheet-tools" }, [
          this.icon("reveal", "target", localize("Reveal in Repo List")),
          this.icon("copy", "copy", localize("Copy Name")),
          this.icon("close", "close", localize("Close (Esc)")),
        ]),
        h("span", { class: "sheet-repo", title: this.host.repoName(head.repoId) }, [h("span", { class: `repo-dot accent-${accent}`, "aria-hidden": "true" }), this.host.repoName(head.repoId)]),
      ]),
      ...body.filter((x): x is HTMLElement => !!x),
    );
    this.root.setAttribute("aria-label", `${kind} ${head.name}`);
  }

  private tip(d: BranchSheetData): HTMLElement {
    const when = d.tip.time ? relativeTime(Date.now() / 1000, d.tip.time) : "";
    const short = d.tip.sha.slice(0, 7);
    return h("div", { class: "sheet-tip" }, [
      h("button", { type: "button", class: "sheet-sha", "data-action": "tip", "data-sha": d.tip.sha, title: localize("Select this commit in the Log"), "aria-label": localize("Select commit {0}", short) }, [short]),
      h("span", { class: "tip-subject", title: d.tip.subject }, [d.tip.subject]),
      h("span", { class: "tip-meta", title: d.tip.time ? absoluteTime(d.tip.time) : "" }, [[d.tip.author, when].filter(Boolean).join(" · ")]),
    ]);
  }

  /**
   * A card: a group named by its heading (not a landmark of its own). Its branch name links to that
   * branch's sheet; a pencil beside it changes it (Change Upstream…).
   */
  private group(head: Pick<SheetCard, "title" | "subject" | "subjectRef" | "chip" | "edit">, body: (HTMLElement | null)[], extra = ""): HTMLElement {
    const id = `sheet-card-${++ids}`;
    const { title, subject, subjectRef, chip, edit } = head;
    return h("div", { class: `sheet-card${extra ? ` ${extra}` : ""}`, role: "group", "aria-labelledby": id }, [
      h("h4", { class: "card-title", id }, [
        h("span", {}, [title]),
        subject && subjectRef ? h("button", { type: "button", class: "card-subject link", "data-open": subjectRef, title: localize("Show {0}", subject) }, [subject])
          : subject ? h("span", { class: "card-subject" }, [subject]) : null,
        edit ? this.icon(edit.action, "edit", edit.label) : null,
        chip ? h("span", { class: `chip ${chip.tone}` }, [chip.text]) : null,
      ]),
      ...body,
    ]);
  }

  private card(c: SheetCard): HTMLElement {
    return this.group(c, [
      h("p", { class: "card-status" }, [c.status]),
      c.hint ? h("p", { class: "card-hint" }, [c.hint]) : null,
      c.buttons.length > 0 ? h("div", { class: "card-buttons" }, c.buttons.map((b) => this.button(b.action, b.label, b.primary))) : null,
    ]);
  }

  private button(action: SheetAction, label: string, primary = false): HTMLElement {
    return h("button", { type: "button", class: `sheet-button${primary ? " primary" : ""}`, "data-action": action }, [label]);
  }

  private icon(action: string, icon: "target" | "copy" | "close" | "edit", label: string): HTMLElement {
    return h("button", { type: "button", class: "icon-button", "data-action": action, title: label, "aria-label": label }, [codiconElement(icon)]);
  }
}

// Repository Health: one row per repository, one column per check; the selected row's details below.
import { checkInfo, CHECKS, type HealthCheck, type HealthRow } from "../../insights/health";
import { formatNumber } from "../../insights/format";
import type { HealthActionKind, HealthData, InsightsRepo } from "../../insights/protocol";
import { localize } from "../../i18n";
import { codiconElement, type Codicon } from "../codicons";
import { h } from "../dom";

export interface HealthContext {
  repos: ReadonlyMap<string, InsightsRepo>;
  act(action: HealthActionKind, repoIds: string[], key?: string, value?: boolean): void;
}

const ICONS: Record<HealthCheck["status"], Codicon | undefined> = { ok: "pass", suggest: "lightbulb", info: undefined, unknown: "dash" };

export function statusLabel(status: HealthCheck["status"]): string {
  return status === "ok" ? localize("Fine") : status === "suggest" ? localize("Suggestion") : status === "unknown" ? localize("Unknown") : "";
}

/** A VS Code checkbox: the theme's box and check, a real checkbox to assistive technology. */
function checkbox(checked: boolean, label: string, onChange: (on: boolean) => void): HTMLButtonElement {
  const box = h("button", { type: "button", class: "health-check-box", role: "checkbox", "aria-checked": checked ? "true" : "false", "aria-label": label, title: label },
    [checked ? codiconElement("check") : null]);
  box.addEventListener("click", (e) => { e.stopPropagation(); onChange(box.getAttribute("aria-checked") !== "true"); });
  return box;
}

export class HealthView {
  private data: HealthData | undefined;
  private ctx: HealthContext | undefined;
  /** The ticked rows (Optimize Selected), and the one whose details show. */
  private checked = new Set<string>();
  private seen = new Set<string>();
  private selected: string | undefined;

  constructor(private readonly table: HTMLElement, private readonly details: HTMLElement, private readonly toolbar: HTMLElement) {
    table.addEventListener("keydown", (e) => this.key(e));
  }

  render(data: HealthData, ctx: HealthContext): void {
    this.data = data;
    this.ctx = ctx;
    // A row with something to optimize starts ticked, once: after that, the ticks are the user's.
    for (const r of data.rows) {
      if (!this.seen.has(r.repoId) && r.optimize.length) this.checked.add(r.repoId);
      this.seen.add(r.repoId);
    }
    const ids = new Set(data.rows.map((r) => r.repoId));
    for (const id of [...this.checked]) if (!ids.has(id)) this.checked.delete(id);
    if (!this.selected || !ids.has(this.selected)) this.selected = (data.rows.find((r) => r.suggestions > 0) ?? data.rows[0])?.repoId;
    this.draw();
  }

  private busy(id: string): boolean {
    return !!this.data?.busy.includes(id);
  }

  private draw(): void {
    const data = this.data, ctx = this.ctx;
    if (!data || !ctx) return;
    const focusedRow = (document.activeElement as HTMLElement | null)?.closest?.("tr[data-repo]")?.getAttribute("data-repo");
    const optimizable = data.rows.filter((r) => this.checked.has(r.repoId) && r.optimize.length && !this.busy(r.repoId));
    const total = data.rows.reduce((s, r) => s + r.suggestions, 0);
    const optimize = h("button", { type: "button", class: "insights-button primary", disabled: optimizable.length === 0 }, [codiconElement("wand"),
      optimizable.length ? localize("Optimize Selected ({0})…", optimizable.length) : localize("Optimize Selected…")]);
    optimize.title = localize("Runs every recommended write in the ticked repositories, after asking.");
    optimize.addEventListener("click", () => ctx.act("optimize", optimizable.map((r) => r.repoId)));
    this.toolbar.replaceChildren(
      h("span", { class: "health-summary" }, [total
        ? localize("{0} suggestions in {1} repositories", formatNumber(total), formatNumber(data.rows.length))
        : localize("Nothing to improve in {0} repositories.", formatNumber(data.rows.length))]),
      optimize,
    );

    const all = data.rows.filter((r) => r.optimize.length);
    const allOn = all.length > 0 && all.every((r) => this.checked.has(r.repoId));
    const head = h("tr", {}, [
      h("th", { class: "col-check", scope: "col" }, [checkbox(allOn, localize("Tick every repository with something to optimize"), (on) => {
        for (const r of all) if (on) this.checked.add(r.repoId); else this.checked.delete(r.repoId);
        this.draw();
      })]),
      h("th", { class: "col-repo", scope: "col" }, [localize("Repository")]),
      ...CHECKS.map((id) => h("th", { scope: "col", title: checkInfo(id).explain }, [checkInfo(id).label])),
      h("th", { class: "col-count", scope: "col" }, [localize("Suggestions")]),
    ]);
    const body = data.rows.map((r) => this.row(r));
    this.table.replaceChildren(h("thead", {}, [head]), h("tbody", {}, body));
    if (focusedRow) this.table.querySelector<HTMLElement>(`tr[data-repo="${CSS.escape(focusedRow)}"]`)?.focus();
    this.drawDetails();
  }

  private row(r: HealthRow): HTMLTableRowElement {
    const repo = this.ctx!.repos.get(r.repoId);
    const on = this.selected === r.repoId;
    const tr = h("tr", { "data-repo": r.repoId, tabindex: on ? "0" : "-1", "aria-selected": on ? "true" : "false", class: this.busy(r.repoId) ? "busy" : undefined });
    tr.append(
      h("td", { class: "col-check" }, [r.optimize.length ? checkbox(this.checked.has(r.repoId), localize("Optimize {0}", r.name), (v) => {
        if (v) this.checked.add(r.repoId); else this.checked.delete(r.repoId);
        this.draw();
      }) : null]),
      h("th", { class: "col-repo", scope: "row" }, [h("span", { class: `strip-repo accent-${repo?.accent ?? 0}` }, [r.name])]),
      ...r.checks.map((c) => {
        const icon = ICONS[c.status];
        return h("td", { class: `cell status-${c.status}`, title: `${checkInfo(c.id).label}: ${c.value}${statusLabel(c.status) ? ` · ${statusLabel(c.status)}` : ""}\n${c.advice}` },
          [icon ? codiconElement(icon, "cell-icon") : null, h("span", { class: "cell-value" }, [c.value])]);
      }),
      h("td", { class: "col-count" }, [this.busy(r.repoId) ? localize("Writing…") : r.suggestions ? formatNumber(r.suggestions) : "—"]),
    );
    tr.addEventListener("click", () => this.select(r.repoId, false));
    return tr;
  }

  private select(id: string, focus: boolean): void {
    this.selected = id;
    for (const tr of this.table.querySelectorAll<HTMLElement>("tr[data-repo]")) {
      const on = tr.dataset.repo === id;
      tr.setAttribute("aria-selected", on ? "true" : "false");
      tr.tabIndex = on ? 0 : -1;
      if (on && focus) tr.focus();
    }
    this.drawDetails();
  }

  private key(e: KeyboardEvent): void {
    const rows = [...this.table.querySelectorAll<HTMLElement>("tbody tr[data-repo]")];
    const at = rows.findIndex((r) => r.dataset.repo === this.selected);
    if (!rows.length || !(e.target instanceof HTMLElement) || !e.target.matches("tr[data-repo]")) return;
    const next = e.key === "ArrowDown" ? at + 1 : e.key === "ArrowUp" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : undefined;
    if (next !== undefined) {
      e.preventDefault();
      this.select(rows[Math.max(0, Math.min(rows.length - 1, next))].dataset.repo!, true);
    } else if (e.key === " ") {
      e.preventDefault();
      rows[at]?.querySelector<HTMLElement>(".health-check-box")?.click();
    } else if (e.key === "Enter") {
      e.preventDefault();
      this.details.querySelector<HTMLElement>("button")?.focus();
    }
  }

  /** The selected repository's checks, each with what it means, what to do and its button. */
  private drawDetails(): void {
    const r = this.data?.rows.find((x) => x.repoId === this.selected);
    const ctx = this.ctx;
    if (!r || !ctx) { this.details.replaceChildren(); this.details.hidden = true; return; }
    const repo = ctx.repos.get(r.repoId);
    const busy = this.busy(r.repoId);
    this.details.hidden = false;
    this.details.setAttribute("aria-label", localize("Health of {0}", r.name));
    this.details.replaceChildren(
      h("h2", { class: "health-details-title" }, [h("span", { class: `strip-repo accent-${repo?.accent ?? 0}` }, [r.name])]),
      ...r.checks.map((c) => {
        const info = checkInfo(c.id);
        const icon = ICONS[c.status];
        const a = c.action;
        const button = a && h("button", { type: "button", class: `insights-button${a.recommended ? " primary" : ""}`, disabled: busy }, [a.label]);
        if (a && button) button.addEventListener("click", () => ctx.act(a.kind, [r.repoId], a.kind === "config" ? a.key : undefined, a.kind === "config" ? a.value : undefined));
        return h("div", { class: `health-item status-${c.status}` }, [
          h("span", { class: "health-item-icon", "aria-hidden": "true" }, [icon ? codiconElement(icon, "cell-icon") : null]),
          h("div", { class: "health-item-text" }, [
            h("div", { class: "health-item-head" }, [h("span", { class: "health-item-label" }, [info.label]), h("span", { class: "health-item-value" }, [c.value]),
              statusLabel(c.status) ? h("span", { class: "sr-only" }, [statusLabel(c.status)]) : null]),
            h("div", { class: "health-item-explain" }, [info.explain]),
            h("div", { class: "health-item-advice" }, [c.advice]),
          ]),
          button ? h("div", { class: "health-item-action" }, [button]) : null,
        ]);
      }),
    );
  }
}

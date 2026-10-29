// Linyra Insights' webview: the tabs, the scope, range and color controls, and each tab's drawing.
import type { BubbleCommit, HistoryData, InsightsHostMessage, InsightsRepo, InsightsWebviewMessage, TreeData, TreeTab } from "../../insights/protocol";
import { heatLegend, type TreeNodeMsg } from "../../insights/treemap";
import { HISTORY_LIMIT, RANGES, type ColorBy, type InsightsRange, type InsightsScope, type InsightsTab } from "../../insights/range";
import { language, localize } from "../../i18n";
import { byId, h } from "../dom";
import { codiconElement } from "../codicons";
import { commitTooltip, HistoryChart } from "./history";
import { bytes, keyOf, TreemapView, valueText } from "./treemap";

export interface InsightsApi {
  postMessage(message: InsightsWebviewMessage): void;
  getState(): unknown;
  setState(value: unknown): void;
}

type Init = Extract<InsightsHostMessage, { type: "init" }>;

const RANGE_LABELS: Record<InsightsRange, () => string> = {
  "1w": () => localize("1 week"),
  "4w": () => localize("4 weeks"),
  "3m": () => localize("3 months"),
  "1y": () => localize("1 year"),
  all: () => localize("All"),
};

export const number = (n: number): string => new Intl.NumberFormat(language()).format(n);

/**
 * A radio group of buttons (Range, Color by): one tab stop, ←/→ move and choose, as a segmented
 * control in VS Code's own settings.
 */
function segments<T extends string>(el: HTMLElement, items: { value: T; label: string }[], current: T, choose: (value: T) => void): void {
  // Drawn again after every choice (the host's answer): the focus stays in the group, on the choice.
  const focused = el.contains(document.activeElement);
  el.replaceChildren(...items.map((item) => {
    const on = item.value === current;
    const b = h("button", { type: "button", role: "radio", class: "insights-segment", "aria-checked": on ? "true" : "false", tabindex: on ? "0" : "-1", "data-value": item.value }, [item.label]);
    b.addEventListener("click", () => { if (item.value !== current) choose(item.value); });
    return b;
  }));
  if (focused) el.querySelector<HTMLElement>("[aria-checked=true]")?.focus();
  el.onkeydown = (e) => {
    const buttons = [...el.querySelectorAll<HTMLButtonElement>("button")];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const next = e.key === "ArrowRight" || e.key === "ArrowDown" ? at + 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : -2;
    if (next === -2) return;
    e.preventDefault();
    const b = buttons[(next + buttons.length) % buttons.length];
    b.focus();
    b.click();
  };
}

/** Whether a chosen file is still in the shown folder's part of the tree. */
function contains(node: TreeNodeMsg, file: TreeNodeMsg): boolean {
  return (node.children ?? []).some((c) => (c.kind === "file" ? keyOf(c) === keyOf(file) : contains(c, file)));
}

export function mountInsights(api: InsightsApi): void {
  let init: Init | undefined;
  let history: HistoryData | undefined;
  const trees: Partial<Record<TreeTab, TreeData>> = {};
  /** The file chosen in each treemap: its strip shows below the map. */
  const chosen: Partial<Record<TreeTab, TreeNodeMsg>> = {};
  const repos = new Map<string, InsightsRepo>();
  const tooltip = byId("insights-tooltip");
  const status = byId("insights-status");
  const chart = new HistoryChart(byId("history-chart"));
  const maps: Record<TreeTab, TreemapView> = { files: new TreemapView(byId("files-map")), commits: new TreemapView(byId("commits-map")) };
  const post = (m: InsightsWebviewMessage) => api.postMessage(m);

  const showTip = (content: HTMLElement[] | undefined, at?: DOMRect) => {
    if (!content || !at) { tooltip.hidden = true; return; }
    tooltip.replaceChildren(...content);
    tooltip.hidden = false;
    // Beside the mark, inside the window: below it unless that runs off the bottom.
    const tip = tooltip.getBoundingClientRect();
    const left = Math.max(4, Math.min(window.innerWidth - tip.width - 4, at.left + at.width / 2 - tip.width / 2));
    const below = at.bottom + 6;
    const top = below + tip.height > window.innerHeight - 4 ? Math.max(4, at.top - tip.height - 6) : below;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  };

  const tabs = [...document.querySelectorAll<HTMLButtonElement>("#insights-tabs [role=tab]")];
  const tabOf = (b: HTMLElement) => b.dataset.tab as InsightsTab;
  for (const b of tabs) b.addEventListener("click", () => select(tabOf(b), true));
  byId("insights-tabs").addEventListener("keydown", (e) => {
    const at = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const next = e.key === "ArrowRight" ? at + 1 : e.key === "ArrowLeft" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : -2;
    if (next === -2) return;
    e.preventDefault();
    const b = tabs[(next + tabs.length) % tabs.length];
    b.focus();
    select(tabOf(b), true);
  });

  function select(tab: InsightsTab, ask: boolean): void {
    if (!init) return;
    const changed = init.tab !== tab;
    init = { ...init, tab };
    for (const b of tabs) {
      const on = tabOf(b) === tab;
      b.setAttribute("aria-selected", on ? "true" : "false");
      b.tabIndex = on ? 0 : -1;
      byId(`panel-${tabOf(b)}`).hidden = !on;
    }
    showTip(undefined);
    controls();
    if (ask && changed) post({ type: "tab", tab });
  }

  const scopeSelect = byId<HTMLSelectElement>("scope");
  scopeSelect.addEventListener("change", () => post({ type: "scope", scope: JSON.parse(scopeSelect.value) as InsightsScope }));
  byId("refresh").addEventListener("click", () => post({ type: "refresh" }));

  /** The controls the shown tab uses: Range for history and commits, Color by for history. */
  function controls(): void {
    if (!init) return;
    const i = init;
    const ticked = i.ticked.map((id) => repos.get(id)).filter((r): r is InsightsRepo => !!r);
    const options: { scope: InsightsScope; label: string }[] = [
      { scope: { kind: "ticked" }, label: localize("Ticked repositories ({0})", ticked.length) },
      ...ticked.map((r) => ({ scope: { kind: "repo", repoId: r.id } as InsightsScope, label: r.name })),
    ];
    const s = i.scope;
    if (s.kind !== "ticked" && !i.ticked.includes(s.repoId)) options.push({ scope: { kind: "repo", repoId: s.repoId }, label: repos.get(s.repoId)?.name ?? "" });
    if (s.kind === "path") options.push({ scope: s, label: `${repos.get(s.repoId)?.name ?? ""} › ${s.path}` });
    const current = JSON.stringify(s);
    scopeSelect.replaceChildren(...options.map((o) => h("option", { value: JSON.stringify(o.scope), selected: JSON.stringify(o.scope) === current }, [o.label])));
    scopeSelect.value = current;
    scopeSelect.title = options.find((o) => JSON.stringify(o.scope) === current)?.label ?? "";
    const range = byId("range"), color = byId("color-by");
    range.hidden = !(i.tab === "history" || i.tab === "commits");
    color.hidden = i.tab !== "history";
    segments(range, RANGES.map((value) => ({ value, label: RANGE_LABELS[value]() })), i.range, (value) => post({ type: "range", range: value }));
    segments<ColorBy>(color, [{ value: "repo", label: localize("Repository") }, { value: "author", label: localize("Author") }], i.colorBy, (value) => {
      init = { ...i, colorBy: value };
      post({ type: "colorBy", colorBy: value });
      controls();
      drawHistory();
    });
  }

  function drawHistory(): void {
    if (!init || !history) return;
    const d = history;
    const panel = byId("panel-history");
    const empty = byId("history-empty");
    const inScope = new Set(d.commits.map((c) => c.repoId));
    const authors = new Set(d.commits.map((c) => (c.email || c.author).toLowerCase()));
    byId("history-summary").textContent = d.commits.length
      ? localize("{0} commits by {1} authors in {2} repositories · merges not shown", number(d.commits.length), number(authors.size), number(inScope.size))
      : "";
    const legend = byId("history-legend");
    if (init.colorBy === "repo" && inScope.size > 0) {
      const counts = new Map<string, number>();
      for (const c of d.commits) counts.set(c.repoId, (counts.get(c.repoId) ?? 0) + 1);
      legend.replaceChildren(...[...counts].sort((a, b) => b[1] - a[1]).map(([id, n]) => {
        const r = repos.get(id);
        return h("span", { class: `legend-item accent-${r?.accent ?? 0}`, title: localize(n === 1 ? "{0} commit" : "{0} commits", number(n)) }, [h("span", { class: "legend-swatch", "aria-hidden": "true" }), r?.name ?? ""]);
      }));
      legend.hidden = false;
    } else {
      legend.replaceChildren();
      legend.hidden = true;
    }
    const notes = byId("history-notes");
    const lines = [
      ...d.truncated.map((name) => localize("{0}: only its latest {1} commits in this range are drawn. Narrow the range to see the rest.", name, number(HISTORY_LIMIT))),
      ...d.failures.map((f) => localize("{0} could not be read: {1}", f.name, f.reason)),
    ];
    notes.replaceChildren(...lines.map((l) => h("div", {}, [l])));
    notes.hidden = lines.length === 0;
    empty.hidden = d.commits.length > 0;
    empty.textContent = d.commits.length ? "" : init.range === "all" ? localize("No commits here yet.") : localize("No commits in this range. Choose a longer range above.");
    byId("history-chart").hidden = d.commits.length === 0;
    panel.classList.remove("loading");
    chart.render(d, {
      repos, colorBy: init.colorBy,
      reveal: (c: BubbleCommit) => post({ type: "reveal", repoId: c.repoId, sha: c.sha }),
      tooltip: (c, at) => showTip(c && commitTooltip(c, repos.get(c.repoId)), at),
      announce: (text) => { status.textContent = text; },
    });
  }

  /** The chosen file's strip: its path and measure, Open File and Visual History. */
  function drawStrip(tab: TreeTab): void {
    const strip = byId(`${tab}-strip`);
    const n = chosen[tab];
    maps[tab].setSelected(n && keyOf(n));
    if (!n || n.kind !== "file" || !n.repoId || !n.path) { strip.hidden = true; strip.replaceChildren(); return; }
    const repo = repos.get(n.repoId);
    const open = h("button", { type: "button", class: "insights-button" }, [codiconElement("file"), localize("Open File")]);
    open.addEventListener("click", () => post({ type: "openFile", repoId: n.repoId!, path: n.path! }));
    const visual = h("button", { type: "button", class: "insights-button" }, [codiconElement("history"), localize("Visual History")]);
    visual.addEventListener("click", () => post({ type: "visualHistory", repoId: n.repoId!, path: n.path!, folder: false }));
    const close = h("button", { type: "button", class: "icon-button", title: localize("Close"), "aria-label": localize("Close") }, [codiconElement("close")]);
    close.addEventListener("click", () => { chosen[tab] = undefined; drawStrip(tab); byId(`${tab}-map`).focus(); });
    strip.replaceChildren(
      h("span", { class: `strip-repo accent-${repo?.accent ?? 0}` }, [repo?.name ?? ""]),
      h("span", { class: "strip-path", title: n.path }, [n.path]),
      h("span", { class: "strip-value" }, [valueText(tab, n.value)]),
      h("span", { class: "strip-actions" }, [open, visual, close]),
    );
    strip.hidden = false;
  }

  function drawTree(tab: TreeTab): void {
    const d = trees[tab];
    if (!init || !d) return;
    byId(`panel-${tab}`).classList.remove("loading");
    // Where the map is: the scope's root, then each folder opened; each crumb goes back there.
    const crumbs = byId(`${tab}-crumbs`);
    crumbs.replaceChildren(...d.crumbs.flatMap((name, i) => {
      const last = i === d.crumbs.length - 1;
      const label = name || localize("(root)");
      const crumb = last ? h("span", { class: "crumb current", "aria-current": "location" }, [label])
        : h("button", { type: "button", class: "crumb" }, [label]);
      if (!last) crumb.addEventListener("click", () => post({ type: "drill", tab, path: d.path.slice(0, i) }));
      return i === 0 ? [crumb] : [h("span", { class: "crumb-sep", "aria-hidden": "true" }, ["›"]), crumb];
    }), h("span", { class: "crumb-total" }, [d.node.files ? localize("{0} in {1} files", valueText(tab, d.node.value), number(d.node.files)) : ""]));
    const legend = byId(`${tab}-legend`);
    if (tab === "files" && d.legend.length) {
      legend.replaceChildren(...d.legend.map((l, i) => h("span", { class: `legend-item type-${i}`, title: bytes(l.value) }, [h("span", { class: "legend-swatch", "aria-hidden": "true" }), l.ext ? `.${l.ext}` : localize("no extension")])),
        h("span", { class: "legend-item type-other" }, [h("span", { class: "legend-swatch", "aria-hidden": "true" }), localize("Other")]));
    } else if (tab === "commits" && d.heat.length) {
      legend.replaceChildren(h("span", { class: "legend-label" }, [localize("Commits per file")]),
        ...heatLegend(d.heat).map((s) => {
          const label = s.to === undefined ? `${number(s.from)}+` : s.to === s.from ? number(s.from) : `${number(s.from)}–${number(s.to)}`;
          return h("span", { class: `legend-item heat-${s.level}` }, [h("span", { class: "legend-swatch square", "aria-hidden": "true" }), label]);
        }));
    } else legend.replaceChildren();
    const notes = byId(`${tab}-notes`);
    const lines = d.failures.map((f) => localize("{0} could not be read: {1}", f.name, f.reason));
    notes.replaceChildren(...lines.map((l) => h("div", {}, [l])));
    notes.hidden = lines.length === 0;
    const empty = byId(`${tab}-empty`), map = byId(`${tab}-map`);
    const none = d.node.value <= 0;
    empty.hidden = !none;
    empty.textContent = !none ? "" : tab === "files" ? localize("No tracked files here.") : init.range === "all" ? localize("No commits here yet.") : localize("No commits in this range. Choose a longer range above.");
    map.hidden = none;
    if (chosen[tab] && !contains(d.node, chosen[tab]!)) chosen[tab] = undefined;
    maps[tab].render(d, {
      repos,
      drill: (p) => post({ type: "drill", tab, path: p }),
      select: (n) => { chosen[tab] = n; drawStrip(tab); },
      tooltip: (content, at) => showTip(content, at),
      announce: (text) => { status.textContent = text; },
    });
    drawStrip(tab);
  }

  window.addEventListener("message", (event: MessageEvent) => {
    const m = event.data as InsightsHostMessage;
    if (!m || typeof m !== "object") return;
    switch (m.type) {
      case "init": {
        const redraw = !init || init.colorBy !== m.colorBy || init.repos !== m.repos;
        init = m;
        repos.clear();
        for (const r of m.repos) repos.set(r.id, r);
        select(m.tab, false);
        if (redraw) drawHistory();
        return;
      }
      case "history":
        if (m.status === "loading") {
          byId("panel-history").classList.add("loading");
          byId("history-summary").textContent = localize("Reading history…");
          return;
        }
        history = m.data;
        drawHistory();
        return;
      case "tree":
        if (m.status === "loading") {
          byId(`panel-${m.tab}`).classList.add("loading");
          return;
        }
        trees[m.tab] = m.data;
        drawTree(m.tab);
        return;
    }
  });
  window.addEventListener("blur", () => showTip(undefined));
  post({ type: "ready" });
}

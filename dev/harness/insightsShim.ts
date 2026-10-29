// Dev-only stand-in for the extension host behind Linyra Insights: answers the webview's messages
// with mock data (dev/harness/mock/insights.ts). Filtering mock data in JS is fine here: this is a
// harness, not the product.
import type { InsightsHostMessage, InsightsWebviewMessage, TreeTab } from "../../src/insights/protocol";
import { buildTree, findNode, heatSteps, keysOf, pruneTree, rankExtensions } from "../../src/insights/treemap";
import { sinceOf, type ColorBy, type InsightsRange, type InsightsScope, type InsightsTab } from "../../src/insights/range";
import { INSIGHTS_NOW, INSIGHTS_REPOS, mockBubbles, mockFiles, mockHealth, mockTouches } from "./mock/insights";
import { assess } from "../../src/insights/health";
import { formatBytes, formatNumber } from "../../src/insights/format";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") ?? "dark";
const state = params.get("state") ?? "default";
const BODY_CLASS: Record<string, string> = { dark: "vscode-dark", light: "vscode-light", "hc-dark": "vscode-high-contrast", "hc-light": "vscode-high-contrast vscode-high-contrast-light" };
(document.getElementById("theme") as HTMLLinkElement).href = `themes/${theme}.css`;
document.addEventListener("DOMContentLoaded", () => { document.body.className = BODY_CLASS[theme] ?? BODY_CLASS.dark; });

const latency = state === "slow" ? 1200 : 20;
const all = state === "empty" ? [] : mockBubbles(state === "many" ? 720 : 400, state === "many" ? 12 : 1.2, state === "many" ? 6 : 4);
let tab: InsightsTab = (params.get("tab") as InsightsTab | null) ?? "history";
let range: InsightsRange = (params.get("range") as InsightsRange | null) ?? "3m";
let colorBy: ColorBy = (params.get("color") as ColorBy | null) ?? "repo";
let scope: InsightsScope = params.get("path") ? { kind: "path", repoId: "/work/acme-web", path: params.get("path")!, folder: !params.get("path")!.includes(".") } : { kind: "ticked" };

const host = window as unknown as { insightsMessages: InsightsWebviewMessage[]; acquireVsCodeApi(): unknown; insightsSend(m: InsightsHostMessage): void };
host.insightsMessages = [];
const send = (m: InsightsHostMessage, delay = latency) => setTimeout(() => window.postMessage(m, "*"), delay);
host.insightsSend = (m) => send(m, 0);

function init(): void {
  send({ type: "init", repos: INSIGHTS_REPOS, ticked: INSIGHTS_REPOS.map((r) => r.id), scope, range, tab, colorBy, platform: "win32" }, 0);
}

function inScope(repoId: string): boolean {
  return scope.kind === "ticked" || scope.repoId === repoId;
}

const FILES = state === "empty" ? {} : mockFiles(state === "many" ? 40 : 1);
const WEEKS: Record<InsightsRange, number> = { "1w": 1, "4w": 4, "3m": 13, "1y": 52, all: 120 };
const drilled: Record<TreeTab, string[]> = { files: [], commits: [] };

/** The shown folder of a treemap, as the host sends it (src/insights/panel.ts), from the mock files. */
function tree(tab: TreeTab): void {
  const repos = INSIGHTS_REPOS.filter((r) => inScope(r.id));
  const values = tab === "files" ? Object.fromEntries(Object.entries(FILES).map(([id, list]) => [id, list.map((x) => ({ path: x.path, value: x.size }))])) : mockTouches(FILES, WEEKS[range]);
  const read = repos.map((r) => ({ id: r.id, name: r.name, entries: (values[r.id] ?? []).filter((e) => scope.kind !== "path" || e.path === scope.path || e.path.startsWith(`${scope.path}/`)) }));
  const root = buildTree(read);
  const base = scope.kind === "path" ? keysOf(root, scope.repoId, scope.folder ? scope.path : "") ?? [] : [];
  while (drilled[tab].length && !findNode(root, [...base, ...drilled[tab]])?.children) drilled[tab].pop();
  const node = findNode(root, [...base, ...drilled[tab]]) ?? root;
  const first = findNode(root, base) ?? root;
  const all = read.flatMap((r) => r.entries);
  send({ type: "tree", tab, status: "ready", data: {
    tab, path: drilled[tab],
    crumbs: [first.kind === "root" ? `Ticked repositories (${repos.length})` : first.kind === "repo" ? first.name : `acme-web › ${first.path}`, ...drilled[tab].map((_, i) => findNode(root, [...base, ...drilled[tab].slice(0, i + 1)])!.name)],
    node: pruneTree(node), legend: tab === "files" ? rankExtensions(all) : [], heat: tab === "commits" ? heatSteps(all.map((e) => e.value)) : [],
    failures: state === "error" ? [{ repoId: "/work/acme-libs", name: "acme-libs", reason: "fatal: not a valid object name HEAD" }] : [],
  } });
}

const HEALTH = mockHealth();
const busy: string[] = [];

/** Health's rows, assessed by the product's own thresholds (src/insights/health.ts). */
function health(): void {
  const repos = INSIGHTS_REPOS.filter((r) => inScope(r.id));
  const rows = state === "empty" ? [] : repos.map((r) => assess(r, HEALTH[r.id], { number: formatNumber, bytes: formatBytes, platform: params.get("platform") ?? "win32", insensitive: true }));
  send({ type: "health", status: "ready", data: { rows, busy, failures: state === "error" ? [{ repoId: "/work/acme-libs", name: "acme-libs", reason: "fatal: not a git repository" }] : [] } });
}

function show(): void {
  if (tab === "health") {
    send({ type: "health", status: "loading" }, 0);
    if (state !== "loading") health();
    return;
  }
  if (tab === "files" || tab === "commits") {
    send({ type: "tree", tab, status: "loading" }, 0);
    if (state !== "loading") tree(tab);
    return;
  }
  if (tab === "history") {
    send({ type: "history", status: "loading" }, 0);
    if (state === "loading") return;
    const since = sinceOf(range, INSIGHTS_NOW);
    const commits = all.filter((c) => inScope(c.repoId) && (since === undefined || c.time >= since));
    send({ type: "history", status: "ready", data: { since, now: INSIGHTS_NOW, commits,
      truncated: state === "many" && range === "all" ? ["acme-web"] : [],
      failures: state === "error" ? [{ repoId: "/work/acme-libs", name: "acme-libs", reason: "fatal: bad object HEAD" }] : [] } });
  }
}

host.acquireVsCodeApi = () => ({
  postMessage(m: InsightsWebviewMessage) {
    host.insightsMessages.push(m);
    switch (m.type) {
      case "ready": init(); show(); return;
      case "tab": tab = m.tab; show(); return;
      case "range": range = m.range; drilled.commits = []; init(); show(); return;
      case "scope": scope = m.scope; drilled.files = []; drilled.commits = []; init(); show(); return;
      case "drill": drilled[m.tab] = m.path; tree(m.tab); return;
      case "colorBy": colorBy = m.colorBy; return;
      case "refresh": show(); return;
      case "visualHistory": scope = { kind: "path", repoId: m.repoId, path: m.path, folder: m.folder }; tab = "history"; init(); show(); return;
      default: console.info("[harness]", m.type, m);
    }
  },
  getState: () => JSON.parse(sessionStorage.getItem("insights-state") ?? "null"),
  setState: (v: unknown) => sessionStorage.setItem("insights-state", JSON.stringify(v)),
});

// Dev-only stand-in for the extension host behind Linyra Insights: answers the webview's messages
// with mock data (dev/harness/mock/insights.ts). Filtering mock data in JS is fine here: this is a
// harness, not the product.
import type { InsightsHostMessage, InsightsWebviewMessage } from "../../src/insights/protocol";
import { sinceOf, type ColorBy, type InsightsRange, type InsightsScope, type InsightsTab } from "../../src/insights/range";
import { INSIGHTS_NOW, INSIGHTS_REPOS, mockBubbles } from "./mock/insights";

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

function show(): void {
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
      case "range": range = m.range; init(); show(); return;
      case "scope": scope = m.scope; init(); show(); return;
      case "colorBy": colorBy = m.colorBy; return;
      case "refresh": show(); return;
      case "visualHistory": scope = { kind: "path", repoId: m.repoId, path: m.path, folder: m.folder }; tab = "history"; init(); show(); return;
      default: console.info("[harness]", m.type, m);
    }
  },
  getState: () => JSON.parse(sessionStorage.getItem("insights-state") ?? "null"),
  setState: (v: unknown) => sessionStorage.setItem("insights-state", JSON.stringify(v)),
});

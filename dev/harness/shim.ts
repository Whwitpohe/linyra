// Dev-only stand-in for the extension host. It answers the webview's messages
// with mock data so the real webview bundle runs in a plain browser. Filtering
// mock data in JS here is fine: this is a harness, not the product.
import { DEFAULT_FILTER, type FilterState } from "../../src/filterModel";
import type { HostMessage, WebviewMessage } from "../../src/protocol";
import type { Commit } from "../../src/types";
import { mockCommits, mockRepos, NOW } from "./mock";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") ?? "dark";
const scenario = params.get("state") ?? "default";
const BODY_CLASS: Record<string, string> = {
  dark: "vscode-dark",
  light: "vscode-light",
  "hc-dark": "vscode-high-contrast",
  "hc-light": "vscode-high-contrast vscode-high-contrast-light",
};

(document.getElementById("theme") as HTMLLinkElement).href = `themes/${theme}.css`;
document.addEventListener("DOMContentLoaded", () => {
  document.body.className = BODY_CLASS[theme] ?? BODY_CLASS.dark;
});

const PAGE = 200;
const latency = scenario === "slow" ? 1500 : 25;
const repos = mockRepos(scenario);
const all = mockCommits(repos, scenario);
let filter: FilterState = DEFAULT_FILTER;
let history: { repoName: string; path: string } | null = params.get("history") ? { repoName: "acme-web", path: params.get("history")! } : null;
let matched: Commit[] = [];
let offset = 0;

function send(m: HostMessage, delay = latency): void {
  setTimeout(() => window.postMessage(m, "*"), delay);
}

function matching(f: FilterState): Commit[] {
  const text = f.text.trim().toLowerCase();
  const authors = [...(f.authors ?? []), f.author, f.mine ? "dana@example.com" : ""].map((a) => a.trim().toLowerCase()).filter(Boolean);
  const ids = f.repoIds === null ? null : new Set(f.repoIds);
  const span = { "24h": 86_400, "7d": 7 * 86_400, "30d": 30 * 86_400 } as Record<string, number>;
  const since = span[f.date] !== undefined ? NOW - span[f.date] : f.date === "custom" && f.from ? Date.parse(`${f.from}T00:00:00`) / 1000 : -Infinity;
  const until = f.date === "custom" && f.to ? Date.parse(`${f.to}T23:59:59`) / 1000 : Infinity;
  return all.filter((c) =>
    (!text || c.subject.toLowerCase().includes(text)) && (authors.length === 0 || authors.some((a) => `${c.author} <${c.email}>`.toLowerCase().includes(a))) && (!ids || ids.has(c.repoId)) && c.time >= since && c.time <= until);
}

function page(append: boolean): void {
  const rows = matched.slice(offset, offset + PAGE);
  offset += rows.length;
  const failures = scenario === "failure"
    ? [{ repoId: "/work/acme-libs", name: "acme-libs", reason: "shallow clone: history is incomplete" }]
    : [];
  send({ type: "page", rows, append, failures, done: offset >= matched.length, now: NOW });
  // ?select=multi: three commits selected (Combined Changes), the second one focused.
  if (!append && params.get("select") === "multi" && rows.length >= 4) {
    const refs = [rows[0], rows[1], rows[3]].map((c) => ({ repoId: c.repoId, sha: c.sha }));
    send({ type: "setSelection", items: refs, focus: refs[1] });
  }
}

function reload(): void {
  send({ type: "loading" }, 0);
  matched = matching(filter);
  offset = 0;
  page(false);
}

/** The Log's Uncommitted side: sample work in three repositories. */
const WORK = {
  type: "uncommitted" as const, known: true, totals: { files: 5, repos: 3, added: 24, deleted: 5 },
  rows: [
    { repoId: "/work/acme-web", preview: "3 files · notes.md, src/app.ts, src/new.ts", meter: { added: 1, modified: 2, deleted: 0 }, tags: ["1 staged", "1 new"], edited: "edited 2m ago", canStage: true, hasStaged: false, hasChanges: true },
    { repoId: "/work/acme-api", preview: "1 file · upload/upload.go", meter: { added: 0, modified: 1, deleted: 0 }, tags: [], edited: "edited 1h ago", canStage: true, hasStaged: false, hasChanges: true },
    { repoId: "/work/acme-libs", preview: "1 file · ui/Button.tsx", meter: { added: 0, modified: 0, deleted: 1 }, tags: ["all staged"], edited: "edited 3h ago", canStage: true, hasStaged: false, hasChanges: true },
  ],
};

let logMode: "commits" | "uncommitted" = "commits";

function handle(m: WebviewMessage): void {
  switch (m.type) {
    case "ready": send({ type: "init", repos, filter, hasMe: true, layout: { repoPaneWidth: 190, groupByRepo: params.get("repos") !== "off" }, history, logMode: (logMode = "commits"), profiles: [{ name: "backend", ids: ["/work/acme-api", "/work/acme-libs"], missing: ["acme-jobs"] }] }, 0); send({ type: "suggestions", branches: [{ name: "main", count: 3 }, { name: "origin/main", count: 3 }, { name: "origin/prod", count: 2 }], authors: [{ name: "dana", email: "dana@example.com", count: 41 }, { name: "rin", email: "rin@example.com", count: 37 }, { name: "noor", email: "noor@example.com", count: 12 }, { name: "sam", email: "sam@example.com", count: 9 }] }, 0); send({ type: "sync", byRepo: { "/work/acme-api": { ahead: 0, behind: 3 }, "/work/acme-libs": { ahead: 2, behind: 1 } } }, 0); send(WORK, 0); reload(); return;
    case "logMode": logMode = m.mode; console.info(`[harness] ${m.type}`, m); return;
    case "selectWork": console.info(`[harness] ${m.type}`, m); return;
    case "exitHistory": history = null; send({ type: "init", repos, filter, hasMe: true, layout: { repoPaneWidth: 190, groupByRepo: true }, history, logMode, profiles: [{ name: "backend", ids: ["/work/acme-api", "/work/acme-libs"], missing: ["acme-jobs"] }] }, 0); reload(); return;
    case "layout": console.info("[harness] layout", m); return;
    case "filter": filter = m.filter; reload(); return;
    case "refresh": reload(); return;
    case "loadMore": page(true); return;
    case "select": case "openFirst": console.info(`[harness] ${m.type}`, m); return;
    case "openSettings": console.info("[harness] openSettings"); return;
  }
}

(window as unknown as { acquireVsCodeApi: () => VsCodeApi }).acquireVsCodeApi = () => ({
  postMessage: (m: unknown) => handle(m as WebviewMessage),
  getState: () => undefined,
  setState: () => undefined,
});

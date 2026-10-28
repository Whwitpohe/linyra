// Dev-only stand-in for the extension host. It answers the webview's messages
// with mock data so the real webview bundle runs in a plain browser. Filtering
// mock data in JS here is fine: this is a harness, not the product.
import { DEFAULT_FILTER, hashQuery, type FilterState } from "../../src/filterModel";
import type { HostMessage, WebviewMessage } from "../../src/protocol";
import type { Commit } from "../../src/types";
import type { ChangesPage } from "../../src/changesProtocol";
import type { ToolbarState } from "../../src/toolbarModel";
import type { Layout } from "../../src/protocol";
import { DEFAULT_BRANCH_SIDEBAR, sidebarState, type BranchSidebarState } from "../../src/branchModel";
import { mockCommits, mockRepos, mockTopoWalk, NOW } from "./mock";
import { takeTopoReady, type RepoProgress } from "../../src/mergeStream";

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
let layout: Layout = { repoPaneWidth: 190, groupByRepo: params.get("repos") !== "off", ...JSON.parse(sessionStorage.getItem("linyra-layout") ?? "{}") };
const toolbarState: ToolbarState = { groupByRepo: layout.groupByRepo, compareShown: false, uncommittedShown: false, fetching: false, anyBehind: true };
let history: { repoName: string; path: string } | null = params.get("history") ? { repoName: "acme-web", path: params.get("history")! } : null;
let matched: Commit[] = [];
let offset = 0;

function send(m: HostMessage, delay = latency): void {
  setTimeout(() => window.postMessage(m, "*"), delay);
}

function matching(f: FilterState): Commit[] {
  const text = f.text.trim().toLowerCase();
  const hash = hashQuery(f.text);
  if (hash) return all.filter((c) => c.sha.startsWith(hash) && (f.repoIds === null || f.repoIds.includes(c.repoId)));
  const authors = [...(f.authors ?? []), f.author, f.mine ? "dana@example.com" : ""].map((a) => a.trim().toLowerCase()).filter(Boolean);
  const ids = f.repoIds === null ? null : new Set(f.repoIds);
  const span = { "24h": 86_400, "7d": 7 * 86_400, "30d": 30 * 86_400 } as Record<string, number>;
  const since = span[f.date] !== undefined ? NOW - span[f.date] : f.date === "custom" && f.from ? Date.parse(`${f.from}T00:00:00`) / 1000 : -Infinity;
  const until = f.date === "custom" && f.to ? Date.parse(`${f.to}T23:59:59`) / 1000 : Infinity;
  const matched = all.filter((c) =>
    (!text || c.subject.toLowerCase().includes(text)) && (authors.length === 0 || authors.some((a) => `${c.author} <${c.email}>`.toLowerCase().includes(a))) && (!ids || ids.has(c.repoId)) && c.time >= since && c.time <= until);
  if (f.sort !== "topo") return matched;
  const progress = new Map<string, RepoProgress>(repos.map((r) => [r.id, { fetched: 0, pending: mockTopoWalk(matched.filter((c) => c.repoId === r.id)), exhausted: true }]));
  return takeTopoReady(progress);
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
let selectedCommit = all[0];
let allFiles = false;
const harnessWindow = window as unknown as { harnessMessages: WebviewMessage[] };
harnessWindow.harnessMessages = [];
function postChanges(): void {
  if (!selectedCommit) return;
  const repo = repos.find((r) => r.id === selectedCommit.repoId)!;
  const message: ChangesPage = { type: "changes", key: `${selectedCommit.repoId}/${selectedCommit.sha}/${allFiles}`, allFiles,
    description: `${repo.name} · ${selectedCommit.sha.slice(0, 7)} · 2 files`,
    roots: [{ id: "source", kind: "folder", label: "src", description: "1", tooltip: "src", path: "src", contextValue: "folder", children: [
      { id: "client", kind: "file", label: "client.ts", path: "src/client.ts", description: "+12 −3", tooltip: "src/client.ts", contextValue: "file", status: "M", added: 12, deleted: 3 },
    ] }, { id: "readme", kind: "file", label: "README.md", path: "README.md", description: "+2 −0", tooltip: "README.md", contextValue: "file", status: "M", added: 2, deleted: 0 }],
    details: [{ repoId: repo.id, repoName: repo.name, sha: selectedCommit.sha, title: selectedCommit.subject,
      body: "Keep the preview configuration in sync.\n\nCo-Authored-By: Rin <rin@example.com>", author: selectedCommit.author, email: selectedCommit.email, time: selectedCommit.time,
      refs: selectedCommit.refs, containingBranches: ["HEAD", "main", "origin/main"] }],
  };
  send({ type: "changesView", message }, 0);
}
let branchState: BranchSidebarState = sidebarState(JSON.parse(sessionStorage.getItem("branch-sidebar") ?? "null") ?? DEFAULT_BRANCH_SIDEBAR);

function handle(m: WebviewMessage): void {
  harnessWindow.harnessMessages.push(m);
  if (m.type === "ready") send({ type: "toolbar", state: toolbarState }, 0);
  if (m.type === "ready") send({ type: "sidebarState", state: branchState }, 0);
  switch (m.type) {
    case "toolbarAction": {
      if (m.action === "toggleRepos") { layout.groupByRepo = !layout.groupByRepo; toolbarState.groupByRepo = layout.groupByRepo; }
      if (m.action === "toggleCompare") toolbarState.compareShown = !toolbarState.compareShown;
      if (m.action === "toggleUncommitted") toolbarState.uncommittedShown = !toolbarState.uncommittedShown;
      if (m.action === "fetchAll") { toolbarState.fetching = true; setTimeout(() => { toolbarState.fetching = false; send({ type: "toolbar", state: toolbarState }, 0); }, 600); }
      send({ type: "toolbar", state: toolbarState }, 0);
      send({ type: "init", repos, filter, hasMe: true, layout, history, logMode, profiles: [] }, 0);
      return;
    }
    case "changesView":
      if (m.message.type === "ready") postChanges();
      if (m.message.type === "copy") send({ type: "changesView", message: { type: "copied" } }, 0);
      if (m.message.type === "action" && (m.message.action === "allFiles" || m.message.action === "changedFiles")) { allFiles = m.message.action === "allFiles"; postChanges(); }
      return;
    case "branchSidebar": {
      if (m.action === "state" && m.state) { branchState = sidebarState(m.state); sessionStorage.setItem("branch-sidebar", JSON.stringify(branchState)); send({ type: "sidebarState", state: branchState }, 0); }
      if (m.action === "load" && m.repoId) send({ type: "branchTree", repoId: m.repoId, data: { current: "develop", remotes: ["origin"], branches: [
        { ref: "refs/heads/develop", name: "develop", sha: "a".repeat(40), kind: "local", current: true, upstream: "origin/develop", ahead: 1, behind: 2 },
        { ref: "refs/heads/master", name: "master", sha: "b".repeat(40), kind: "local", current: false, ahead: 0, behind: 0 },
        { ref: "refs/remotes/origin/develop", name: "origin/develop", sha: "c".repeat(40), kind: "remote", current: false, remote: "origin", remoteBranch: "develop", ahead: 0, behind: 0 },
        { ref: "refs/remotes/origin/master", name: "origin/master", sha: "d".repeat(40), kind: "remote", current: false, remote: "origin", remoteBranch: "master", ahead: 0, behind: 0 },
      ] } });
      if (m.action === "favorite" && m.repoId && m.ref) { const key = `${m.repoId}\0${m.ref}`, favorites = new Set(branchState.favorites); if (favorites.has(key)) favorites.delete(key); else favorites.add(key); branchState = { ...branchState, favorites: [...favorites] }; sessionStorage.setItem("branch-sidebar", JSON.stringify(branchState)); send({ type: "sidebarState", state: branchState }, 0); }
      if (m.action === "select" && m.repoId && m.ref) { filter = { ...filter, repoIds: [m.repoId], branch: m.ref.replace(/^refs\/(heads|remotes)\//, "") }; send({ type: "init", repos, filter, hasMe: true, layout, history: null, profiles: [] }, 0); reload(); }
      return;
    }
    case "ready": send({ type: "init", repos, filter, hasMe: true, layout, history, logMode: (logMode = "commits"), profiles: [{ name: "backend", ids: ["/work/acme-api", "/work/acme-libs"], missing: ["acme-jobs"] }] }, 0); send({ type: "suggestions", branches: [{ name: "main", count: 3 }, { name: "origin/main", count: 3 }, { name: "origin/prod", count: 2 }], authors: [{ name: "dana", email: "dana@example.com", count: 41 }, { name: "rin", email: "rin@example.com", count: 37 }, { name: "noor", email: "noor@example.com", count: 12 }, { name: "sam", email: "sam@example.com", count: 9 }] }, 0); send({ type: "sync", byRepo: { "/work/acme-api": { ahead: 0, behind: 3 }, "/work/acme-libs": { ahead: 2, behind: 1 } } }, 0); send(WORK, 0); reload(); return;
    case "logMode": logMode = m.mode; console.info(`[harness] ${m.type}`, m); return;
    case "selectWork": console.info(`[harness] ${m.type}`, m); return;
    case "exitHistory": history = null; send({ type: "init", repos, filter, hasMe: true, layout, history, logMode, profiles: [{ name: "backend", ids: ["/work/acme-api", "/work/acme-libs"], missing: ["acme-jobs"] }] }, 0); reload(); return;
    case "layout": layout = { ...layout, ...m }; sessionStorage.setItem("linyra-layout", JSON.stringify(layout)); return;
    case "filter": filter = m.filter; reload(); return;
    case "refresh": reload(); return;
    case "loadMore": page(true); return;
    case "select": selectedCommit = all.find((c) => c.repoId === m.repoId && c.sha === m.sha) ?? selectedCommit; postChanges(); return;
    case "openFirst": console.info(`[harness] ${m.type}`, m); return;
    case "openSettings": console.info("[harness] openSettings"); return;
  }
}

(window as unknown as { acquireVsCodeApi: () => VsCodeApi }).acquireVsCodeApi = () => ({
  postMessage: (m: unknown) => handle(m as WebviewMessage),
  getState: () => JSON.parse(sessionStorage.getItem("linyra-host-state") ?? "null"),
  setState: (value) => sessionStorage.setItem("linyra-host-state", JSON.stringify(value)),
});

// The browser harness's Repositories page (Linyra Compare tab): a mock host, neutral names.
import type { CRepoRow, CompareLayout, CompareMode, CompareTreeRow, ReposHost, ReposWebview } from "../../src/compareProtocol";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") ?? "dark";
const BODY_CLASS: Record<string, string> = { dark: "vscode-dark", light: "vscode-light", "hc-dark": "vscode-high-contrast", "hc-light": "vscode-high-contrast vscode-high-contrast-light" };
(document.getElementById("theme") as HTMLLinkElement).href = `themes/${theme}.css`;
document.addEventListener("DOMContentLoaded", () => (document.body.className = BODY_CLASS[theme] ?? BODY_CLASS.dark));

const send = (m: ReposHost) => setTimeout(() => window.postMessage(m, "*"), 30);
let pair = { left: "origin/release-1.4", right: "origin/main" };
let selected = "/work/acme-api";
const rows: CRepoRow[] = [
  { repoId: "/work/acme-api", name: "acme-api", accent: 1, status: "differs", left: 3, right: 1, same: 1, behind: true },
  { repoId: "/work/acme-web", name: "acme-web", accent: 2, status: "differs", left: 5, right: 0, same: 0, behind: false },
  { repoId: "/work/acme-libs", name: "acme-libs", accent: 3, status: "differs", left: 0, right: 2, same: 3, behind: false },
  { repoId: "/work/acme-legacy", name: "acme-legacy", accent: 4, status: "nobase", left: 0, right: 0, same: 0, behind: false },
];
const repos = () => send({ type: "repos", reading: false, summary: "4 repositories differ · 51 identical · 3 missing a branch · in 58 repositories", rows, missing: ["acme-docs", "acme-infra", "acme-ops"], selected, pairKey: `${pair.left}\0${pair.right}` });
let mode: CompareMode = "files", hideSame = true, showLeft = true, showRight = true;
let layout: CompareLayout = { repositoriesWidth: 240, leftWidth: 440, leftHeight: 180, sidesHeight: 280, orientation: "auto", ...JSON.parse(sessionStorage.getItem("compare-layout") ?? "{}") };
const expanded = new Set<string>();
const harnessWindow = window as unknown as { compareMessages: ReposWebview[] };
harnessWindow.compareMessages = [];
const state = () => send({ type: "state", pair, mode, hideSame, showLeft, showRight, layout, recent: [pair, { left: "origin/release-1.3", right: "origin/prod" }], favorites: ["origin/main"] });
function sides(): void {
  for (const side of ["left", "right"] as const) {
    const file = (name: string, same = false): CompareTreeRow => ({ id: `${selected}/${side}/${name}`, kind: "file", label: name.split("/").pop()!, description: same ? "+1 −0 · already on both" : "+12 −3 · both", tooltip: name, contextValue: "compareFile", status: "M", same });
    const files: CompareTreeRow[] = [{ id: `${side}-src`, kind: "folder", label: "src", description: "2", tooltip: "src", contextValue: "", loaded: true,
      children: [file("src/limits.ts"), file("src/upload.ts")] }, ...(hideSame ? [] : [file("retry.go", true)])];
    const id = `${selected}/${side}/commit`;
    const rows: CompareTreeRow[] = mode === "files" ? files : [{ id, kind: "commit", label: "fix: retry on 503", description: "dana · a42a50e", tooltip: "fix: retry on 503", contextValue: "compareCommit",
      loaded: expanded.has(id), children: expanded.has(id) ? [file("src/upload.ts")] : [] }, { id: `${side}-more`, kind: "more", label: "Show 500 more", description: "", tooltip: "", contextValue: "" }];
    send({ type: "side", side, key: `${selected}/${pair.left}/${pair.right}/${mode}`, description: `${pair[side]} only · ${selected.split("/").pop()} · ${mode === "files" ? "2 files" : "1 commit"}`, rows });
  }
}

function handle(m: ReposWebview): void {
  harnessWindow.compareMessages.push(m);
  console.info("[repos harness]", m);
  switch (m.type) {
    case "ready": state(); repos(); sides(); return;
    case "sideReady": sides(); return;
    case "pick": pair = m.pair; state(); repos(); sides(); return;
    case "swap": pair = { left: pair.right, right: pair.left }; state(); repos(); sides(); return;
    case "select": selected = m.repoId; repos(); sides(); return;
    case "mode": mode = m.mode; state(); sides(); return;
    case "hideSame": hideSame = m.hide; state(); sides(); return;
    case "sideExpand": expanded.add(m.id); sides(); return;
    case "sideExpandAll": expanded.add(`${selected}/${m.side}/commit`); sides(); return;
    case "sideVisibility": if (m.side === "left") showLeft = m.show; else showRight = m.show; state(); return;
    case "layout": layout = m.layout; sessionStorage.setItem("compare-layout", JSON.stringify(layout)); return;
    case "refresh": repos(); sides(); return;
    case "wantBranches":
      send({ type: "branches", remotes: ["origin"], names: [{ name: "origin/main", count: 58 }, { name: "main", count: 58 }, { name: "origin/release-1.4", count: 50 }, { name: "origin/release-1.3", count: 50 }, { name: "origin/prod", count: 44 }, { name: "feat/billing", count: 3 }] });
      return;
    case "wantDups": send({ type: "dups", repoId: m.repoId, items: [{ subject: "fix: retry on 503", left: "3f9a2c1".padEnd(40, "0"), right: "b71e0d4".padEnd(40, "0") }] }); return;
    default: return;
  }
}
(window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({ postMessage: (m: ReposWebview) => setTimeout(() => handle(m), 0) });

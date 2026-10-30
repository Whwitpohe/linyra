import type { ChangeRow, ChangesMessage, ChangesPage, CommitDetails } from "../../src/changesProtocol";
import type { CommitReference } from "../../src/commitReferences";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") ?? "dark";
document.getElementById("theme")!.setAttribute("href", `themes/${theme}.css`);
document.body.classList.add(...(theme === "hc-dark" ? "vscode-high-contrast" : theme === "hc-light" ? "vscode-high-contrast vscode-high-contrast-light" : `vscode-${theme}`).split(" "));
const state = params.get("state") ?? "default";
const files = state === "many" ? 301 : 14;
const names = ["AccountDialog", "ActivityDetail", "CategoryView", "DownloadView", "GameDetailView", "HomeView", "LoginPopup", "PaymentIcon", "ProfileView", "PromotionView", "SettingsView", "UploadView"];
const folder = (id: string, label: string, children: ChangeRow[]): ChangeRow => ({ id, kind: "folder", label, children, description: String(children.length), tooltip: label, contextValue: "folder" });
const renamed: ChangeRow[] = Array.from({ length: files - 2 }, (_, i) => ({ id: `asset-${i}`, kind: "file", label: `${names[i % names.length]}-${i.toString(36)}N7.js`,
  oldPath: `dist/assets/${names[i % names.length]}-previous-${i}.js`, status: "R", added: i % 5 + 1, deleted: i % 3 + 1, description: "", tooltip: `dist/assets/${names[i % names.length]}.js`, contextValue: "file" }));
const develop: CommitReference = { kind: "local", name: "develop", current: true };
/**
 * ?refs=: the commit's references and the branches containing it. Default: HEAD on develop with a
 * second branch here, and a release branch further on; tip: develop's tip, in no other branch;
 * old: no reference here, in three branches; detached: only a detached HEAD holds it; loading:
 * the containing branches not read yet.
 */
function references(kind: string | null): Pick<CommitDetails, "refs" | "containing"> {
  const here: CommitReference[] = [{ kind: "head", name: "HEAD" }, develop, { kind: "local", name: "fix/preview-callback" }, { kind: "remote", name: "origin/develop" }];
  const release: CommitReference[] = [{ kind: "local", name: "release-1.4" }, { kind: "remote", name: "origin/release-1.4" }];
  if (kind === "tip") return { refs: [{ kind: "head", name: "HEAD" }, develop, { kind: "remote", name: "origin/develop" }], containing: [develop, { kind: "remote", name: "origin/develop" }] };
  if (kind === "old") return { refs: [], containing: [develop, { kind: "remote", name: "origin/develop" }, { kind: "local", name: "release-1.4" }] };
  if (kind === "detached") return { refs: [{ kind: "head", name: "HEAD" }, { kind: "tag", name: "v1.4.0" }], containing: [{ kind: "head", name: "HEAD" }] };
  if (kind === "loading") return { refs: here };
  return { refs: here, containing: [develop, here[2], here[3], ...release] };
}
const page: ChangesPage = {
  type: "changes", key: "preview", description: `acme-web · a42a50e · ${files} files`,
  roots: [folder("dist", "dist", [folder("assets", "assets", renamed)]),
    { id: "readme", kind: "file", label: "README.md", status: "M", added: 12, deleted: 3, description: "", tooltip: "README.md", contextValue: "file" },
    { id: "logo", kind: "file", label: "logo.png", status: "A", added: null, deleted: null, description: "binary", tooltip: "logo.png", contextValue: "file" }],
  details: [{ repoId: "acme-web", repoName: "acme-web", sha: "a42a50e".padEnd(40, "0"), title: params.has("long") ? "release(web): 调整构建配置，修复测试环境的登录回调，并重新生成前端静态资源" : "release(web): update preview build and login callback",
    body: `Co-Authored-By: Rin <rin@example.com>${params.has("long") ? "\n\n" + "Long commit notes: preserve paragraphs and wrap long paths without pushing the file list out of view.\n".repeat(15) : ""}`,
    author: "dana", email: "dana@example.com", time: Date.UTC(2026, 9, 27, 3, 45) / 1000, accent: 3,
    ...references(params.get("refs")) }],
};
if (state === "empty") { page.roots = []; page.details = []; page.message = "Select a commit in the Log to see its changed files."; page.description = ""; }
if (state === "loading") { page.roots = []; page.message = "Loading changed files…"; }
if (state === "error") { page.roots = []; page.message = "Could not read this commit: repository unavailable"; }
if (state === "combined") { page.details.push({ ...page.details[0], sha: "b31c920".padEnd(40, "0"), repoName: "acme-api", repoId: "acme-api", title: "fix(api): handle empty upload response", body: "" }); }
const send = (data: unknown) => window.dispatchEvent(new MessageEvent("message", { data }));
const host = window as unknown as { acquireVsCodeApi(): unknown; changesMessages: ChangesMessage[]; changePreview(next: ChangesPage): void };
host.changesMessages = [];
host.changePreview = send;
host.acquireVsCodeApi = () => ({
  postMessage(message: ChangesMessage) { host.changesMessages.push(message); if (message.type === "ready") setTimeout(() => send(page), 0); if (message.type === "copy") send({ type: "copied" }); },
  getState() { return JSON.parse(sessionStorage.getItem("changes-layout") ?? "null"); },
  setState(value: unknown) { sessionStorage.setItem("changes-layout", JSON.stringify(value)); },
});

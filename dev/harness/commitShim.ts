import { checkedLabel, describeCommit, setChecked, rowsById } from "../../src/commitModel";
import type { CommitHostMessage, CommitWebviewMessage } from "../../src/commitProtocol";
import type { FileChange } from "../../src/types";
import { totals, viewLabel, type RepoWork } from "../../src/uncommittedModel";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") ?? "dark";
document.getElementById("theme")!.setAttribute("href", `themes/${theme}.css`);
document.body.classList.add(theme === "hc-dark" ? "vscode-high-contrast" : theme === "hc-light" ? "vscode-high-contrast-light" : `vscode-${theme}`);
const state = params.get("state") ?? "default";

const f = (path: string, status: FileChange["status"], extra: Partial<FileChange> = {}): FileChange => ({ path, status, added: 1, deleted: 0, ...extra });
const repo = (name: string, staged: FileChange[], changes: FileChange[]): RepoWork =>
  ({ repoId: `/work/${name}`, root: `/work/${name}`, name, head: "a".repeat(40), editedAt: null, canStage: true, staged, changes });
let works: RepoWork[] = state === "empty" ? [] : [
  repo("acme-web", [f("notes.md", "M"), f("assets/logo.png", "A")],
    [f("src/app.ts", "M"), f("src/components/Button.tsx", "M"), f("notes.md", "M"), f("docs/old.md", "D"), f("src/new.ts", "A", { untracked: true }), f("scratch.txt", "A", { untracked: true })]),
  repo("acme-api", [f("upload/handler.go", "R", { oldPath: "upload/handle.go" })], [f("upload/upload.go", "M")]),
  repo("acme-libs", [], [f("ui/Button.tsx", "D")]),
];
if (state === "many") works = [repo("acme-web", [], Array.from({ length: 240 }, (_, i) => f(`src/feature-${i % 12}/module-${i}.ts`, "M")))];
const accents = new Map([["/work/acme-web", 1], ["/work/acme-api", 3], ["/work/acme-libs", 5]]);
let choices = new Map<string, boolean>();
let busy = false;

const send = (data: CommitHostMessage) => window.dispatchEvent(new MessageEvent("message", { data }));
function post(): void {
  const d = describeCommit(works, choices, accents, (id) => id === "/work/acme-api");
  send({ type: "state", roots: d.roots, ...(d.message ? { notice: d.message } : {}), summary: viewLabel(totals(works)), checkedLabel: checkedLabel(d.checked), checkedFiles: d.checked.files, busy });
}

const host = window as unknown as { acquireVsCodeApi(): unknown; commitMessages: CommitWebviewMessage[] };
host.commitMessages = [];
host.acquireVsCodeApi = () => ({
  postMessage(m: CommitWebviewMessage) {
    host.commitMessages.push(m);
    if (m.type === "ready") { setTimeout(() => { send({ type: "draft", text: params.get("message") ?? "", amend: false }); post(); }, 0); }
    if (m.type === "check") {
      const rows = rowsById(describeCommit(works, choices).roots);
      choices = setChecked(works, choices, m.ids.flatMap((id) => rows.get(id) ?? []), m.on);
      post();
    }
    if (m.type === "amend" && m.on && !m.text.trim()) send({ type: "amendMessage", text: "fix(web): keep the login callback on preview builds" });
    if (m.type === "commit") {
      busy = true;
      post();
      setTimeout(() => { busy = false; send({ type: "committed" }); post(); }, 400);
    }
  },
  getState() { return JSON.parse(sessionStorage.getItem("commit-layout") ?? "null"); },
  setState(value: unknown) { sessionStorage.setItem("commit-layout", JSON.stringify(value)); },
});

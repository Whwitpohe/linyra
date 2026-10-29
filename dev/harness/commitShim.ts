import type { CommitHostMessage, CommitWebviewMessage } from "../../src/commitProtocol";
import { mockAiCommit } from "./mock/aiCommit";

// The Commit side bar's message box (the tree above it is VS Code's own). ?state=none: nothing checked.
const params = new URLSearchParams(location.search);
const theme = params.get("theme") ?? "dark";
document.getElementById("theme")!.setAttribute("href", `themes/${theme}.css`);
document.body.classList.add(theme === "hc-dark" ? "vscode-high-contrast" : theme === "hc-light" ? "vscode-high-contrast-light" : `vscode-${theme}`);
const none = params.get("state") === "none";
let busy = false;

const send = (data: CommitHostMessage) => window.dispatchEvent(new MessageEvent("message", { data }));
const ai = mockAiCommit(send, params);
const post = () => send({ type: "state", checkedLabel: none ? "No files checked" : "8 files checked in 3 repositories", checkedFiles: none ? 0 : 8, busy, ai: ai.ai });

const host = window as unknown as { acquireVsCodeApi(): unknown; commitMessages: CommitWebviewMessage[] };
host.commitMessages = [];
host.acquireVsCodeApi = () => ({
  postMessage(m: CommitWebviewMessage) {
    host.commitMessages.push(m);
    ai.handle(m);
    if (m.type === "ready") setTimeout(() => {
      send({ type: "draft", text: params.get("message") ?? "", amend: false, signOff: false, author: "" });
      post();
      // ?template=on: a commit.template with a text and # guidance, as git config commit.template reads it.
      if (params.get("template") === "on") send({ type: "template", text: "feat: \n\nRefs: ACME-", hint: "Why is this change needed?\nWhat does it do?" });
    }, 0);
    if (m.type === "history") send({ type: "message", text: "fix(api): retry the upload once\n\nThe second try reuses the token." });
    if (m.type === "author") send({ type: "author", author: m.clear ? "" : "rin <rin@example.com>" });
    if (m.type === "amend" && m.on && !m.text.trim()) send({ type: "amendMessage", text: "fix(web): keep the login callback on preview builds" });
    if (m.type === "commit") {
      busy = true;
      post();
      setTimeout(() => { busy = false; send({ type: "committed" }); post(); }, 400);
    }
  },
});

import { localize } from "../../i18n";
import type { CommitHostMessage, CommitState, CommitWebviewMessage } from "../../commitProtocol";
import { codiconElement } from "../codicons";
import { byId } from "../dom";

export interface CommitApi {
  postMessage(message: CommitWebviewMessage): void;
}

/**
 * The Commit side bar's message box: Amend, the message, and Commit / Commit and Push…. The
 * native tree above it owns the checks; this only says what the buttons will take.
 */
export function mountCommit(api: CommitApi, events: EventTarget = window): void {
  const post = (m: CommitWebviewMessage) => api.postMessage(m);
  const message = byId<HTMLTextAreaElement>("commit-message");
  const amend = byId("commit-amend");
  const validation = byId("commit-validation");
  const commitButton = byId<HTMLButtonElement>("commit-button");
  const pushButton = byId<HTMLButtonElement>("commit-push-button");
  let state: CommitState | undefined;

  function render(): void {
    const busy = state?.busy === true;
    commitButton.disabled = pushButton.disabled = busy || (state?.checkedFiles ?? 0) === 0;
    commitButton.textContent = busy ? localize("Committing…") : localize("Commit");
    byId("commit-checked").textContent = state?.checkedLabel ?? "";
  }

  // The message is kept as a draft while typed, Amend beside it.
  let draftTimer: ReturnType<typeof setTimeout> | undefined;
  const isAmend = () => amend.getAttribute("aria-checked") === "true";
  const saveDraft = () => { clearTimeout(draftTimer); draftTimer = setTimeout(() => post({ type: "draft", text: message.value, amend: isAmend() }), 300); };
  function setAmend(on: boolean): void {
    amend.setAttribute("aria-checked", String(on));
    const box = amend.querySelector(".check")!;
    box.className = `check check-${on ? "on" : "off"}`;
    box.replaceChildren(...(on ? [codiconElement("check")] : []));
  }
  function flipAmend(): void {
    setAmend(!isAmend());
    post({ type: "amend", on: isAmend(), text: message.value });
    saveDraft();
  }
  amend.addEventListener("click", flipAmend);
  amend.addEventListener("keydown", (e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); flipAmend(); } });
  message.addEventListener("input", () => { validation.hidden = true; saveDraft(); });

  function commit(push: boolean): void {
    if (commitButton.disabled) return;
    if (message.value.trim() === "") {
      validation.textContent = localize("Write a commit message first.");
      validation.hidden = false;
      message.focus();
      return;
    }
    post({ type: "commit", message: message.value, amend: isAmend(), push });
  }
  commitButton.addEventListener("click", () => commit(false));
  pushButton.addEventListener("click", () => commit(true));
  // The JetBrains keys: Ctrl+Enter commits from the message, Ctrl+Alt+K commits and pushes.
  message.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === "Enter") { e.preventDefault(); commit(false); }
  });
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === "k") { e.preventDefault(); commit(true); }
  });

  events.addEventListener("message", (event) => {
    const m = (event as MessageEvent<CommitHostMessage>).data;
    if (!m || typeof m !== "object") return;
    if (m.type === "draft") { message.value = m.text; setAmend(m.amend); return; }
    if (m.type === "amendMessage") { if (message.value.trim() === "") { message.value = m.text; saveDraft(); } return; }
    if (m.type === "committed") { message.value = ""; setAmend(false); validation.hidden = true; return; }
    if (m.type === "state") { state = m; render(); }
  });
  render();
  post({ type: "ready" });
}

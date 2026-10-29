import { localize } from "../../i18n";
import type { CommitHostMessage, CommitState, CommitWebviewMessage } from "../../commitProtocol";
import { codiconElement } from "../codicons";
import { byId, h } from "../dom";
import { messageHints } from "../../commitMessageModel";

export interface CommitApi {
  postMessage(message: CommitWebviewMessage): void;
}

/**
 * The Commit side bar's message box: Amend, Sign-off, Author…, Commit Message History, the
 * message, and Commit / Commit and Push…. The native tree above it owns the checks; this only
 * says what the buttons will take.
 */
export function mountCommit(api: CommitApi, events: EventTarget = window): void {
  const post = (m: CommitWebviewMessage) => api.postMessage(m);
  const message = byId<HTMLTextAreaElement>("commit-message");
  const amend = byId("commit-amend");
  const signOff = byId("commit-signoff");
  const authorLine = byId("commit-author-line");
  const authorEdit = byId<HTMLButtonElement>("commit-author-edit");
  const validation = byId("commit-validation");
  const commitButton = byId<HTMLButtonElement>("commit-button");
  const pushButton = byId<HTMLButtonElement>("commit-push-button");
  const generate = byId<HTMLButtonElement>("commit-generate");
  const aiStatus = byId("commit-ai-status");
  const aiText = byId("commit-ai-text");
  const aiUndo = byId<HTMLButtonElement>("commit-ai-undo");
  const hints = byId("commit-hints");
  const placeholder = message.placeholder;
  let state: CommitState | undefined;
  /** The checks of the message as typed: a long subject or body line, no blank line after the subject. */
  let hintsFor: string | undefined;
  function renderHints(): void {
    if (hintsFor === message.value) return;
    hintsFor = message.value;
    const list = generating ? [] : messageHints(message.value);
    hints.replaceChildren(...list.map((text) => h("li", {}, [codiconElement("warning"), h("span", {}, [text])])));
    hints.hidden = list.length === 0;
  }
  /** ✨ is writing into the box; `before` is what the box held, for Undo. */
  let generating = false;
  let before = "";

  function render(): void {
    const busy = state?.busy === true;
    commitButton.disabled = pushButton.disabled = busy || generating || (state?.checkedFiles ?? 0) === 0;
    commitButton.textContent = busy ? localize("Committing…") : localize("Commit");
    byId("commit-checked").textContent = state?.checkedLabel ?? "";
    generate.hidden = state?.ai !== true && !generating;
    generate.disabled = !generating && (busy || (state?.checkedFiles ?? 0) === 0);
    generate.classList.toggle("generating", generating);
    const label = generating ? localize("Stop Generating") : localize("Generate Commit Message with AI");
    generate.title = generating ? `${label} (Esc)` : label;
    generate.setAttribute("aria-label", label);
    if (generate.dataset.icon !== String(generating)) {
      generate.dataset.icon = String(generating);
      generate.replaceChildren(codiconElement(generating ? "loading" : "sparkle"));
    }
    message.readOnly = generating;
    message.setAttribute("aria-busy", String(generating));
  }

  // ✨'s line under the box: what it is doing, and Undo once it wrote.
  function showAiStatus(text: string, undo: boolean): void {
    aiText.textContent = text;
    aiUndo.hidden = !undo;
    aiStatus.hidden = false;
  }
  const hideAiStatus = () => { aiStatus.hidden = true; };
  /** Ours, not the user's: the input it fires does not hide the status line. */
  let replacing = false;
  /** The box's whole text as one edit, so its own Undo (Ctrl+Z) takes it back too. */
  function replaceText(text: string): void {
    replacing = true;
    try {
      message.focus();
      message.select();
      const done = text === "" ? document.execCommand("delete") : document.execCommand("insertText", false, text);
      if (!done || message.value !== text) message.value = text;
    } finally {
      replacing = false;
    }
  }
  function startGenerating(): void {
    if (generating) return;
    generating = true;
    before = message.value;
    validation.hidden = true;
    showAiStatus(localize("Writing a commit message…"), false);
    render();
  }

  // The message is kept as a draft while typed, the options beside it.
  let draftTimer: ReturnType<typeof setTimeout> | undefined;
  const isOn = (option: HTMLElement) => option.getAttribute("aria-checked") === "true";
  const isAmend = () => isOn(amend);
  const saveDraft = () => { clearTimeout(draftTimer); draftTimer = setTimeout(() => post({ type: "draft", text: message.value, amend: isAmend(), signOff: isOn(signOff) }), 300); };
  function setCheck(option: HTMLElement, on: boolean): void {
    option.setAttribute("aria-checked", String(on));
    const box = option.querySelector(".check")!;
    box.className = `check check-${on ? "on" : "off"}`;
    box.replaceChildren(...(on ? [codiconElement("check")] : []));
  }
  const setAmend = (on: boolean) => setCheck(amend, on);
  function checkbox(option: HTMLElement, flipped: () => void): void {
    const flip = () => { setCheck(option, !isOn(option)); flipped(); saveDraft(); };
    option.addEventListener("click", flip);
    option.addEventListener("keydown", (e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); flip(); } });
  }
  checkbox(amend, () => post({ type: "amend", on: isAmend(), text: message.value }));
  checkbox(signOff, () => undefined);
  message.addEventListener("input", () => {
    validation.hidden = true;
    renderHints();
    if (!replacing) hideAiStatus();
    saveDraft();
  });

  // ✨: a message for the checked files, streamed in; pressed again (or Esc) it stops.
  generate.addEventListener("click", () => {
    if (generating) { post({ type: "generateStop" }); return; }
    if (generate.disabled) return;
    const hint = message.value;
    startGenerating();
    post({ type: "generate", text: hint });
  });
  aiUndo.addEventListener("click", () => {
    replaceText(before);
    hideAiStatus();
    saveDraft();
  });
  message.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && generating) { e.preventDefault(); e.stopPropagation(); post({ type: "generateStop" }); }
  });

  // Author…: the next commit's author, typed in VS Code's input box; shown under the options while set.
  function setAuthor(author: string): void {
    authorLine.hidden = author === "";
    authorEdit.textContent = localize("Author: {0}", author);
  }
  byId("commit-author").addEventListener("click", () => post({ type: "author" }));
  authorEdit.addEventListener("click", () => post({ type: "author" }));
  byId("commit-author-clear").addEventListener("click", () => post({ type: "author", clear: true }));
  byId("commit-history").addEventListener("click", () => post({ type: "history" }));

  function commit(push: boolean): void {
    if (commitButton.disabled) return;
    if (message.value.trim() === "") {
      validation.textContent = localize("Write a commit message first.");
      validation.hidden = false;
      message.focus();
      return;
    }
    post({ type: "commit", message: message.value, amend: isAmend(), push, signOff: isOn(signOff) });
  }
  commitButton.addEventListener("click", () => commit(false));
  pushButton.addEventListener("click", () => commit(true));
  // The JetBrains keys: Ctrl+Enter commits from the message, Ctrl+Alt+K commits and pushes.
  message.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === "Enter") { e.preventDefault(); commit(false); }
  });
  // Ctrl+M: Commit Message History. Stopped here, so VS Code does not also take it (Toggle Tab Key Moves Focus).
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "m") { e.preventDefault(); e.stopPropagation(); post({ type: "history" }); }
  });
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === "k") { e.preventDefault(); commit(true); }
  });

  events.addEventListener("message", (event) => {
    const m = (event as MessageEvent<CommitHostMessage>).data;
    if (!m || typeof m !== "object") return;
    if (m.type === "draft") { message.value = m.text; setAmend(m.amend); setCheck(signOff, m.signOff === true); setAuthor(typeof m.author === "string" ? m.author : ""); renderHints(); return; }
    if (m.type === "message") { message.value = m.text; validation.hidden = true; hideAiStatus(); saveDraft(); renderHints(); message.focus(); return; }
    if (m.type === "template") {
      message.placeholder = m.hint || placeholder;
      if (message.value.trim() === "" && m.text) { message.value = m.text; saveDraft(); }
      renderHints();
      return;
    }
    if (m.type === "author") { setAuthor(m.author); return; }
    if (m.type === "amendMessage") { if (message.value.trim() === "") { message.value = m.text; saveDraft(); } return; }
    if (m.type === "committed") { message.value = ""; setAmend(false); setAuthor(""); validation.hidden = true; hideAiStatus(); renderHints(); return; }
    if (m.type === "generating") { startGenerating(); return; }
    if (m.type === "generated") {
      if (!m.done) {
        startGenerating();
        message.value = m.text;
        message.scrollTop = message.scrollHeight;
        return;
      }
      if (!generating) return;
      generating = false;
      message.value = before;
      render();
      if (m.text) {
        replaceText(m.text);
        saveDraft();
        renderHints();
        showAiStatus(localize("Written by AI: read it before you commit."), true);
      } else {
        hideAiStatus();
        if (m.error) { validation.textContent = m.error; validation.hidden = false; }
        message.focus();
      }
      return;
    }
    if (m.type === "state") { state = m; render(); }
  });
  render();
  post({ type: "ready" });
}

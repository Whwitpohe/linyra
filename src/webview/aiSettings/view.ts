import { localize } from "../../i18n";
import { hostOf } from "../../ai/errors";
import { DEFAULT_BASE_URL, effortLabel } from "../../ai/profileModel";
import {
  ADDRESS_PRESETS, addressOf, checkForm, draftOf, effortNote, effortView, filterModels, fitEffort, isDefaultAddress, keyChoice, keyNote, keyPlaceholder, keyState,
  modelDescription, modelsNote, modelsReadable, newDraft, profileFacts, removalText, showsStoredKey, storedKeyText, testReport, usesStoredKey, withProtocol,
  type FieldMessage, type FormCheck, type KeyMode, type ModelsLoad, type ReportLine, type TestReport,
} from "../../ai/settingsModel";
import type { AiSettingsHostMessage, AiSettingsState, AiSettingsView, AiSettingsWebviewMessage, DraftProfile, ProfileRow } from "../../ai/settingsProtocol";
import type { AiEffort, AiModel, AiProtocol } from "../../ai/types";
import { codiconElement, type Codicon } from "../codicons";
import { byId, h } from "../dom";
import { SuggestBox } from "../suggest";
import type { Suggestion } from "../suggestModel";

export interface AiSettingsApi {
  postMessage(message: AiSettingsWebviewMessage): void;
}

type Field = "baseUrl" | "key" | "model" | "label";

/** The form being filled in: an existing profile (draft.id) or a new one. */
interface Form {
  draft: DraftProfile;
  /** The listed model the field names, for its thinking levels. */
  info?: AiModel;
  keyMode: KeyMode;
  /** Anthropic and Gemini show their own address as text until "Use another address" opens the field. */
  custom: boolean;
  /** Fields left once: their errors show from then on (Save and Test touch them all). */
  touched: Set<Field>;
}

const RESULT_ICON: Record<ReportLine["status"], Codicon> = { ok: "pass", warning: "warning", failed: "error", skipped: "circle-slash" };
const MESSAGE_ICON: Record<FieldMessage["severity"], Codicon> = { error: "error", warning: "warning", info: "info" };

/**
 * The Linyra AI page: the profiles (Use, Edit, Remove with a confirmation that says what goes),
 * and one form that adds or edits a profile, loads its provider's models, tests the connection
 * and saves. The host does the work and owns the keys; this page never holds a stored key, only
 * the one being typed.
 */
export function mountAiSettings(api: AiSettingsApi, events: EventTarget = window): void {
  const post = (m: AiSettingsWebviewMessage) => api.postMessage(m);
  const enabled = byId<HTMLElementTagNameMap["vscode-checkbox"]>("ai-enabled");
  const enabledNote = byId("ai-enabled-note");
  const statusLine = byId("ai-status");
  const addButton = byId<HTMLButtonElement>("ai-add");
  const empty = byId("ai-empty");
  const list = byId<HTMLUListElement>("ai-profiles");
  const editor = byId("ai-editor");
  const formEl = byId<HTMLFormElement>("ai-form");
  const addressFixed = byId("ai-address-fixed");
  const addressEdit = byId("ai-address-edit");
  const baseUrl = byId<HTMLInputElement>("ai-base-url");
  const addressReset = byId<HTMLButtonElement>("ai-address-reset");
  const addressCustom = byId<HTMLButtonElement>("ai-address-custom");
  const presets = byId("ai-presets");
  const keyStored = byId("ai-key-stored");
  const keyEntry = byId("ai-key-entry");
  const keyInput = byId<HTMLInputElement>("ai-key");
  const keyReplace = byId<HTMLButtonElement>("ai-key-replace");
  const keyRemove = byId<HTMLButtonElement>("ai-key-remove");
  const keyCancel = byId<HTMLButtonElement>("ai-key-cancel");
  const keyLabel = byId<HTMLLabelElement>("ai-key-label");
  const modelBox = byId("ai-model-box");
  const modelInput = byId<HTMLInputElement>("ai-model");
  const modelOpen = byId<HTMLButtonElement>("ai-model-open");
  const modelReload = byId<HTMLButtonElement>("ai-model-reload");
  const modelNoteEl = byId("ai-model-note");
  const effortField = byId("ai-effort-field");
  const efforts = byId("ai-efforts");
  const effortNoteEl = byId("ai-effort-note");
  const nameInput = byId<HTMLInputElement>("ai-name");
  const useField = byId("ai-use-field");
  const useBox = byId<HTMLElementTagNameMap["vscode-checkbox"]>("ai-use");
  const testButton = byId<HTMLButtonElement>("ai-test");
  const testProgress = byId("ai-test-progress");
  const testResult = byId("ai-test-result");
  const saveButton = byId<HTMLButtonElement>("ai-save");
  const saveError = byId("ai-save-error");

  let state: AiSettingsState = { type: "state", enabled: false, activeId: undefined, profiles: [] };
  let form: Form | undefined;
  /** The row whose Remove waits for its confirmation. */
  let confirming: string | undefined;
  let models: AiModel[] = [];
  let load: ModelsLoad = { state: "idle" };
  /** What the model list was last asked for: provider, address and key. */
  let loadedFor = "";
  let modelsSeq = 0;
  let modelsTimer: ReturnType<typeof setTimeout> | undefined;
  let testSeq = 0;
  /** A test running, and the draft it tests (its report is read against that one). */
  let testing: { seq: number; draft: DraftProfile } | undefined;
  let saving = false;

  const protocolRadios = () => [...formEl.querySelectorAll<HTMLInputElement>('input[name="ai-protocol"]')];
  const rowOf = (id: string) => [...list.children].find((li) => (li as HTMLElement).dataset.id === id) as HTMLElement | undefined;
  const currentKeyState = (f: Form) => keyState(f.draft, state.profiles);
  const currentChoice = (f: Form) => keyChoice(currentKeyState(f), f.keyMode, keyInput.value);
  /** The draft as it is sent: trimmed, its thinking level one the model takes. */
  const outgoing = (f: Form): DraftProfile => {
    const model = f.draft.model.trim();
    return { ...f.draft, model, label: f.draft.label.trim(), effort: fitEffort(f.draft.effort, effortView(f.draft.protocol, model, f.info)) };
  };

  // ── The status line, the switch and the list ────────────────────────────

  function status(text: string, kind: "ok" | "error" = "ok"): void {
    statusLine.hidden = !text;
    statusLine.className = `ai-status ${kind}`;
    byId("ai-status-icon").replaceChildren(codiconElement(kind === "ok" ? "pass" : "error"));
    byId("ai-status-text").textContent = text;
  }

  function renderHeader(): void {
    const active = state.profiles.find((p) => p.id === state.activeId);
    enabled.checked = state.enabled;
    enabled.disabled = state.profiles.length === 0;
    enabledNote.textContent = state.profiles.length === 0 ? localize("Add a profile first.")
      : !state.enabled ? localize("Off: nothing is sent to any AI provider.")
      : active ? localize("On: ✨ uses “{0}”.", active.label) : localize("On, but no profile is in use: choose one below.");
    addButton.className = state.profiles.length === 0 ? "button primary" : "button secondary";
  }

  function rowButton(action: string, text: string, label: string, primary = false): HTMLButtonElement {
    return h("button", { type: "button", class: primary ? "button primary small" : "button secondary small", "data-action": action, "aria-label": label }, [text]);
  }

  function confirmBox(p: ProfileRow): HTMLElement {
    const text = removalText(p, state.profiles, state.activeId);
    const id = `ai-confirm-${state.profiles.indexOf(p)}`;
    return h("div", { class: "ai-confirm", role: "group", "aria-labelledby": id }, [
      h("p", { class: "ai-confirm-question", id }, [codiconElement("warning"), h("span", {}, [text.question])]),
      ...text.details.map((d) => h("p", { class: "ai-confirm-detail" }, [d])),
      h("div", { class: "ai-confirm-buttons" }, [
        rowButton("confirmRemove", localize("Remove"), localize("Remove “{0}”", p.label), true),
        rowButton("cancelRemove", localize("Cancel"), localize("Keep “{0}”", p.label)),
      ]),
    ]);
  }

  function row(p: ProfileRow): HTMLLIElement {
    const active = p.id === state.activeId;
    const editing = form?.draft.id === p.id;
    return h("li", { class: `ai-profile${active ? " active" : ""}${editing ? " editing" : ""}`, "data-id": p.id, "aria-current": active ? "true" : undefined }, [
      h("span", { class: "ai-profile-mark", "aria-hidden": "true" }, [active ? codiconElement("pass") : null]),
      h("div", { class: "ai-profile-text" }, [
        h("div", { class: "ai-profile-title" }, [
          h("span", { class: "ai-profile-name" }, [p.label]),
          active ? h("span", { class: "ai-badge" }, [state.enabled ? localize("In use") : localize("Chosen · AI is off")]) : null,
          editing ? h("span", { class: "ai-badge outline" }, [localize("Editing")]) : null,
        ]),
        h("div", { class: "ai-profile-facts" }, [profileFacts(p).join(" · ")]),
      ]),
      h("div", { class: "ai-profile-actions" }, [
        active ? null : rowButton("use", localize("Use"), localize("Use “{0}”", p.label)),
        rowButton("edit", localize("Edit"), localize("Edit “{0}”", p.label)),
        rowButton("remove", localize("Remove…"), localize("Remove “{0}”…", p.label)),
      ]),
      confirming === p.id ? confirmBox(p) : null,
    ]);
  }

  /** The list again; the focus stays on the same row and button, or moves to its neighbour when the row went. */
  function renderList(): void {
    const focused = document.activeElement instanceof HTMLElement && list.contains(document.activeElement) ? document.activeElement : undefined;
    const focusId = focused?.closest<HTMLElement>("li")?.dataset.id;
    const focusIndex = focusId ? [...list.children].findIndex((li) => (li as HTMLElement).dataset.id === focusId) : -1;
    empty.hidden = state.profiles.length > 0;
    list.hidden = state.profiles.length === 0;
    list.replaceChildren(...state.profiles.map(row));
    if (!focusId) return;
    if (rowOf(focusId)) focusRow(focusId, focused?.dataset.action);
    else {
      const next = state.profiles[Math.min(focusIndex, state.profiles.length - 1)];
      if (next) focusRow(next.id);
      else addButton.focus();
    }
  }

  function focusRow(id: string, action?: string): void {
    const li = rowOf(id);
    if (!li) return;
    const target = (action ? li.querySelector<HTMLElement>(`[data-action="${action}"]`) : null) ?? li.querySelector<HTMLElement>("button");
    target?.focus();
    li.scrollIntoView({ block: "nearest" });
  }

  /** A short highlight on the row a command opened the page on. */
  function flash(id: string): void {
    const li = rowOf(id);
    if (!li) return;
    li.classList.remove("flash");
    void li.offsetWidth;
    li.classList.add("flash");
  }

  list.addEventListener("click", (e) => {
    const button = (e.target as Element).closest<HTMLButtonElement>("button[data-action]");
    const id = button?.closest<HTMLElement>("li")?.dataset.id;
    const p = id === undefined ? undefined : state.profiles.find((x) => x.id === id);
    if (!button || !p) return;
    switch (button.dataset.action) {
      case "use": post({ type: "use", id: p.id }); return;
      case "edit": openForm(draftOf(p)); return;
      case "remove":
        confirming = p.id;
        renderList();
        focusRow(p.id, "confirmRemove");
        return;
      case "confirmRemove":
        confirming = undefined;
        button.disabled = true;
        post({ type: "remove", id: p.id });
        return;
      case "cancelRemove":
        confirming = undefined;
        renderList();
        focusRow(p.id, "remove");
        return;
    }
  });
  list.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !confirming) return;
    e.preventDefault();
    const id = confirming;
    confirming = undefined;
    renderList();
    focusRow(id, "remove");
  });

  // ── The form ────────────────────────────────────────────────────────────

  function openForm(draft: DraftProfile): void {
    stopTest();
    form = { draft: { ...draft }, keyMode: "auto", custom: draft.protocol !== "openai" && !isDefaultAddress(draft), touched: new Set() };
    confirming = undefined;
    editor.hidden = false;
    const editing = draft.id === undefined ? undefined : state.profiles.find((p) => p.id === draft.id);
    byId("ai-form-title").textContent = editing ? localize("Edit “{0}”", editing.label) : localize("Add Profile");
    for (const r of protocolRadios()) r.checked = r.value === draft.protocol;
    baseUrl.value = draft.baseUrl;
    keyInput.value = "";
    modelInput.value = draft.model;
    nameInput.value = draft.label;
    // Editing the profile in use: it stays in use. A new one is used at once unless unticked.
    useField.hidden = !!editing && editing.id === state.activeId;
    useBox.checked = !editing;
    testResult.hidden = true;
    testProgress.textContent = "";
    saveError.hidden = true;
    saving = false;
    models = [];
    load = { state: "idle" };
    loadedFor = "";
    renderForm();
    renderList();
    editor.scrollIntoView({ block: "nearest" });
    protocolRadios().find((r) => r.checked)?.focus();
    scheduleModels(0);
  }

  function closeForm(focusBack = true): void {
    if (!form) return;
    const id = form.draft.id;
    stopTest();
    clearTimeout(modelsTimer);
    suggest.close();
    form = undefined;
    editor.hidden = true;
    renderList();
    if (!focusBack) return;
    if (id && rowOf(id)) focusRow(id, "edit");
    else addButton.focus();
  }

  function message(target: HTMLElement, input: HTMLElement | null, m: FieldMessage | undefined, touched: boolean): void {
    const shown = m && (m.severity === "info" || touched) ? m : undefined;
    target.hidden = !shown;
    target.className = `ai-message${shown ? ` ${shown.severity}` : ""}`;
    target.replaceChildren(...(shown ? [codiconElement(MESSAGE_ICON[shown.severity]), h("span", {}, [shown.text])] : []));
    input?.setAttribute("aria-invalid", String(shown?.severity === "error"));
  }

  function renderChecks(): FormCheck | undefined {
    if (!form) return undefined;
    const f = form;
    const choice = currentChoice(f);
    const check = checkForm(f.draft, state.profiles, currentKeyState(f), choice);
    message(byId("ai-base-url-msg"), baseUrl, check.baseUrl, f.touched.has("baseUrl"));
    message(byId("ai-key-msg"), keyInput, check.key, f.touched.has("key"));
    message(byId("ai-model-msg"), modelInput, check.model, f.touched.has("model"));
    message(byId("ai-name-msg"), nameInput, check.label, f.touched.has("label"));
    const note = modelsNote(load, modelsReadable(f.draft, choice), f.draft.baseUrl);
    modelNoteEl.textContent = note?.text ?? "";
    modelNoteEl.className = `ai-hint${note ? ` ${note.severity}` : ""}`;
    return check;
  }

  let effortsShown = "";
  function renderEfforts(): void {
    if (!form) return;
    const d = form.draft;
    const view = effortView(d.protocol, d.model, form.info);
    const effort = fitEffort(d.effort, view);
    const offered = d.model.trim() !== "" && view.choices.length > 1;
    efforts.hidden = !offered;
    const key = offered ? view.choices.join(" ") : "";
    if (key !== effortsShown) {
      effortsShown = key;
      efforts.replaceChildren(...(offered ? view.choices.map((e) => h("label", { class: "ai-segment" }, [
        h("input", { type: "radio", name: "ai-effort", value: e }),
        h("span", {}, [effortLabel(e)]),
      ])) : []));
    }
    for (const r of efforts.querySelectorAll<HTMLInputElement>("input")) r.checked = r.value === effort;
    effortNoteEl.textContent = effortNote(view, d.model, effort);
    effortField.classList.toggle("quiet", !offered);
  }

  function renderPresets(f: Form): void {
    const address = addressOf(f.draft.baseUrl);
    const options = ADDRESS_PRESETS[f.draft.protocol];
    presets.hidden = options.length === 0;
    presets.replaceChildren(...options.map((p) => h("button", {
      type: "button", class: "ai-preset", "data-url": p.url, "aria-pressed": String(address === p.url), title: p.url,
    }, [p.name])));
  }

  function renderForm(): void {
    if (!form) return;
    const f = form;
    const d = f.draft;
    // The address: Anthropic's and Gemini's own as text, else the field (with the usual local servers for OpenAI-compatible).
    const fixed = d.protocol !== "openai" && !f.custom;
    addressFixed.hidden = !fixed;
    addressEdit.hidden = fixed;
    byId("ai-address-fixed-text").textContent = addressOf(d.baseUrl) ?? d.baseUrl;
    addressReset.hidden = d.protocol === "openai";
    addressReset.textContent = localize("Use {0}", hostOf(DEFAULT_BASE_URL[d.protocol]));
    renderPresets(f);
    // The key: the stored one's line, or the password field.
    const ks = currentKeyState(f);
    const stored = showsStoredKey(ks, f.keyMode);
    keyStored.hidden = !stored;
    keyEntry.hidden = stored;
    keyLabel.htmlFor = stored ? "" : "ai-key";
    byId("ai-key-stored-text").textContent = storedKeyText(ks);
    keyCancel.hidden = !(usesStoredKey(ks) && f.keyMode !== "auto");
    keyInput.placeholder = keyPlaceholder(d.protocol);
    byId("ai-key-note").textContent = keyNote(d, ks, f.keyMode);
    renderEfforts();
    renderChecks();
    testButton.textContent = testing ? localize("Stop Test") : localize("Test Connection");
    saveButton.disabled = saving;
    saveButton.textContent = saving ? localize("Saving…") : localize("Save");
  }

  /** Every field shown as checked (Save, Test): the first one with an error takes the focus. */
  function checkAll(): boolean {
    if (!form) return false;
    for (const field of ["baseUrl", "key", "model", "label"] as const) form.touched.add(field);
    if (form.draft.protocol !== "openai" && !isDefaultAddress(form.draft)) form.custom = true;
    renderForm();
    const check = renderChecks();
    if (check?.ok) return true;
    const first = check?.baseUrl?.severity === "error" ? baseUrl : check?.key?.severity === "error" ? keyInput : check?.model?.severity === "error" ? modelInput : nameInput;
    first.focus();
    return false;
  }

  // ── The model list ──────────────────────────────────────────────────────

  function scheduleModels(delay: number): void {
    clearTimeout(modelsTimer);
    modelsTimer = setTimeout(() => loadModels(false), delay);
  }

  function loadModels(force: boolean): void {
    if (!form) return;
    const d = form.draft;
    const choice = currentChoice(form);
    if (modelsReadable(d, choice) !== "yes") {
      models = [];
      load = { state: "idle" };
      loadedFor = "";
      renderChecks();
      return;
    }
    const wanted = `${d.protocol}\n${addressOf(d.baseUrl)}\n${d.id ?? ""}\n${JSON.stringify(choice)}`;
    if (!force && wanted === loadedFor) return;
    loadedFor = wanted;
    models = [];
    load = { state: "loading" };
    post({ type: "models", seq: ++modelsSeq, draft: { ...d }, key: choice });
    renderChecks();
    suggest.refresh();
  }

  const suggestions = new WeakMap<AiModel, Suggestion>();
  const modelOf = new WeakMap<Suggestion, AiModel>();
  const suggestionOf = (m: AiModel): Suggestion => {
    let s = suggestions.get(m);
    if (!s) {
      s = { value: m.id, label: m.id, description: modelDescription(m) || undefined };
      suggestions.set(m, s);
      modelOf.set(s, m);
    }
    return s;
  };
  const suggest = new SuggestBox(modelInput, modelBox, {
    matches(force) {
      if (!form) return { items: [] };
      if (load.state === "loading") return { items: [], hint: { text: localize("Fetching the models of {0}…"), code: [hostOf(form.draft.baseUrl)] } };
      if (load.state !== "loaded") {
        const note = force ? modelsNote(load, modelsReadable(form.draft, currentChoice(form)), form.draft.baseUrl) : undefined;
        return { items: [], hint: note ? { text: note.text, code: [] } : undefined };
      }
      const typed = modelInput.value.trim();
      const q = typed.toLowerCase();
      const exact = models.some((m) => m.id.toLowerCase() === q);
      const items = filterModels(models, typed).map((m) => {
        const at = q && !exact ? m.id.toLowerCase().indexOf(q) : -1;
        return { item: suggestionOf(m), label: at >= 0 ? [at, at + q.length] as [number, number] : null };
      });
      if (items.length > 0 || !q) return { items };
      return { items, hint: { text: localize("No listed model matches {0}: it is used as typed."), code: [typed] } };
    },
    pick(item) {
      const m = modelOf.get(item);
      if (!form || !m) return;
      modelInput.value = m.id;
      form.draft.model = m.id;
      form.info = m;
      form.touched.add("model");
      dropTest();
      renderForm();
    },
  }, { minWidth: 280, maxHeight: 320 });

  // ── Test Connection ─────────────────────────────────────────────────────

  function stopTest(): void {
    if (testing) post({ type: "stopTest" });
    testing = undefined;
    testProgress.textContent = "";
  }

  /** The form changed: a running test or its report no longer says anything about it. */
  function dropTest(): void {
    stopTest();
    testResult.hidden = true;
  }

  function showReport(report: TestReport): void {
    testResult.hidden = false;
    testResult.className = `ai-result ${report.ok ? "ok" : report.lines.length ? "failed" : "stopped"}`;
    byId("ai-test-title").replaceChildren(codiconElement(report.ok ? "pass" : report.lines.length ? "error" : "circle-slash"), h("span", {}, [report.title]));
    byId("ai-test-lines").replaceChildren(...report.lines.map((line) => h("li", { class: `ai-result-line ${line.status}` }, [
      codiconElement(RESULT_ICON[line.status]),
      h("span", { class: "ai-result-text" }, [
        h("span", {}, [line.text]),
        line.next ? h("span", { class: "ai-result-next" }, [line.next]) : null,
        line.detail ? h("span", { class: "ai-result-detail" }, [line.detail]) : null,
      ]),
    ])));
  }

  testButton.addEventListener("click", () => {
    if (!form) return;
    if (testing) {
      stopTest();
      renderForm();
      return;
    }
    if (!checkAll()) return;
    const draft = outgoing(form);
    testing = { seq: ++testSeq, draft };
    testResult.hidden = true;
    testProgress.textContent = localize("Testing…");
    post({ type: "test", seq: testing.seq, draft, key: currentChoice(form) });
    renderForm();
  });

  // ── Field events ────────────────────────────────────────────────────────

  formEl.addEventListener("change", (e) => {
    const target = e.target as HTMLInputElement;
    if (!form || target.type !== "radio") return;
    if (target.name === "ai-protocol") {
      form.draft = withProtocol(form.draft, target.value as AiProtocol);
      form.custom = false;
      form.keyMode = "auto";
      form.info = undefined;
      keyInput.value = "";
      baseUrl.value = form.draft.baseUrl;
      modelInput.value = form.draft.model;
      models = [];
      load = { state: "idle" };
      loadedFor = "";
      dropTest();
      renderForm();
      scheduleModels(0);
    } else if (target.name === "ai-effort") {
      form.draft.effort = target.value as AiEffort;
      dropTest();
      renderEfforts();
    }
  });
  baseUrl.addEventListener("input", () => {
    if (!form) return;
    form.draft.baseUrl = baseUrl.value;
    dropTest();
    renderForm();
    scheduleModels(600);
  });
  keyInput.addEventListener("input", () => {
    if (!form) return;
    dropTest();
    renderChecks();
    scheduleModels(600);
  });
  modelInput.addEventListener("input", () => {
    if (!form) return;
    form.draft.model = modelInput.value;
    const id = modelInput.value.trim();
    if (form.info?.id !== id) form.info = models.find((m) => m.id === id);
    dropTest();
    renderEfforts();
    renderChecks();
  });
  // Enter with the list open and no row chosen closes the list; it does not save yet.
  modelInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && suggest.isOpen && !suggest.hasActive) {
      e.preventDefault();
      suggest.close();
    }
  });
  nameInput.addEventListener("input", () => {
    if (!form) return;
    form.draft.label = nameInput.value;
    renderChecks();
  });
  for (const [input, field] of [[baseUrl, "baseUrl"], [keyInput, "key"], [modelInput, "model"], [nameInput, "label"]] as const) {
    input.addEventListener("blur", () => {
      if (!form || (input === modelInput && suggest.isOpen)) return;
      form.touched.add(field);
      renderChecks();
    });
  }
  presets.addEventListener("click", (e) => {
    const button = (e.target as Element).closest<HTMLButtonElement>("button[data-url]");
    if (!form || !button?.dataset.url) return;
    baseUrl.value = form.draft.baseUrl = button.dataset.url;
    dropTest();
    renderForm();
    scheduleModels(0);
  });
  addressCustom.addEventListener("click", () => {
    if (!form) return;
    form.custom = true;
    renderForm();
    baseUrl.focus();
    baseUrl.select();
  });
  addressReset.addEventListener("click", () => {
    if (!form) return;
    form.custom = false;
    baseUrl.value = form.draft.baseUrl = DEFAULT_BASE_URL[form.draft.protocol];
    dropTest();
    renderForm();
    scheduleModels(0);
    addressCustom.focus();
  });
  const setKeyMode = (mode: KeyMode, focus: HTMLElement) => {
    if (!form) return;
    form.keyMode = mode;
    keyInput.value = "";
    dropTest();
    renderForm();
    scheduleModels(0);
    focus.focus();
  };
  keyReplace.addEventListener("click", () => setKeyMode("replace", keyInput));
  keyRemove.addEventListener("click", () => setKeyMode("remove", keyInput));
  keyCancel.addEventListener("click", () => setKeyMode("auto", keyReplace));
  modelOpen.addEventListener("mousedown", (e) => e.preventDefault());
  modelOpen.addEventListener("click", () => {
    if (suggest.isOpen) return suggest.close();
    modelInput.focus();
    suggest.show(true);
  });
  modelReload.addEventListener("click", () => {
    loadModels(true);
    if (form) form.touched.add("key");
    renderChecks();
  });

  formEl.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!form || saving || !checkAll()) return;
    saving = true;
    saveError.hidden = true;
    post({ type: "save", draft: outgoing(form), key: currentChoice(form), use: !useField.hidden && useBox.checked });
    renderForm();
  });
  byId("ai-cancel").addEventListener("click", () => closeForm());
  addButton.addEventListener("click", () => {
    const active = state.profiles.find((p) => p.id === state.activeId);
    openForm(newDraft(active?.protocol));
  });
  enabled.addEventListener("change", () => post({ type: "enable", on: enabled.checked }));
  byId("ai-more").addEventListener("click", () => post({ type: "moreSettings" }));

  // ── The host ────────────────────────────────────────────────────────────

  function onOpen(view: AiSettingsView): void {
    if (view.view === "add") {
      if (form?.draft.id === undefined && form) protocolRadios().find((r) => r.checked)?.focus();
      else openForm(newDraft(state.profiles.find((p) => p.id === state.activeId)?.protocol));
      return;
    }
    const target = view.focus === "first" ? state.profiles[0] : state.profiles.find((p) => p.id === state.activeId) ?? state.profiles[0];
    if (!target) return addButton.focus();
    focusRow(target.id);
    flash(target.id);
  }

  events.addEventListener("message", (event) => {
    const m = (event as MessageEvent).data as AiSettingsHostMessage;
    switch (m?.type) {
      case "state":
        state = m;
        if (confirming && !state.profiles.some((p) => p.id === confirming)) confirming = undefined;
        renderHeader();
        if (form?.draft.id !== undefined && !state.profiles.some((p) => p.id === form!.draft.id)) closeForm(false);
        renderList();
        renderForm();
        return;
      case "open":
        onOpen(m);
        return;
      case "models":
        if (!form || m.seq !== modelsSeq) return;
        if (m.models) {
          models = m.models;
          load = { state: "loaded", count: models.length };
          form.info ??= models.find((x) => x.id === form!.draft.model.trim());
        } else {
          models = [];
          load = { state: "failed", error: m.error ?? "" };
        }
        renderForm();
        suggest.refresh();
        return;
      case "testStep":
        if (testing?.seq === m.seq) testProgress.textContent = m.step === 1 ? localize("Checking the address and the key…") : localize("Asking {0} for a short answer…", testing.draft.model);
        return;
      case "tested": {
        if (!form || testing?.seq !== m.seq) return;
        const report = testReport(m.outcome, testing.draft);
        testing = undefined;
        testProgress.textContent = "";
        showReport(report);
        renderForm();
        return;
      }
      case "done":
        if (m.action === "save") {
          saving = false;
          if (m.error) {
            saveError.hidden = false;
            saveError.textContent = m.error;
            renderForm();
            return;
          }
          closeForm(false);
          status(m.note ?? "");
          if (m.id) {
            focusRow(m.id, "edit");
            flash(m.id);
          }
          return;
        }
        status(m.error ?? m.note ?? "", m.error ? "error" : "ok");
        if (m.action === "use" && m.id) focusRow(m.id, "edit");
        return;
    }
  });
  post({ type: "ready" });
}

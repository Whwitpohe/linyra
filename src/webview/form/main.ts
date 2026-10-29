import { localize } from "../../i18n";
import "./form.css";
// Registers <vscode-checkbox> (VS Code Elements, MIT): the same boxes as the Repo List.
import "@vscode-elements/elements/dist/vscode-checkbox/index.js";
import { fieldProblem, formProblems, initialValues, type FormField, type FormHost, type FormSpec, type FormValues, type FormWebview } from "../../formModel";
import { byId, h } from "../dom";

declare function acquireVsCodeApi(): { postMessage(m: FormWebview): void };
const vscodeApi = acquireVsCodeApi();
const post = (m: FormWebview) => vscodeApi.postMessage(m);

type Checkbox = HTMLElement & { checked: boolean; disabled: boolean };

let spec: FormSpec | undefined;
let values: FormValues = {};
/** A field's error shows once it was left or the form was submitted, not while it is first typed. */
const touched = new Set<string>();
let busy = false;

const form = byId<HTMLFormElement>("form");
const fields = byId("form-fields");
const submit = byId<HTMLButtonElement>("form-submit");
const cancel = byId<HTMLButtonElement>("form-cancel");
const status = byId("form-status");

function checkbox(label: (Node | string)[], checked: boolean, describedBy?: string): Checkbox {
  const box = document.createElement("vscode-checkbox") as Checkbox;
  box.checked = checked;
  if (describedBy) box.setAttribute("aria-describedby", describedBy);
  box.append(...label);
  return box;
}

function errorLine(id: string): HTMLElement {
  return h("div", { id: `${id}-error`, class: "field-error", role: "alert" });
}

function renderField(f: FormField): HTMLElement {
  const id = `field-${f.id}`;
  if (f.kind === "text") {
    const input = f.multiline
      ? h("textarea", { id, rows: "3", placeholder: f.placeholder, spellcheck: "true", "aria-describedby": `${id}-hint ${id}-error` })
      : h("input", { id, type: "text", placeholder: f.placeholder, autocomplete: "off", spellcheck: "false", "aria-describedby": `${id}-hint ${id}-error` });
    input.value = typeof values[f.id] === "string" ? values[f.id] as string : "";
    input.addEventListener("input", () => { values[f.id] = input.value; showProblem(f); });
    input.addEventListener("blur", () => { touched.add(f.id); showProblem(f); });
    return h("div", { class: "field", "data-field": f.id }, [
      h("label", { for: id, class: "field-label" }, [f.label]), input,
      h("div", { id: `${id}-hint`, class: "field-hint" }, [f.hint ?? ""]), errorLine(id)]);
  }
  if (f.kind === "check") {
    const box = checkbox([f.label], values[f.id] === true, `${id}-hint`);
    box.id = id;
    box.addEventListener("change", () => { values[f.id] = box.checked; });
    return h("div", { class: "field field-check", "data-field": f.id }, [box, h("div", { id: `${id}-hint`, class: "field-hint indent" }, [f.hint ?? ""])]);
  }
  if (f.kind === "list") {
    const ticked = new Set(Array.isArray(values[f.id]) ? values[f.id] as string[] : []);
    const offered = f.items.filter((i) => !i.disabled), left = f.items.filter((i) => i.disabled);
    const rows = offered.map((item) => {
      const detailId = `${id}-${item.id}-detail`;
      const box = checkbox([h("span", { class: "item-label" }, [item.label]), ...(item.description ? [h("span", { class: "item-description" }, [item.description])] : [])], ticked.has(item.id), item.detail ? detailId : undefined);
      box.dataset.item = item.id;
      box.addEventListener("change", () => {
        const now = new Set(Array.isArray(values[f.id]) ? values[f.id] as string[] : []);
        if (box.checked) now.add(item.id); else now.delete(item.id);
        values[f.id] = f.items.filter((i) => now.has(i.id)).map((i) => i.id);
        touched.add(f.id);
        showProblem(f);
      });
      return h("li", { class: "item" }, [box, ...(item.detail ? [h("div", { id: detailId, class: "item-detail" }, [item.detail])] : [])]);
    });
    const notOffered = left.length === 0 ? [] : [h("div", { class: "not-offered" }, [
      h("div", { class: "not-offered-title" }, [localize("Not offered")]),
      h("ul", {}, left.map((i) => h("li", {}, [h("span", { class: "item-label" }, [i.label]), h("span", { class: "item-description" }, [i.disabled ?? ""])]))),
    ])];
    return h("fieldset", { class: "field field-list", "data-field": f.id, "aria-describedby": `${id}-hint ${id}-error` }, [
      h("legend", { class: "field-label" }, [f.label]),
      h("div", { id: `${id}-hint`, class: "field-hint" }, [f.hint ?? ""]),
      h("ul", { class: "items" }, rows), errorLine(id), ...notOffered]);
  }
  return h("details", { class: "field field-preview", "data-field": f.id }, [
    h("summary", { class: "field-label" }, [f.label]), h("pre", { class: "preview", tabindex: "0" }, [f.text])]);
}

function showProblem(f: FormField, force = false): string | undefined {
  const problem = fieldProblem(f, values[f.id]);
  const el = document.getElementById(`field-${f.id}-error`);
  // A name is checked as it is typed; an empty one only once it was left (or on submit).
  const typed = f.kind === "text" && typeof values[f.id] === "string" && (values[f.id] as string).trim() !== "";
  const shown = problem && (force || touched.has(f.id) || typed) ? problem : "";
  if (el) el.textContent = shown;
  const input = document.getElementById(`field-${f.id}`);
  if (input && f.kind === "text") input.setAttribute("aria-invalid", String(!!problem));
  return problem;
}

function render(next: FormSpec): void {
  spec = next;
  values = initialValues(next);
  touched.clear();
  document.title = next.title;
  byId("form-title").textContent = next.title;
  const intro = byId("form-intro");
  intro.textContent = next.intro ?? "";
  intro.hidden = !next.intro;
  fields.replaceChildren(...next.fields.map(renderField));
  submit.textContent = next.submit;
  cancel.textContent = next.cancel;
  setBusy(false);
  // The first field to fill gets the focus; a form of checkboxes only, the button.
  const first = fields.querySelector<HTMLElement>("input, textarea") ?? submit;
  first.focus();
}

function setBusy(on: boolean): void {
  busy = on;
  submit.disabled = on;
  status.textContent = on ? localize("Working…") : "";
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!spec || busy) return;
  const problems = formProblems(spec, values);
  for (const f of spec.fields) showProblem(f, true);
  const first = spec.fields.find((f) => problems[f.id]);
  if (first) {
    const target = document.querySelector<HTMLElement>(`[data-field="${first.id}"] input, [data-field="${first.id}"] textarea, [data-field="${first.id}"] vscode-checkbox`);
    target?.focus();
    return;
  }
  setBusy(true);
  post({ type: "submit", values });
});
cancel.addEventListener("click", () => post({ type: "cancel" }));
document.addEventListener("keydown", (event) => {
  // Escape while an input method is composing closes its candidates, not the form.
  if (event.key === "Escape" && !busy && !event.isComposing) post({ type: "cancel" });
  // Ctrl/Cmd+Enter submits from a multi-line field too.
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) form.requestSubmit();
});

window.addEventListener("message", (event: MessageEvent<FormHost>) => {
  const m = event.data;
  if (m?.type === "spec") render(m.spec);
  else if (m?.type === "problems" && spec) {
    setBusy(false);
    for (const [id, text] of Object.entries(m.problems)) {
      const el = document.getElementById(`field-${id}-error`);
      if (el) el.textContent = text;
    }
  }
});

post({ type: "ready" });

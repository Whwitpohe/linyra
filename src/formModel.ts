import { isValidRef } from "./filterModel";
import { localize } from "./i18n";

/**
 * A review form: everything an action across repositories will do, on one page, before anything
 * runs (Release…, Tag Across Repositories…). The host sends the fields; the page shows them,
 * checks them as the user types and sends back the values; the host checks them again (the page
 * is not trusted). Pure: shared by the extension host and the page.
 */

/** One row of a list of checkboxes: a repository, with what will happen there. */
export interface FormItem {
  id: string;
  label: string;
  /** Beside the label: "develop → main · 4 commits". */
  description?: string;
  /** Under it: what happens there, in words. */
  detail?: string;
  value: boolean;
  /** Not offered, and why ("would conflict"): shown unticked and grayed, never sent. */
  disabled?: string;
}

export type FormField =
  | { kind: "text"; id: string; label: string; value?: string; placeholder?: string; hint?: string; multiline?: boolean;
      /** "ref": a valid tag or branch name; "optionalRef": that, or empty. */
      rule?: "ref" | "optionalRef";
      /** Names already taken, and what to say when one is typed (an error). */
      taken?: readonly string[]; takenMessage?: string }
  | { kind: "check"; id: string; label: string; value: boolean; hint?: string }
  | { kind: "list"; id: string; label: string; items: FormItem[]; hint?: string;
      /** At least one must stay ticked; what to say when none is. */
      required?: string }
  | { kind: "preview"; id: string; label: string; text: string };

export interface FormSpec {
  /** One page per id: opening it again reveals it. */
  id: string;
  title: string;
  /** One line under the title: what the button will do. */
  intro?: string;
  fields: FormField[];
  submit: string;
  cancel: string;
}

export type FormValue = string | boolean | string[];
export type FormValues = Record<string, FormValue>;

export type FormHost = { type: "spec"; spec: FormSpec } | { type: "problems"; problems: Record<string, string> };

/** The longest text a field takes (a pasted changelog as a tag's message fits). */
const MAX_TEXT = 10_000;
export type FormWebview = { type: "ready" } | { type: "submit"; values: FormValues } | { type: "cancel" };

/** The values the fields start with: text as given, checkboxes as given, a list's ticked items. */
export function initialValues(spec: FormSpec): FormValues {
  const values: FormValues = {};
  for (const f of spec.fields) {
    if (f.kind === "text") values[f.id] = f.value ?? "";
    else if (f.kind === "check") values[f.id] = f.value;
    else if (f.kind === "list") values[f.id] = f.items.filter((i) => i.value && !i.disabled).map((i) => i.id);
  }
  return values;
}

/** What is wrong with one field's value; undefined when nothing is. */
export function fieldProblem(f: FormField, value: FormValue | undefined): string | undefined {
  if (f.kind === "text") {
    const v = typeof value === "string" ? value.trim() : "";
    if (typeof value === "string" && value.length > MAX_TEXT) return localize("At most {0} characters.", MAX_TEXT.toLocaleString("en-US"));
    if (f.rule === "ref" && v === "") return localize("Enter a name.");
    if ((f.rule === "ref" || f.rule === "optionalRef") && v !== "" && !isValidRef(v)) return localize("Not a valid name: no spaces, and none of ~ ^ : ? * [ \\.");
    if (v !== "" && f.taken?.includes(v)) return f.takenMessage ?? localize("That name is already taken.");
    return undefined;
  }
  if (f.kind === "list" && f.required) {
    const ids = Array.isArray(value) ? value : [];
    if (ids.length === 0) return f.required;
  }
  return undefined;
}

/** Every field's problem, by field id. */
export function formProblems(spec: FormSpec, values: FormValues): Record<string, string> {
  const problems: Record<string, string> = {};
  for (const f of spec.fields) {
    const p = fieldProblem(f, values[f.id]);
    if (p) problems[f.id] = p;
  }
  return problems;
}

/**
 * The page's answer, checked against the form it was given: only its fields, of their kinds; a
 * list keeps only items it offered (never a disabled one); text trimmed. undefined: not an answer
 * to this form, or a field is wrong (the page should not have sent it).
 */
export function checkValues(spec: FormSpec, raw: unknown): FormValues | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const values: FormValues = {};
  for (const f of spec.fields) {
    const v = r[f.id];
    if (f.kind === "text") {
      if (typeof v !== "string" || v.length > MAX_TEXT) return undefined;
      values[f.id] = f.multiline ? v.replace(/\s+$/, "") : v.trim();
    } else if (f.kind === "check") {
      if (typeof v !== "boolean") return undefined;
      values[f.id] = v;
    } else if (f.kind === "list") {
      if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) return undefined;
      const offered = new Set(f.items.filter((i) => !i.disabled).map((i) => i.id));
      values[f.id] = f.items.filter((i) => offered.has(i.id) && v.includes(i.id)).map((i) => i.id);
    }
  }
  return Object.keys(formProblems(spec, values)).length === 0 ? values : undefined;
}

export const textValue = (values: FormValues, id: string): string => (typeof values[id] === "string" ? values[id] as string : "");
export const checkValue = (values: FormValues, id: string): boolean => values[id] === true;
export const listValue = (values: FormValues, id: string): string[] => (Array.isArray(values[id]) ? values[id] as string[] : []);

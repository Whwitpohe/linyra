import "./prompt.css";
import { localize } from "../../i18n";
import { placePopup, type PromptAnswer, type PromptCheck, type PromptItem, type PromptRect, type PromptRequest, type PromptUpdate } from "../../promptModel";
import { codiconElement } from "../codicons";
import { h } from "../dom";

/** Past this many choices, a box above them filters them, as VS Code's picker does. */
const FILTER_FROM = 8;
/** What is typed in a name is checked once typing pauses this long. */
const CHECK_MS = 120;

export interface PromptHandlers {
  /** The answer, once: undefined when cancelled (Esc, a click outside, another question). */
  answer: (a: PromptAnswer) => void;
  /** A name being typed, to be checked (the host answers through promptChecked). */
  typed?: (value: string) => void;
  /** The button beside a name's box (✨) pressed, its switch as `on`: the host writes into the box (promptUpdated). */
  extra?: (on: boolean) => void;
}

interface Open { id: number; el: HTMLElement; cancel: () => void; checked?: (check: PromptCheck | undefined) => void; updated?: (u: PromptUpdate) => void }
let open: Open | undefined;

/** Whether a question is open (and which). */
export const openPrompt = (): HTMLElement | undefined => open?.el;

/** Cancels the open question, if any. */
export const cancelPrompt = (): void => open?.cancel();

/** The host's check of what was typed in the open name (its id): the words under the box. */
export function promptChecked(id: number, check: PromptCheck | undefined): void {
  if (open?.id === id) open.checked?.(check);
}

/** The host writing into the open name's box (its id) while its button's work runs. */
export function promptUpdated(id: number, update: PromptUpdate): void {
  if (open?.id === id) open.updated?.(update);
}

/** The place a rect or an element id names; an element not shown: the view's top left. */
function placeOf(at: PromptRect | string): PromptRect {
  if (typeof at !== "string") return at;
  const r = document.getElementById(at)?.getBoundingClientRect();
  return r && r.width > 0 ? { x: r.left, y: r.top, w: r.width, h: r.height } : { x: 8, y: 0, w: 0, h: 0 };
}

/**
 * A question asked where the user acted (promptModel.ts): under the button that was clicked, or at
 * the spot that was right-clicked, in place of VS Code's picker at the top of the window. A choice
 * (its description beside it, its detail under it, a pin when the question offers one), several
 * choices with OK, or a name the host checks as it is typed. ↑↓ Home End PageUp PageDown move,
 * Enter answers, Esc or a click outside cancels; the focus goes back to where it was.
 */
export function showPrompt(id: number, req: PromptRequest, at: PromptRect | string, handlers: PromptHandlers): HTMLElement {
  open?.cancel();
  const back = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : undefined;
  const el = h("div", { class: `prompt prompt-${req.kind}`, role: "dialog", "aria-label": req.title });
  el.append(h("div", { class: "prompt-title", id: `prompt-${id}-title` }, [req.title]));
  let done = false;
  const finish = (answer: PromptAnswer) => {
    if (done) return;
    done = true;
    if (open?.el === el) open = undefined;
    el.remove();
    window.removeEventListener("pointerdown", outside, true);
    window.removeEventListener("resize", away);
    if (back?.isConnected) back.focus();
    handlers.answer(answer);
  };
  const outside = (e: Event) => { if (!el.contains(e.target as Node)) finish(undefined); };
  const away = () => finish(undefined);
  const state: Open = { id, el, cancel: () => finish(undefined) };
  const focus = req.kind === "input" ? input(req, el, handlers, finish, state) : choices(id, req, el, finish);
  open = state;
  document.body.append(el);
  const place = placeOf(at);
  const size = el.getBoundingClientRect();
  const spot = placePopup(place, { w: size.width, h: size.height }, { w: window.innerWidth, h: window.innerHeight });
  el.style.left = `${spot.x}px`;
  el.style.top = `${spot.y}px`;
  el.classList.toggle("above", spot.above);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(undefined); }
    else if (e.key === "Tab") { e.preventDefault(); e.stopPropagation(); }
  });
  window.addEventListener("pointerdown", outside, true);
  window.addEventListener("resize", away);
  focus.focus();
  return el;
}

/** One choice or several: a list, filtered when long, a pin on each when offered, OK for several. */
function choices(id: number, req: Extract<PromptRequest, { kind: "pick" | "pickMany" }>, el: HTMLElement, finish: (a: PromptAnswer) => void): HTMLElement {
  const many = req.kind === "pickMany";
  const pin = req.kind === "pick" ? req.pin : undefined;
  const checked = new Set(req.items.flatMap((item, i) => (item.picked ? [i] : [])));
  let shown = req.items.map((_, i) => i);
  let active = shown[0] ?? -1;
  const list = h("div", { class: "prompt-list", id: `prompt-${id}-list`, role: "listbox", tabindex: "0", "aria-labelledby": `prompt-${id}-title`, ...(many ? { "aria-multiselectable": "true" } : {}) });
  const filter = req.items.length >= FILTER_FROM
    ? h("input", { class: "prompt-filter", type: "text", spellcheck: "false", "aria-label": localize("Filter"), placeholder: localize("Type to filter"), "aria-controls": list.id }) as HTMLInputElement
    : undefined;
  const optionId = (i: number) => `prompt-${id}-${i}`;
  const draw = () => {
    list.replaceChildren(...shown.map((i) => row(req.items[i], i)));
    if (shown.length === 0) list.append(h("div", { class: "prompt-empty" }, [localize("No matches")]));
    mark();
  };
  const row = (item: PromptItem, i: number) => h("div", {
    class: "prompt-item", role: "option", id: optionId(i), "data-index": String(i),
    "aria-selected": String(many ? checked.has(i) : i === active),
  }, [
    many ? h("span", { class: "prompt-check", "aria-hidden": "true" }, [checked.has(i) ? codiconElement("check") : null]) : null,
    h("span", { class: "prompt-label" }, [item.label]),
    item.description ? h("span", { class: "prompt-desc" }, [item.description]) : null,
    pin ? h("button", { class: "prompt-pin", type: "button", tabindex: "-1", title: pin, "aria-label": `${pin}: ${item.label}` }, [codiconElement("pin")]) : null,
    item.detail ? h("span", { class: "prompt-detail" }, [item.detail]) : null,
  ]);
  const mark = () => {
    for (const r of list.querySelectorAll<HTMLElement>(".prompt-item")) {
      const i = Number(r.dataset.index);
      r.classList.toggle("active", i === active);
      if (!many) r.setAttribute("aria-selected", String(i === active));
    }
    const current = active >= 0 ? list.querySelector<HTMLElement>(`#${optionId(active)}`) : null;
    (filter ?? list).setAttribute("aria-activedescendant", current ? current.id : "");
    current?.scrollIntoView({ block: "nearest" });
  };
  const move = (to: (n: number, at: number) => number) => {
    if (shown.length === 0) return;
    active = shown[Math.max(0, Math.min(shown.length - 1, to(shown.length, shown.indexOf(active))))];
    mark();
  };
  const toggle = (i: number) => {
    if (checked.has(i)) checked.delete(i); else checked.add(i);
    const r = list.querySelector<HTMLElement>(`#${optionId(i)}`);
    r?.setAttribute("aria-selected", String(checked.has(i)));
    r?.querySelector(".prompt-check")?.replaceChildren(...(checked.has(i) ? [codiconElement("check")] : []));
  };
  const accept = () => {
    if (many) finish({ indexes: [...checked].sort((a, b) => a - b) });
    else if (active >= 0) finish({ index: active });
  };
  const page = () => Math.max(1, Math.floor(list.clientHeight / (list.querySelector<HTMLElement>(".prompt-item")?.offsetHeight || 24)) - 1);
  const keys = (e: KeyboardEvent) => {
    const typing = e.target === filter;
    const run: Record<string, () => void> = {
      ArrowDown: () => move((_, at) => at + 1), ArrowUp: () => move((_, at) => at - 1),
      PageDown: () => move((_, at) => at + page()), PageUp: () => move((_, at) => at - page()),
      Enter: accept,
      ...(typing ? {} : { Home: () => move(() => 0), End: () => move((n) => n - 1) }),
      ...(many && !typing ? { " ": () => { if (active >= 0) toggle(active); } } : {}),
    };
    const k = run[e.key];
    if (!k) return;
    e.preventDefault();
    e.stopPropagation();
    k();
  };
  list.addEventListener("keydown", keys);
  filter?.addEventListener("keydown", keys);
  filter?.addEventListener("input", () => {
    const words = filter.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    shown = req.items.flatMap((item, i) => {
      const text = `${item.label} ${item.description ?? ""} ${item.detail ?? ""}`.toLowerCase();
      return words.every((w) => text.includes(w)) ? [i] : [];
    });
    active = shown[0] ?? -1;
    draw();
  });
  list.addEventListener("pointermove", (e) => {
    const r = (e.target as Element).closest<HTMLElement>(".prompt-item");
    if (r && Number(r.dataset.index) !== active) { active = Number(r.dataset.index); mark(); }
  });
  list.addEventListener("click", (e) => {
    const r = (e.target as Element).closest<HTMLElement>(".prompt-item");
    if (!r) return;
    const i = Number(r.dataset.index);
    if (many) { active = i; toggle(i); mark(); return; }
    finish({ index: i, ...((e.target as Element).closest(".prompt-pin") ? { pin: true } : {}) });
  });
  if (filter) el.append(filter);
  el.append(list);
  if (many) {
    const ok = h("button", { class: "prompt-ok", type: "button" }, [localize("OK")]);
    ok.addEventListener("click", accept);
    el.append(h("div", { class: "prompt-footer" }, [h("span", { class: "prompt-hint" }, [localize("Space ticks, Enter confirms")]), ok]));
  } else if (pin) {
    el.append(h("div", { class: "prompt-footer" }, [h("span", { class: "prompt-hint" }, [codiconElement("pin"), " ", pin])]));
  }
  draw();
  return filter ?? list;
}

/**
 * A name: the host checks it as it is typed; a blocking check keeps Enter from giving it. A switch
 * under it (its line says what Enter does in each state), and a button beside it (✨) whose work
 * the host does and writes into the box (promptUpdated): busy, the box waits.
 */
function input(req: Extract<PromptRequest, { kind: "input" }>, el: HTMLElement, handlers: PromptHandlers, finish: (a: PromptAnswer) => void, state: Open): HTMLElement {
  const titleId = el.firstElementChild!.id;
  const box = h("input", { class: "prompt-input", type: "text", spellcheck: "false", placeholder: req.placeholder, "aria-labelledby": titleId,
    "aria-describedby": `${titleId}-message${req.toggle ? ` ${titleId}-says` : ""}` }) as HTMLInputElement;
  box.value = req.value ?? "";
  const message = h("div", { class: "prompt-message", id: `${titleId}-message`, role: "status", hidden: true });
  let blocking = false;
  let on = req.toggle?.on === true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ask = () => { clearTimeout(timer); timer = undefined; handlers.typed?.(box.value); };
  const give = () => { if (!blocking && !box.readOnly) finish({ value: box.value, ...(req.toggle ? { on } : {}) }); };
  state.checked = (check) => {
    blocking = check?.blocking === true;
    message.hidden = !check;
    message.textContent = check?.message ?? "";
    message.classList.toggle("blocking", blocking);
    message.classList.remove("failed");
    box.setAttribute("aria-invalid", String(blocking));
  };
  box.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(ask, CHECK_MS); });
  box.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    e.stopPropagation();
    // A check still to come is asked first; the host checks the answer again either way.
    if (timer !== undefined) ask();
    give();
  });
  const extra = req.extra ? h("button", { class: "prompt-extra", type: "button", title: req.extra, "aria-label": req.extra }, [codiconElement("sparkle")]) as HTMLButtonElement : undefined;
  extra?.addEventListener("click", () => handlers.extra?.(on));
  state.updated = (u) => {
    if (u.value !== undefined) { box.value = u.value; if (handlers.typed) ask(); }
    if (u.busy !== undefined) {
      box.readOnly = u.busy;
      el.setAttribute("aria-busy", String(u.busy));
      if (extra) extra.disabled = u.busy;
      extra?.replaceChildren(codiconElement(u.busy ? "loading" : "sparkle"));
    }
    // What the work says when it failed: in the message line, as VS Code's box shows it; it does not keep Enter back.
    if (u.message !== undefined) {
      message.hidden = u.message === null;
      message.textContent = u.message ?? "";
      message.classList.toggle("failed", u.message !== null);
    }
  };
  const ok = h("button", { class: "prompt-ok", type: "button" }, [localize("OK")]);
  ok.addEventListener("click", give);
  el.append(extra ? h("div", { class: "prompt-row" }, [box, extra]) : box, message);
  if (req.toggle) {
    const says = h("div", { class: "prompt-says", id: `${titleId}-says` }, [req.toggle.says[on ? 1 : 0]]);
    const tick = h("input", { type: "checkbox", class: "prompt-switch" }) as HTMLInputElement;
    tick.checked = on;
    tick.addEventListener("change", () => { on = tick.checked; says.textContent = req.toggle!.says[on ? 1 : 0]; });
    el.append(h("label", { class: "prompt-toggle" }, [tick, req.toggle.label]), says);
  }
  el.append(h("div", { class: "prompt-footer" }, [h("span", { class: "prompt-hint" }, [localize("Enter confirms, Esc cancels")]), ok]));
  if (handlers.typed) ask();
  queueMicrotask(() => box.select());
  return box;
}

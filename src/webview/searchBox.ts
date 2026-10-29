import "./search.css";
import { localize } from "../i18n";
import { DEFAULT_FILTER, type FilterState } from "../filterModel";
import type { AuthorName, BranchName } from "../protocol";
import { completionAt, OPERATORS, operatorsFor, parseSearch, planSearch, quoteValue, runnable, withoutWip, type OperatorInfo, type SearchError } from "../searchQuery";
import { byId, clear, h } from "./dom";
import { SuggestBox } from "./suggest";
import { matchSuggestions, type Suggestion, type SuggestionList, type SuggestionMatch } from "./suggestModel";

/** The most recent searches ↑/↓ walk through. */
export const HISTORY_LIMIT = 50;
/** Errors wait for a pause in typing (or Enter), so a value being typed does not flash red. */
const ERROR_DELAY_MS = 600;
/** The suggestions: at least this wide, at most this tall (they scroll inside). */
const SUGGEST_MIN_WIDTH = 560;
const SUGGEST_MAX_HEIGHT = 360;

const TOGGLES = { matchCase: "match-case", wholeWord: "whole-word", regex: "use-regex", matchAll: "match-all" } as const;
type Toggle = keyof typeof TOGGLES;
export type ValueKind = "authors" | "branches" | "tags";

/** What the search box asks of the Log. */
export interface SearchBoxHost {
  /** A query or a toggle to apply; now: Enter, without the host's typing debounce. */
  change(patch: Partial<FilterState>, now: boolean): void;
  /** Values for author:, committer: and ref:, read when first needed. */
  want(kind: ValueKind): void;
  /** type:wip: the Log's Uncommitted side. */
  wip(): void;
  /** ✨ mode: plain words for Linyra AI to turn into a query. */
  ai(text: string): void;
  configureAi(): void;
  history: { load(): unknown; save(list: readonly string[]): void };
}

const nowSec = () => Math.floor(Date.now() / 1000);
/** The query as git sees it: two texts that differ only in spacing run the same search. */
const canonical = (text: string) => parseSearch(text).ranges.map((t) => t.spelling + t.raw).join(" ");

/**
 * The Log's search box: words and GitLens-style operators, a suggestions list for both, the
 * last searches on ↑/↓, errors under the box, and a ✨ mode that asks Linyra AI for the query.
 * It only reports intent: the host turns the query into git flags (searchQuery.ts).
 */
export class SearchBox {
  private readonly input = byId<HTMLInputElement>("search");
  private readonly field = byId("search-field");
  private readonly message = byId("search-errors");
  private readonly aiButton = byId<HTMLButtonElement>("search-ai");
  private readonly toggles = Object.fromEntries(Object.entries(TOGGLES).map(([key, id]) => [key, byId<HTMLButtonElement>(id)])) as Record<Toggle, HTMLButtonElement>;
  private readonly suggest: SuggestBox;
  private filter: FilterState = DEFAULT_FILTER;
  /** The query last sent or received: what is typed stays in the box until it can run. */
  private sent = "";
  private authors: readonly AuthorName[] = [];
  private branches: readonly BranchName[] = [];
  private tags: readonly BranchName[] = [];
  private repoNames: readonly string[] = [];
  private readonly asked = new Set<ValueKind>();
  /**
   * The suggestions, made once and kept while what they show holds, so the list builds each row
   * once and typing only filters them: operators for good, values until the host sends new ones.
   */
  private readonly operatorItems = new Map<OperatorInfo, Suggestion>();
  private readonly valueItems = new Map<string, Suggestion[]>();
  private aiSuggestion: Suggestion | undefined;
  private natural = false;
  private aiAvailable = false;
  /** The ✨ request waiting for its answer. */
  private asking: string | null = null;
  private history: string[];
  /** ↑/↓: the history entry shown, or -1 for what was typed (kept in `draft`). */
  private recall = -1;
  private draft = "";
  /** Enter on an operator without its value: say so. */
  private explain = false;
  private errorTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly host: SearchBoxHost) {
    const saved = host.history.load();
    this.history = Array.isArray(saved) ? saved.filter((x): x is string => typeof x === "string" && x.trim() !== "").slice(0, HISTORY_LIMIT) : [];
    // Before the list's own keys: Enter runs and ↑/↓ recall searches, unless the list has a row highlighted.
    this.input.addEventListener("keydown", (e) => this.onKey(e), true);
    // Before the list's own: the text is checked first, so the list knows whether an error shows.
    this.input.addEventListener("input", () => {
      this.recall = -1;
      this.explain = false;
      this.edited();
    });
    this.suggest = new SuggestBox(this.input, this.field, { matches: (force) => this.matches(force), pick: (item) => this.pick(item) }, { minWidth: SUGGEST_MIN_WIDTH, maxHeight: SUGGEST_MAX_HEIGHT });
    this.input.addEventListener("focus", () => this.suggest.show());
    this.input.addEventListener("click", () => this.suggest.show());
    this.input.addEventListener("keyup", (e) => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) this.suggest.show(); });
    // A search typed and left is worth recalling too, not only one run with Enter.
    this.input.addEventListener("blur", () => { if (this.input.value === this.sent) this.remember(this.sent); this.showErrors(true); });
    for (const [key, button] of Object.entries(this.toggles) as [Toggle, HTMLButtonElement][]) button.addEventListener("click", () => this.toggle(key));
    this.aiButton.addEventListener("click", () => this.toggleNatural());
    this.setAiAvailable(false);
  }

  /** The filter changed (here, in the host, or in another box). */
  update(filter: FilterState): void {
    this.filter = filter;
    for (const [key, button] of Object.entries(this.toggles) as [Toggle, HTMLButtonElement][]) button.setAttribute("aria-pressed", String(filter[key] === true));
    // Someone else changed the query (Escape, Linyra AI, a restored filter): show it. Otherwise
    // keep what is typed, which may not run yet.
    if (filter.text !== this.sent) {
      this.sent = filter.text;
      this.input.value = filter.text;
      this.recall = -1;
    }
    this.showErrors(true);
  }

  setAuthors(items: readonly AuthorName[]): void { this.authors = items; this.forget("author:", "committer:"); this.suggest.refresh(); }
  setBranches(items: readonly BranchName[]): void { this.branches = items; this.forget("ref:"); this.suggest.refresh(); }
  setTags(items: readonly BranchName[]): void { this.tags = items; this.forget("ref:"); this.suggest.refresh(); }
  setRepos(names: readonly string[]): void { this.repoNames = names; this.forget("repo:"); }

  /** Whether linyra.ai.translateSearch is there and Linyra AI is set up. */
  setAiAvailable(available: boolean): void {
    this.aiAvailable = available;
    this.aiButton.setAttribute("aria-disabled", String(!available));
    const title = available ? localize("Search in natural language with Linyra AI") : localize("Natural-language search needs Linyra AI. Click to set it up.");
    this.aiButton.title = title;
    this.aiButton.setAttribute("aria-label", title);
    if (!available && this.natural) this.setNatural(false);
  }

  /** Linyra AI's answer to the ✨ request: the query goes in the box and runs. */
  aiResult(m: { text: string; query?: string; error?: string }): void {
    if (m.text !== this.asking) return; // superseded
    this.asking = null;
    this.field.classList.remove("asking");
    if (m.error !== undefined || m.query === undefined) return this.showMessages([m.error ?? localize("Linyra AI did not return a search.")], "error");
    this.setNatural(false);
    this.input.value = m.query;
    this.recall = -1;
    this.edited(true);
    this.remember(m.query);
  }

  private onKey(e: KeyboardEvent): void {
    const consume = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    if (e.key === "Enter") {
      if (this.suggest.hasActive) return; // the list picks
      consume();
      this.suggest.close();
      if (this.natural) return this.askAi();
      this.explain = true;
      if (this.edited(true)) this.remember(this.input.value);
      return;
    }
    if (e.key === "Escape" && !this.suggest.isOpen && this.input.value !== "") {
      consume();
      this.input.value = "";
      this.recall = -1;
      this.edited();
      return;
    }
    const end = this.input.value.length;
    const atEnd = this.input.selectionStart === end && this.input.selectionEnd === end;
    // ↑ walks back through the searches unless a list row is highlighted; ↓ comes forward again.
    if (e.key === "ArrowUp" && atEnd && !this.suggest.hasActive && this.recall < this.history.length - 1) {
      consume();
      if (this.recall < 0) this.draft = this.input.value;
      this.recallTo(this.recall + 1);
    } else if (e.key === "ArrowDown" && atEnd && this.recall >= 0 && !this.suggest.isOpen) {
      consume();
      this.recallTo(this.recall - 1);
    }
  }

  private recallTo(i: number): void {
    this.recall = i;
    this.suggest.close();
    this.input.value = i < 0 ? this.draft : this.history[i];
    this.input.setSelectionRange(this.input.value.length, this.input.value.length);
    this.explain = false;
    this.edited();
  }

  /**
   * The box's text changed: send it when it can run (an operator still waiting for its value, or
   * an invalid one, is not sent). now: Enter, sent even when unchanged. True when it ran.
   */
  private edited(now = false): boolean {
    if (this.natural) {
      this.showMessages([]);
      return false;
    }
    let text = this.input.value;
    const plan = this.plan(text);
    this.showErrors(now);
    if (!runnable(plan)) return false;
    if (plan.wip) {
      // type:wip is the Uncommitted side; the rest of the query still filters the commits.
      this.host.wip();
      text = withoutWip(text);
      this.input.value = text;
    }
    // Spacing alone changes nothing git is asked; the box keeps it until the next real change.
    if (now || canonical(text) !== canonical(this.sent)) {
      this.sent = text;
      this.host.change({ text }, now);
    }
    return true;
  }

  /** Errors under the box: at once on request (Enter, a toggle), otherwise after a pause in typing. */
  private showErrors(now: boolean): void {
    clearTimeout(this.errorTimer);
    const render = () => {
      if (this.natural) return this.showMessages([]);
      const text = this.input.value;
      const plan = this.plan(text);
      const waiting: SearchError[] = this.explain ? plan.pending.map((t) => ({ message: localize("{0} needs a value", t.spelling), start: t.start, end: t.end })) : [];
      const problems = [...plan.errors, ...waiting].map((x) => x.message);
      // change: makes git read every commit's diff: over all of history that can take many seconds.
      if (problems.length === 0 && plan.change !== undefined && this.filter.date === "all" && plan.since === undefined) {
        return this.showMessages([localize("change: reads the changes of every commit in the range. Over all time this can take a while: a shorter date range is faster.")], "info");
      }
      this.showMessages(problems);
    };
    const plan = this.plan(this.input.value);
    // Clearing is never delayed: a fixed query loses its red at once.
    if (now || (plan.errors.length === 0 && !this.explain)) render();
    else this.errorTimer = setTimeout(render, ERROR_DELAY_MS);
  }

  private showMessages(messages: readonly string[], kind: "error" | "info" = "error"): void {
    clear(this.message);
    for (const m of messages.slice(0, 3)) this.message.append(h("span", { class: "search-message" }, [m]));
    this.message.hidden = messages.length === 0;
    this.message.classList.toggle("info", kind === "info");
    // The message, not the list, is what the box needs read now (the list would cover it).
    if (messages.length > 0) this.suggest.close();
    const invalid = kind === "error" && messages.length > 0;
    if (invalid) this.input.setAttribute("aria-invalid", "true");
    else this.input.removeAttribute("aria-invalid");
    this.input.title = invalid ? messages.join("\n") : localize("Words search messages; a hash finds a commit; operators such as author:, file: or ref: narrow the search. ↑↓ for recent searches.");
  }

  /** The query with the toggles and the Path box, checked against the repositories' names once known. */
  private plan(text: string, filter: FilterState = this.filter) {
    return planSearch({ ...filter, text }, nowSec(), { repoNames: this.repoNames.length ? this.repoNames : undefined });
  }

  private toggle(key: Toggle): void {
    const patch: Partial<FilterState> = { [key]: !this.filter[key] || undefined };
    // What is typed may run now (an expression error gone with Regex off): send it with the toggle.
    const text = this.input.value;
    if (!this.natural && text !== this.sent && runnable(this.plan(text, { ...this.filter, ...patch }))) {
      patch.text = text;
      this.sent = text;
    }
    this.host.change(patch, false);
  }

  private toggleNatural(): void {
    if (!this.aiAvailable) return this.host.configureAi();
    this.setNatural(!this.natural);
    this.input.focus();
  }

  private setNatural(on: boolean): void {
    this.natural = on;
    this.aiButton.setAttribute("aria-pressed", String(on));
    this.field.classList.toggle("natural", on);
    this.input.placeholder = on ? localize("Describe the commits, e.g. my fixes in acme-web last week") : localize("Search commits (↑↓ for history)");
    this.suggest.close();
    if (on) this.showMessages([]);
    else this.showErrors(true);
  }

  private askAi(): void {
    const text = this.input.value.trim();
    if (!text) return;
    this.asking = text;
    this.field.classList.add("asking");
    this.showMessages([localize("Asking Linyra AI for the search…")], "info");
    this.remember(text);
    this.host.ai(text);
  }

  private remember(text: string): void {
    const q = text.trim();
    if (!q) return;
    if (this.history[0] === q) return;
    this.history = [q, ...this.history.filter((x) => x !== q)].slice(0, HISTORY_LIMIT);
    this.host.history.save(this.history);
  }

  /**
   * The suggestions at the caret: operators being typed, under a line on combining them; or the
   * values of the one there, under its examples (shown alone when it has no values to offer).
   */
  private matches(force: boolean): SuggestionList {
    // A message under the box comes first: the list would cover it, as GitLens hides its own.
    if (this.natural || !this.message.hidden) return { items: [] };
    const text = this.input.value;
    const at = completionAt(text, this.input.selectionStart ?? text.length);
    if (!at) return { items: [] };
    if (at.kind === "value") {
      const example = OPERATORS.find((o) => o.operator === at.operator)?.example();
      return { items: matchSuggestions(this.values(at.operator), at.prefix, 12), hint: example };
    }
    // In a box that already holds a search, a new word is just a word unless the list is asked for.
    if (at.prefix === "" && text.trim() !== "" && !force) return { items: [] };
    const p = at.prefix.toLowerCase();
    const items = operatorsFor(at.prefix).map((o): SuggestionMatch => {
      const item = this.operatorItem(o);
      if (!p || o.operator.startsWith(p)) return { item, label: p ? [0, p.length] : null };
      // An alias typed (@, #, ^): its letters lit in the aliases at the right.
      const alias = o.aliases.find((a) => a.startsWith(p)) ?? "";
      const i = (item.aside ?? "").indexOf(alias);
      return { item, label: null, aside: alias && i >= 0 ? [i, i + p.length] : undefined };
    });
    if (items.length === 0) return { items };
    // The whole list starts with ✨ when Linyra AI can write the search.
    if (p === "" && this.aiAvailable) items.unshift({ item: this.aiItem(), label: null });
    return { items, hint: { text: localize("Combine filters to build powerful searches, e.g. {0}"), code: ["@me after:1.week.ago file:*.ts"] } };
  }

  /** An operator as the list shows it: icon, the operator, its aliases at the right, what it gets you below. */
  private operatorItem(o: OperatorInfo): Suggestion {
    let item = this.operatorItems.get(o);
    if (!item) {
      item = { value: o.operator, label: o.operator, description: o.description(), aside: o.aliases.join(", ") || undefined, icon: o.icon };
      this.operatorItems.set(o, item);
    }
    return item;
  }

  /** The ✨ row: picking it turns natural-language search on, keeping what is typed. */
  private aiItem(): Suggestion {
    this.aiSuggestion ??= {
      value: "",
      label: localize("Search using natural language"),
      description: localize("Describe what you're looking for and let Linyra AI build the query"),
      icon: "sparkle",
    };
    return this.aiSuggestion;
  }

  private values(operator: string): Suggestion[] {
    const want = (kind: ValueKind) => {
      if (this.asked.has(kind)) return;
      this.asked.add(kind);
      this.host.want(kind);
    };
    if (operator === "author:" || operator === "committer:") want("authors");
    if (operator === "ref:") {
      want("branches");
      want("tags");
    }
    // Today's date is a value: the dates are made again on another day.
    const key = operator === "after:" || operator === "before:" ? `date ${isoDay(new Date())}` : operator;
    let items = this.valueItems.get(key);
    if (!items) {
      items = this.makeValues(operator);
      this.valueItems.set(key, items);
    }
    return items;
  }

  /** New values from the host: these operators' suggestions are made again when next listed. */
  private forget(...operators: string[]): void {
    for (const o of operators) this.valueItems.delete(o);
  }

  private makeValues(operator: string): Suggestion[] {
    switch (operator) {
      case "author:":
      case "committer:":
        return [
          { value: "@me", label: "@me", description: localize("You: each repository's user.email"), icon: "person" },
          ...this.authors.map((a): Suggestion => ({ value: a.email, label: a.name, detail: a.email, icon: "person" })),
        ];
      case "ref:":
        return [
          ...this.branches.map((b): Suggestion => ({ value: b.name, label: b.name, description: repoCount(b.count), icon: "git-branch" })),
          ...this.tags.map((t): Suggestion => ({ value: t.name, label: t.name, description: repoCount(t.count), aside: localize("tag"), icon: "tag" })),
        ];
      case "repo:":
        return this.repoNames.map((name): Suggestion => ({ value: name, label: name, icon: "repo" }));
      case "type:":
        return [
          { value: "tip", label: "tip", description: localize("Commits a branch or tag points at"), icon: "git-branch" },
          { value: "merge", label: "merge", description: localize("Merge commits"), icon: "git-merge" },
          { value: "wip", label: "wip", description: localize("Uncommitted changes, on the Uncommitted side"), icon: "edit" },
        ];
      case "after:":
      case "before:":
        return ["today", "yesterday", "1.week.ago", "1.month.ago", "1.year.ago", isoDay(new Date())].map((v): Suggestion => ({ value: v, label: v, icon: "calendar" }));
      default:
        return [];
    }
  }

  private pick(item: Suggestion): void {
    if (item === this.aiSuggestion) return this.toggleNatural();
    const text = this.input.value;
    const at = completionAt(text, this.input.selectionStart ?? text.length);
    if (!at) return;
    const insert = at.kind === "operator" ? item.value : quoteValue(item.value);
    const tail = text.slice(at.end);
    // A value ends its token: a space follows, so the next word can start.
    const space = at.kind === "value" && !tail.startsWith(" ") ? " " : "";
    this.input.value = text.slice(0, at.start) + insert + space + tail;
    const caret = at.start + insert.length + space.length;
    this.input.setSelectionRange(caret, caret);
    this.recall = -1;
    this.edited();
    // An operator with values to offer: list them now.
    if (at.kind === "operator") this.suggest.show(true);
  }
}

function repoCount(n: number): string {
  return localize(n === 1 ? "{0} repository" : "{0} repositories", n);
}

function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

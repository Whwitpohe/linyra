// Dev-only: the search box's query on the harness's mock commits, read by the product's own parser
// (src/searchQuery.ts). Filtering in JavaScript is fine here: this is a harness, not the product.
// Neutral names only (CLAUDE.md constraint 3).
import type { FilterState } from "../../../src/filterModel";
import type { HostMessage, WebviewMessage } from "../../../src/protocol";
import { parseSearch, planSearch, runnable, searchRepos, searchSkips } from "../../../src/searchQuery";
import type { Commit, Repo } from "../../../src/types";

const ME = "dana@example.com";
const FILES = ["src/upload/uploader.ts", "src/client.ts", "api/handler.go", "docs/README.md", "package.json", "ui/Button.tsx"];
/** The file a mock commit touched: one of a few, by its hash. */
const fileOf = (c: Commit) => FILES[parseInt(c.sha.slice(0, 6), 16) % FILES.length];

/** The branches and tags each mock repository has: ref: lists only the repositories that have it. */
const REFS: Record<string, string[]> = {
  "acme-web": ["main", "origin/main", "origin/release-1.4", "v1.4.0"],
  "acme-api": ["main", "origin/main", "v1.4.0"],
  "acme-libs": ["main", "origin/main"],
};
const TAGS = [{ name: "v1.4.0", count: 2 }, { name: "v1.3.2", count: 1 }];

/** A file: wildcard, roughly: * crosses folders, as in a pathspec without glob magic. */
const wildcard = (pattern: string) => new RegExp(`(^|/)${pattern.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");

/** A filter for the mock commits that follows the query; undefined: the query does not run (nothing matches). */
export function searchPredicate(f: FilterState, repos: readonly Repo[], now: number): ((c: Commit) => boolean) | undefined {
  const plan = planSearch(f, now);
  if (!runnable(plan)) return undefined;
  const names = new Map(repos.map((r) => [r.id, r.name]));
  const scoped = new Set(searchRepos(plan, repos).map((r) => r.id));
  const files = parseSearch(f.text).ranges.filter((t) => t.operator === "file:" && t.value);
  const icase = (s: string) => (f.matchCase ? s : s.toLowerCase());
  const has = (hay: string, needle: string) => (f.regex ? new RegExp(needle, f.matchCase ? "" : "i").test(hay) : icase(hay).includes(icase(needle)));
  return (c) => {
    if (!scoped.has(c.repoId) || searchSkips(plan, ME)) return false;
    if (plan.hashes.length) return plan.hashes.some((h) => c.sha.startsWith(h));
    const words = plan.messages.map((m) => has(c.subject, m));
    if (words.length && !(f.matchAll ? words.every(Boolean) : words.some(Boolean))) return false;
    if (plan.excluded.some((m) => has(c.subject, m))) return false;
    const line = `${c.author} <${c.email}>`;
    const authors = plan.authors.map((a) => (a === "@me" ? ME : a));
    // The Author box is the shim's own check: both hold.
    if (authors.length && !authors.some((a) => has(line, a))) return false;
    if (plan.committers.length && !plan.committers.some((a) => has(line, a === "@me" ? ME : a))) return false;
    if (plan.change !== undefined && !has(c.subject, plan.change)) return false;
    if (plan.merges && c.parents.length < 2) return false;
    if (plan.tips && !c.refs?.length) return false;
    if (plan.since !== undefined && c.time < plan.since) return false;
    if (plan.until !== undefined && c.time > plan.until) return false;
    if (plan.refs.length && !plan.refs.some((r) => (REFS[names.get(c.repoId) ?? ""] ?? []).includes(r.split("..").pop() || "main"))) return false;
    const file = fileOf(c);
    if (files.length && !files.some((t) => (t.quoted ? file === t.value || file.startsWith(`${t.value}/`) : t.value.includes("*") ? wildcard(t.value).test(file) : icase(file).includes(icase(t.value))))) return false;
    return true;
  };
}

/**
 * The search box's own messages: tags for ref:, and a stand-in for Linyra AI (?ai=off: not set
 * up). true when handled.
 */
export function handleSearch(m: WebviewMessage, send: (m: HostMessage, delay?: number) => void, ai: boolean): boolean {
  switch (m.type) {
    case "ready":
      send({ type: "aiSearchAvailable", available: ai }, 0);
      return false;
    case "wantSuggestions":
      if (m.kind === "tags") send({ type: "suggestions", tags: TAGS });
      return true;
    case "aiConfigure":
      console.info("[harness] aiConfigure");
      return true;
    case "aiSearch":
      send({ type: "aiSearchResult", text: m.text, query: translate(m.text) }, 300);
      return true;
    default:
      return false;
  }
}

/** What Linyra AI might make of a few phrases. */
function translate(text: string): string {
  const t = text.toLowerCase();
  const out: string[] = [];
  if (/\b(my|mine|i)\b/.test(t)) out.push("@me");
  for (const name of Object.keys(REFS)) if (t.includes(name)) out.push(`repo:${name}`);
  if (t.includes("last week")) out.push("after:1.week.ago");
  if (t.includes("yesterday")) out.push("after:yesterday");
  if (/\bfix(es)?\b/.test(t)) out.push("fix");
  if (/\bmerges?\b/.test(t)) out.push("type:merge");
  return out.join(" ") || text;
}

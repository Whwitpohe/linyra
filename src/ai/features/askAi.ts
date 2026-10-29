// Ask AI: a request in plain words → the model calls Linyra's tools (tools.ts). Read tools run as
// they come; write tools are only planned, and come back for one confirmation once the model is
// done. At most MAX_TOOL_CALLS calls per request. Pure: the loop over an injected AiService.
import type { AiResponse, AiService, AiToolCall, AiToolResult, AiTurn } from "../types";
import { languageLine } from "./context";
import { MAX_TOOL_CALLS, TOOLS, toolDef, type WritePlan } from "./tools";

export const ASK_SYSTEM = `You are the assistant inside Linyra, a VS Code extension that shows one merged git log of several repositories, with each repository's branches, uncommitted changes, and actions across repositories (fetch, pull, push, checkout, new branch, merge, stash, compare branches).
You act only through the tools. Repositories are named as list_repositories names them.

Rules:
- Read tools (list_*, search_log, show_*, select_commit, open_file_history, compare_branches, explain_*, review_changes, generate_commit_message) run at once.
- Write tools (fetch_all, pull, push, checkout_branch, create_branch, merge_branch, stash_changes) do NOT run when you call them: each is planned and shown to the user, who confirms all of them together after your answer. Call each write you need once; never call one again to check it. Do not claim a write has happened.
- Use at most ${MAX_TOOL_CALLS} tool calls. Use the fewest that do the job; do not call tools the request does not need.
- Search with search_log rather than reading commits one by one. Its syntax: message:, author:, author:@me, committer:, commit:, file:, change:, type:merge, after:, before:, ref:, repo:.
- If the request is unclear or impossible with these tools, say so in one sentence instead of guessing.
- Finish with a short answer (one to three sentences, no headings) saying what you did and what waits for the user's confirmation.`;

/** What the loop asks of Linyra: run a read tool, or plan a write one (nothing runs). Errors go back to the model. */
export interface AskHost {
  read(name: string, input: unknown, signal: AbortSignal): Promise<string>;
  plan(name: string, input: unknown, signal: AbortSignal): Promise<{ plan: WritePlan; run: () => Promise<string> } | { error: string }>;
}

export interface AskResult {
  answer: string;
  /** The writes the model asked for, in order: shown in one confirmation, run only if the user agrees. */
  planned: { call: AiToolCall; plan: WritePlan; run: () => Promise<string> }[];
  calls: AiToolCall[];
  /** The model wanted more than MAX_TOOL_CALLS calls. */
  limited: boolean;
  stop: AiResponse["stop"];
}

export interface AskOptions {
  /** The workspace in a few lines (repositories, today): saves the model a tool call. */
  context: string;
  language: string;
  signal: AbortSignal;
  onText?: (delta: string) => void;
  /** Each tool call as it starts (the progress notification names it). */
  onCall?: (call: AiToolCall, kind: "read" | "write" | "unknown") => void;
  maxCalls?: number;
}

const PLANNED = "Planned, not run: the user is asked to confirm it once you have answered. Do not call it again.";
const LIMIT = `Not run: the limit of ${MAX_TOOL_CALLS} tool calls for one request is reached. Answer with what you have.`;
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runAsk(ai: Pick<AiService, "ask">, host: AskHost, question: string, o: AskOptions): Promise<AskResult> {
  const max = o.maxCalls ?? MAX_TOOL_CALLS;
  const turns: AiTurn[] = [{ role: "user", content: `${o.context}\n${languageLine(o.language)}\n\nRequest: ${question.trim()}` }];
  const result: AskResult = { answer: "", planned: [], calls: [], limited: false, stop: "end" };
  // One round per batch of calls; two more after the limit is reached, for the answer.
  for (let round = 0; round < max + 2; round++) {
    const res = await ai.ask({ system: ASK_SYSTEM, turns, tools: TOOLS.map((t) => t.tool), signal: o.signal, onText: o.onText });
    result.stop = res.stop;
    result.answer = res.text.trim();
    if (res.stop !== "tool" || res.toolCalls.length === 0) return result;
    turns.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls, ...(res.raw !== undefined ? { raw: res.raw } : {}) });
    const results: AiToolResult[] = [];
    for (const call of res.toolCalls) {
      if (o.signal.aborted) throw o.signal.reason ?? new Error("cancelled");
      if (result.calls.length >= max) {
        result.limited = true;
        results.push({ id: call.id, name: call.name, output: LIMIT, isError: true });
        continue;
      }
      result.calls.push(call);
      const def = toolDef(call.name);
      o.onCall?.(call, def?.kind ?? "unknown");
      if (!def) { results.push({ id: call.id, name: call.name, output: `No tool named ${call.name}.`, isError: true }); continue; }
      try {
        if (def.kind === "read") {
          results.push({ id: call.id, name: call.name, output: await host.read(call.name, call.input, o.signal) });
        } else {
          const p = await host.plan(call.name, call.input, o.signal);
          if ("error" in p) results.push({ id: call.id, name: call.name, output: p.error, isError: true });
          else {
            result.planned.push({ call, plan: p.plan, run: p.run });
            results.push({ id: call.id, name: call.name, output: `${PLANNED}\n${planText(p.plan)}` });
          }
        }
      } catch (e) {
        if (o.signal.aborted) throw e;
        results.push({ id: call.id, name: call.name, output: `Failed: ${messageOf(e)}`, isError: true });
      }
    }
    turns.push({ role: "tool", results });
  }
  // Still calling tools after the limit: what it said last is the answer.
  result.limited = true;
  return result;
}

/** A plan as the model reads it back. */
export function planText(p: WritePlan): string {
  return [`${p.title}:`, ...p.rows.map((r) => `- ${r.repo}: ${r.action}`), ...p.skipped.map((s) => `- ${s.repo}: skipped (${s.why})`)].join("\n");
}

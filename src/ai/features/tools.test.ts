import * as assert from "assert";
import type { Branches } from "../../branchModel";
import { configureI18n } from "../../i18n";
import { runAsk, type AskHost } from "./askAi";
import { fakeAi } from "./fakeAi";
import { branchName, confirmation, field, MAX_TOOL_CALLS, planAcross, planFetch, planPull, planPush, planStash, resolveRepos, TOOLS, toolDef, type WritePlan } from "./tools";

configureI18n("en");
const web = { id: "/w/acme-web", name: "acme-web" }, api = { id: "/w/acme-api", name: "acme-api" }, libs = { id: "/w/acme-libs", name: "acme-libs" };
const branch = (name: string, kind: "local" | "remote", current = false) => ({ ref: kind === "local" ? `refs/heads/${name}` : `refs/remotes/${name}`, name, kind, sha: "a".repeat(40), current, ahead: 0, behind: 0,
  ...(kind === "remote" ? { remote: name.split("/")[0], remoteBranch: name.split("/").slice(1).join("/") } : {}) });

{
  const names = TOOLS.map((t) => t.tool.name);
  assert.strictEqual(new Set(names).size, names.length, "tool names are unique");
  for (const t of TOOLS) {
    assert.ok(/^[a-z_]+$/.test(t.tool.name) && t.tool.name.length <= 64, t.tool.name);
    assert.strictEqual(t.tool.parameters.type, "object");
    assert.strictEqual(t.tool.parameters.additionalProperties, false);
    for (const r of t.tool.parameters.required ?? []) assert.ok(r in t.tool.parameters.properties, `${t.tool.name}: required ${r} is a property`);
    assert.ok(t.tool.description.length > 20 && t.tool.description.length < 400);
  }
  assert.deepStrictEqual(TOOLS.filter((t) => t.kind === "write").map((t) => t.tool.name), ["fetch_all", "pull", "push", "checkout_branch", "create_branch", "merge_branch", "stash_changes"]);
  assert.strictEqual(toolDef("search_log")?.kind, "read");
  assert.strictEqual(toolDef("rm_rf"), undefined);
  console.log("ok - tool table: unique names, closed JSON Schemas, every write tool marked write");
}

{
  assert.deepStrictEqual(resolveRepos(undefined, [web, api, libs], [web, api]), { repos: [web, api], unknown: [] });
  assert.deepStrictEqual(resolveRepos(["ACME-LIBS", "acme-web", "acme-web", "acme-mobile", 3], [web, api, libs], []), { repos: [libs, web], unknown: ["acme-mobile"] });
  assert.deepStrictEqual(field({ repo: " acme-web " }, "repo"), "acme-web");
  assert.deepStrictEqual(field({}, "repo"), { error: 'Missing "repo".' });
  assert.strictEqual(branchName({ branch: "refs/heads/release-1.4" }), "release-1.4");
  assert.deepStrictEqual(branchName({ branch: "--force" }), { error: '"--force" is not a valid branch name.' });
  console.log("ok - inputs: repository names matched without case, unknown ones reported, branch names checked against git's rules");
}

{
  const data = (current: string, ...branches: ReturnType<typeof branch>[]): Branches => ({ branches, remotes: ["origin"], current });
  const repos = [
    { repo: web, data: data("main", branch("main", "local", true), branch("release-1.4", "local")) },
    { repo: api, data: data("main", branch("main", "local", true), branch("origin/release-1.4", "remote")) },
    { repo: libs, data: data("release-1.4", branch("release-1.4", "local", true)) },
    { repo: { id: "/w/acme-docs", name: "acme-docs" }, data: data("main", branch("main", "local", true)) },
    { repo: { id: "/w/acme-x", name: "acme-x" }, data: undefined },
  ];
  const checkout = planAcross("checkout", "release-1.4", repos);
  assert.deepStrictEqual(checkout.rows, [{ repo: "acme-web", action: "git switch release-1.4" }, { repo: "acme-api", action: "git switch --track origin/release-1.4" }]);
  assert.deepStrictEqual(checkout.skipped.map((s) => `${s.repo}: ${s.why}`), ["acme-libs: already on it", "acme-docs: no such branch", "acme-x: its branches could not be read"]);
  const create = planAcross("create", "release-1.4", repos.slice(0, 2));
  assert.deepStrictEqual(create.rows, [{ repo: "acme-api", action: "git switch -c release-1.4 (from main)" }]);
  assert.deepStrictEqual(create.skipped, [{ repo: "acme-web", why: "the branch already exists" }]);
  const merge = planAcross("merge", "release-1.4", repos.slice(0, 3));
  assert.deepStrictEqual(merge.rows, [{ repo: "acme-web", action: "git merge release-1.4 (into main)" }, { repo: "acme-api", action: "git merge origin/release-1.4 (into main)" }]);
  assert.deepStrictEqual(merge.skipped, [{ repo: "acme-libs", why: "it is the current branch" }]);
  const sync = new Map([[web.id, { ahead: 2, behind: 3 }], [api.id, { ahead: 0, behind: 0 }]]);
  assert.deepStrictEqual(planPull([web, api, libs], sync).rows, [{ repo: "acme-web", action: "pull 3 incoming commits" }]);
  assert.deepStrictEqual(planPull([web, api, libs], sync).skipped.map((s) => s.why), ["up to date", "no upstream branch"]);
  assert.deepStrictEqual(planPush([web, api, libs], sync).rows.map((r) => r.action), ["offer 2 commits in Push…", "offer in Push… (no upstream yet)"]);
  assert.deepStrictEqual(planFetch([web]).rows, [{ repo: "acme-web", action: "git fetch" }]);
  assert.deepStrictEqual(planStash(api, "WIP: upload", true, 3).rows, [{ repo: "acme-api", action: 'git stash push --include-untracked -m "WIP: upload"' }]);
  assert.strictEqual(planStash(api, "x", false, 0).rows.length, 0);

  const c = confirmation([checkout, planPull([web, api, libs], sync), planStash(api, "x", false, 0)])!;
  assert.strictEqual(c.message, "Run 2 actions in 2 repositories?");
  assert.strictEqual(c.button, "Run");
  assert.ok(c.detail.startsWith("1. Check out release-1.4\n   acme-web: git switch release-1.4\n   acme-api: git switch --track origin/release-1.4\n   Left as they are: acme-libs (already on it), acme-docs (no such branch), acme-x (its branches could not be read)"));
  assert.ok(c.detail.includes("2. Pull\n   acme-web: pull 3 incoming commits") && c.detail.includes("3. Stash Changes\n   Left as they are: acme-api (no uncommitted changes)"));
  assert.ok(c.detail.endsWith("Asked by AI. Nothing runs until you choose Run."));
  assert.strictEqual(confirmation([planFetch([web])])!.message, "Run Fetch All in acme-web?");
  assert.strictEqual(confirmation([planFetch([web, api])])!.message, "Run Fetch All in 2 repositories?");
  assert.strictEqual(confirmation([planStash(api, "x", false, 0)]), undefined, "nothing would run: no confirmation");
  console.log("ok - write plans: each repository's step as Branches Across Repositories decides it, one confirmation listing all");
}

(async () => {
{
  // A read runs at once and its output goes back; a write is only planned; the answer comes last.
  const ai = fakeAi([
    { text: "Looking.", stop: "tool", toolCalls: [{ id: "1", name: "search_log", input: { query: "author:dana" } }, { id: "2", name: "checkout_branch", input: { branch: "release-1.4" } }], raw: { blocks: 1 } },
    { text: "Found 2 commits by dana; checking out release-1.4 waits for you.", stop: "end" },
  ]);
  const ran: string[] = [];
  const plan: WritePlan = { tool: "checkout_branch", title: "Check out release-1.4", rows: [{ repo: "acme-web", action: "git switch release-1.4" }], skipped: [] };
  const host: AskHost = {
    read: async (name, input) => { ran.push(`${name} ${JSON.stringify(input)}`); return "2 commits"; },
    plan: async () => ({ plan, run: async () => { ran.push("checkout"); return "done"; } }),
  };
  const calls: string[] = [];
  const r = await runAsk(ai, host, "dana's work, then release-1.4", { context: "Repositories: acme-web", language: "en", signal: new AbortController().signal, onCall: (c, kind) => calls.push(`${c.name}:${kind}`) });
  assert.deepStrictEqual(ran, ['search_log {"query":"author:dana"}'], "the write did not run");
  assert.deepStrictEqual(calls, ["search_log:read", "checkout_branch:write"]);
  assert.strictEqual(r.answer, "Found 2 commits by dana; checking out release-1.4 waits for you.");
  assert.deepStrictEqual(r.planned.map((p) => p.plan), [plan]);
  assert.strictEqual(ai.requests.length, 2);
  assert.ok(ai.requests[0].tools?.some((t) => t.name === "merge_branch"));
  const second = ai.requests[1].turns;
  assert.deepStrictEqual(second[1], { role: "assistant", content: "Looking.", toolCalls: ai.requests[1].turns[1].role === "assistant" ? (ai.requests[1].turns[1] as { toolCalls: unknown }).toolCalls : [], raw: { blocks: 1 } }, "the assistant turn goes back with its raw blocks");
  const results = second[2].role === "tool" ? second[2].results : [];
  assert.deepStrictEqual(results.map((x) => [x.name, x.output.split("\n")[0], !!x.isError]), [["search_log", "2 commits", false], ["checkout_branch", "Planned, not run: the user is asked to confirm it once you have answered. Do not call it again.", false]]);
  await r.planned[0].run();
  assert.deepStrictEqual(ran.at(-1), "checkout");
  console.log("ok - Ask AI: reads run and answer back, writes are only planned, raw assistant turns echoed");
}

{
  // Errors go back to the model; at most MAX_TOOL_CALLS calls run, then it must answer.
  const many = Array.from({ length: MAX_TOOL_CALLS + 3 }, (_, i) => ({ id: String(i), name: i === 0 ? "no_such_tool" : "list_repositories", input: {} }));
  const ai = fakeAi([{ text: "", stop: "tool", toolCalls: many }, { text: "Partial answer.", stop: "end" }]);
  let reads = 0;
  const host: AskHost = { read: async () => { reads++; if (reads === 2) throw new Error("git failed"); return "ok"; }, plan: async () => ({ error: "x" }) };
  const r = await runAsk(ai, host, "everything", { context: "", language: "en", signal: new AbortController().signal });
  assert.strictEqual(r.calls.length, MAX_TOOL_CALLS);
  assert.strictEqual(reads, MAX_TOOL_CALLS - 1);
  assert.strictEqual(r.limited, true);
  const results = (ai.requests[1].turns[2] as { results: { output: string; isError?: boolean }[] }).results;
  assert.strictEqual(results[0].output, "No tool named no_such_tool.");
  assert.strictEqual(results[2].output, "Failed: git failed");
  assert.ok(results.slice(MAX_TOOL_CALLS).every((x) => x.isError && x.output.startsWith("Not run: the limit of 8")));
  assert.strictEqual(r.answer, "Partial answer.");
  // A model that never stops calling tools ends after a bounded number of rounds.
  const loop = fakeAi(Array.from({ length: 20 }, () => ({ text: "again", stop: "tool" as const, toolCalls: [{ id: "x", name: "list_repositories", input: {} }] })));
  const l = await runAsk(loop, host, "loop", { context: "", language: "en", signal: new AbortController().signal });
  assert.strictEqual(loop.requests.length, MAX_TOOL_CALLS + 2);
  assert.strictEqual(l.limited, true);
  // Cancelled: the loop stops before the next call.
  const ctl = new AbortController();
  const stop = fakeAi([{ stop: "tool", toolCalls: [{ id: "1", name: "list_repositories", input: {} }] }]);
  ctl.abort();
  await assert.rejects(runAsk(stop, host, "x", { context: "", language: "en", signal: ctl.signal }), (e: Error & { kind?: string }) => e.kind === "cancelled");
  // The same write asked twice is planned once.
  const twice = fakeAi([{ stop: "tool", toolCalls: [{ id: "1", name: "fetch_all", input: {} }, { id: "2", name: "fetch_all", input: {} }] }, "Fetching."]);
  let plans = 0;
  const once = await runAsk(twice, { read: async () => "", plan: async () => { plans++; return { plan: { tool: "fetch_all", title: "Fetch All", rows: [], skipped: [] }, run: async () => "" }; } }, "fetch", { context: "", language: "en", signal: new AbortController().signal });
  assert.strictEqual(plans, 1);
  assert.strictEqual(once.planned.length, 1);
  console.log("ok - Ask AI: unknown tools and failures answered as errors, 8 calls at most, bounded rounds, cancellable");
}
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

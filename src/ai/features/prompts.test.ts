import * as assert from "assert";
import { configureI18n } from "../../i18n";
import { cleanCommitMessage, cleanStashMessage, COMMIT_SYSTEM, commitMessageRequest, stashMessageRequest } from "./commitMessage";
import { budgetDiffs, splitPatch } from "./context";
import { EXPLAIN_SYSTEM, explainCommitsRequest, explainRangeRequest, explainWorkRequest } from "./explain";
import { fakeAi } from "./fakeAi";
import { blobArgs, commitPatchArgs, commitsLogArgs, shortPaths, mergeBaseArgs, operationOf, parseCommitPatch, parseNames, parseRangeLog, rangeLogArgs, rangeOk, rangePatchArgs, stageArgs, unmergedArgs, wipPatchArgs } from "./gitText";
import { parseSearchAnswer, SEARCH_SYSTEM, searchRequest } from "./translateSearch";

configureI18n("en");
const signal = new AbortController().signal;
const ai = fakeAi([]);
const diff = (path: string, body: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${body}\n`;

{
  const out = `${"a".repeat(40)}\0dana\0dana@example.com\x001790000000\0feat(api): retry the upload\n\nOnce, with the same token.\n\x1e\n${diff("src/upload.ts", "+retry()")}${diff("yarn.lock", "+x")}`;
  const c = parseCommitPatch(out);
  assert.strictEqual(c.author, "dana");
  assert.strictEqual(c.time, 1790000000);
  assert.strictEqual(c.message, "feat(api): retry the upload\n\nOnce, with the same token.");
  assert.deepStrictEqual(c.files.map((f) => f.path), ["src/upload.ts", "yarn.lock"]);
  assert.deepStrictEqual(commitPatchArgs("abc").slice(-2), ["abc", "--"]);
  assert.ok(commitPatchArgs("abc").includes("--no-ext-diff") && commitPatchArgs("abc").includes("--diff-merges=first-parent"));
  assert.deepStrictEqual(wipPatchArgs(null).slice(-2), ["4b825dc642cb6eb9a060e54bf8d69288fbee4904", "--"]);
  assert.deepStrictEqual(wipPatchArgs("abc", [":odd", "src/a.ts"]).slice(-3), ["--", ":(literal):odd", ":(literal)src/a.ts"]);
  assert.deepStrictEqual(shortPaths(["a", "b"]), ["a", "b"]);
  assert.strictEqual(shortPaths([]), undefined);
  assert.strictEqual(shortPaths(Array.from({ length: 300 }, (_, i) => `f${i}`)), undefined);
  assert.deepStrictEqual(commitsLogArgs(["abc", "def"]).slice(-3), ["abc", "def", "--"]);
  assert.deepStrictEqual(rangeLogArgs("HEAD", "origin/release-1.4", 5), ["log", "--max-count=5", "--no-color", "--format=%h%x00%an%x00%at%x00%s%x00%b%x1e", "HEAD..origin/release-1.4", "--"]);
  assert.deepStrictEqual(rangePatchArgs("@{upstream}", "HEAD").at(-2), "@{upstream}...HEAD");
  assert.ok(rangeOk("@{upstream}", "HEAD") && rangeOk("main", "origin/release-1.4"));
  assert.ok(!rangeOk("--output=x", "HEAD") && !rangeOk("a..b", "HEAD"));
  assert.deepStrictEqual(parseRangeLog("abc1234\0rin\x001790000000\0fix: one\0body line\n\x1e\ndef5678\0dana\x000\0feat: two\0\x1e\n"), [
    { sha: "abc1234", author: "rin", time: 1790000000, subject: "fix: one", body: "body line" },
    { sha: "def5678", author: "dana", time: 0, subject: "feat: two", body: "" },
  ]);
  assert.deepStrictEqual(parseNames("a.ts\0dir/b c.ts\0"), ["a.ts", "dir/b c.ts"]);
  assert.deepStrictEqual(unmergedArgs(), ["diff", "--name-only", "--diff-filter=U", "-z"]);
  assert.deepStrictEqual(stageArgs(2, "src/a.ts"), ["show", ":2:src/a.ts"]);
  assert.deepStrictEqual(blobArgs("abc", "x"), ["show", "abc:x"]);
  assert.deepStrictEqual(mergeBaseArgs("a", "b"), ["merge-base", "a", "b"]);
  assert.strictEqual(operationOf((n) => n === "rebase-merge" || n === "MERGE_HEAD"), "rebase");
  assert.strictEqual(operationOf((n) => n === "CHERRY_PICK_HEAD"), "cherry-pick");
  assert.strictEqual(operationOf(() => false), undefined);
  console.log("ok - git reads: one commit's message and patch, ranges, uncommitted work, conflicts; refs never read as options");
}

{
  const r = searchRequest("  dana's fixes in acme-api last week ", { repos: ["acme-web", "acme-api"], authors: ["dana", "rin"], branches: ["main", "origin/release-1.4"], today: "2026-10-29" }, signal);
  assert.strictEqual(r.system, SEARCH_SYSTEM, "the system text is stable: its prefix is cached");
  assert.strictEqual(r.json, true);
  const user = r.turns[0].role === "user" ? r.turns[0].content : "";
  assert.ok(user.includes("Repositories: acme-web, acme-api") && user.includes("Authors: dana, rin") && user.includes("Today: 2026-10-29"));
  assert.ok(user.endsWith("Question: dana's fixes in acme-api last week"));
  assert.ok(SEARCH_SYSTEM.includes("author:") && SEARCH_SYSTEM.includes("repo:") && SEARCH_SYSTEM.includes("-message:"));
  const many = searchRequest("x", { repos: Array.from({ length: 250 }, (_, i) => `acme-${i}`), authors: [], branches: [], today: "2026-10-29" }, signal);
  assert.ok((many.turns[0] as { content: string }).content.includes("(50 more)") && (many.turns[0] as { content: string }).content.includes("Authors: (none known)"));
  assert.deepStrictEqual(parseSearchAnswer('{"query": "author:dana repo:acme-api after:1.week.ago fix", "note": ""}'), { query: "author:dana repo:acme-api after:1.week.ago fix", note: "" });
  assert.deepStrictEqual(parseSearchAnswer('```json\n{"query": "Author:@me  type:merge\\n", "note": "No date given."}\n```'), { query: "author:@me type:merge", note: "No date given." });
  assert.strictEqual(parseSearchAnswer('{"query": "label:bug author:rin"}')?.query, "bug author:rin", "an operator the box does not know keeps only its value");
  assert.strictEqual(parseSearchAnswer('{"query": "message:\\"fix: retry\\" ?:src/*.ts"}')?.query, 'message:"fix: retry" ?:src/*.ts');
  assert.strictEqual(parseSearchAnswer('{"query": ""}'), undefined);
  assert.strictEqual(parseSearchAnswer("author:dana")?.query, "author:dana", "a plain answer is taken as the query");
  console.log("ok - translateSearch: names as context, stable system text, JSON answer kept to the box's operators");
}

{
  const files = splitPatch(diff("src/a.ts", "+one") + diff("package-lock.json", "+secret-ish"));
  const diffs = budgetDiffs(files, ai.excluded);
  const one = explainCommitsRequest([{ repo: "acme-web", sha: "a".repeat(40), author: "dana", time: 1790000000, message: "fix: one", diffs }], "zh-cn", signal);
  assert.strictEqual(one.system, EXPLAIN_SYSTEM);
  const text = (one.turns[0] as { content: string }).content;
  assert.ok(text.startsWith("Explain this commit."));
  assert.ok(text.includes('"zh-cn"') && text.includes("### acme-web aaaaaaaaaa — dana, 2026-"));
  assert.ok(text.includes("+one") && !text.includes("secret-ish") && text.includes("package-lock.json"));
  const two = explainCommitsRequest([{ repo: "acme-web", sha: "a".repeat(40), author: "dana", time: 0, message: "", diffs }, { repo: "acme-api", sha: "b".repeat(40), author: "rin", time: 0, message: "feat", diffs: budgetDiffs([], ai.excluded) }], "en", signal);
  assert.ok((two.turns[0] as { content: string }).content.startsWith("Explain these 2 commits as one combined change"));
  assert.ok((two.turns[0] as { content: string }).content.includes("(no message)") && (two.turns[0] as { content: string }).content.includes("(no diff shown)"));
  const wip = explainWorkRequest([{ repo: "acme-web", branch: "main", diffs }, { repo: "acme-api", diffs }], "en", signal);
  assert.ok((wip.turns[0] as { content: string }).content.includes("across 2 repositories") && (wip.turns[0] as { content: string }).content.includes("### acme-web (on main)"));
  const range = explainRangeRequest("branch", [{ repo: "acme-libs", base: "develop", tip: "origin/release-1.4", commits: [{ sha: "abc1234", author: "rin", time: 0, subject: "feat: x", body: "" }], more: true, diffs }], "en", signal);
  const rt = (range.turns[0] as { content: string }).content;
  assert.ok(rt.includes("compared with the current branch") && rt.includes("origin/release-1.4 against develop") && rt.includes("- abc1234 feat: x (rin)") && rt.includes("… (more, older)"));
  assert.ok((explainRangeRequest("unpushed", [], "en", signal).turns[0] as { content: string }).content.includes("unpushed"));
  console.log("ok - explain prompts: commits, combined commits, uncommitted work and ranges, excluded diffs never sent");
}

{
  const diffs = budgetDiffs(splitPatch(diff("src/a.ts", "+one")), ai.excluded);
  const r = commitMessageRequest({ repos: [{ repo: "acme-web", branch: "main", recent: ["feat(web): add login", "fix(web): keep callback"], diffs }, { repo: "acme-api", recent: [], diffs }], instructions: "Use English. Prefix with the ticket.", draft: "login" }, signal);
  assert.strictEqual(r.system, COMMIT_SYSTEM);
  const t = (r.turns[0] as { content: string }).content;
  assert.ok(t.indexOf("Use English. Prefix with the ticket.") < t.indexOf("### acme-web"));
  assert.ok(t.includes("keep its intent") && t.includes("- feat(web): add login") && t.includes("### acme-api"));
  assert.ok(!(commitMessageRequest({ repos: [], instructions: " ", draft: "" }, signal).turns[0] as { content: string }).content.includes("rules"));
  assert.strictEqual(cleanCommitMessage("```\nfeat: add retry\n\nBody.\n```"), "feat: add retry\n\nBody.");
  assert.strictEqual(cleanCommitMessage('Commit message:\n"fix: keep the token"'), "fix: keep the token");
  assert.strictEqual(cleanCommitMessage("feat: a  \n\n\n\nbody"), "feat: a\n\nbody");
  assert.strictEqual(cleanCommitMessage("```\nfeat: str", false), "feat: str", "while streaming, an opening fence is dropped");
  assert.strictEqual(cleanCommitMessage('fix: "quoted" word'), 'fix: "quoted" word');
  const s = stashMessageRequest("acme-api", "develop", diffs, signal);
  assert.ok((s.turns[0] as { content: string }).content.includes("### acme-api (on develop)"));
  assert.strictEqual(cleanStashMessage('"WIP: retry the upload"\nmore'), "WIP: retry the upload");
  assert.strictEqual(cleanStashMessage("x".repeat(100)).length, 72);
  console.log("ok - commit and stash messages: the user's rules first, cleaned of fences, labels and quotes, also mid-stream");
}

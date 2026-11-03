import * as assert from "assert";
import { configureI18n } from "../../i18n";
import { conflictTooLarge, explainConflictsRequest, matchEol, MERGE_SYSTEM, mergeFence, mergeProblem, mergeRequest, outsideConflicts, parseMerge, resolveReport, reviewStep, sideLabels } from "./conflicts";
import { budgetDiffs } from "./context";
import { fallbackNotes, notesRequest, parseNotes, renderNotes, type NotesSection } from "./releaseNotes";
import { fileLink, parseReview, renderReview, reviewRequest, type ReviewWords } from "./review";

configureI18n("en");
const signal = new AbortController().signal;

{
  const sections: NotesSection[] = [
    { repo: "acme-web", range: "release-1.4 → main", commits: [{ sha: "abc1234", author: "dana", time: 0, subject: "feat(web): dark login page", body: "" }, { sha: "bcd2345", author: "rin", time: 0, subject: "Merge branch 'x'", body: "" }] },
    { repo: "acme-api", commits: [{ sha: "cde3456", author: "rin", time: 0, subject: "fix: retry the upload once", body: "" }, { sha: "def4567", author: "dana", time: 0, subject: "chore: bump deps", body: "" }] },
  ];
  const r = notesRequest(sections, "en", signal);
  assert.strictEqual(r.json, true);
  assert.ok((r.turns[0] as { content: string }).content.includes("### acme-web (release-1.4 → main)\n- abc1234 feat(web): dark login page (dana)"));
  const notes = parseNotes(JSON.stringify({
    feat: [{ text: "Dark login page.", repo: "acme-web", commits: ["abc1234", "zzz9999"] }],
    fix: [{ text: "Uploads retry once", repo: "elsewhere", commits: ["cde3456"] }, { text: "  " }],
    other: ["Dependencies updated"],
  }), sections)!;
  assert.deepStrictEqual(notes.feat, [{ text: "Dark login page", repo: "acme-web", commits: ["abc1234"] }], "hashes not in the input are dropped");
  assert.deepStrictEqual(notes.fix, [{ text: "Uploads retry once", repo: "", commits: ["cde3456"] }]);
  assert.deepStrictEqual(notes.other, [{ text: "Dependencies updated", repo: "", commits: [] }]);
  assert.strictEqual(parseNotes("not json", sections), undefined);
  assert.strictEqual(parseNotes('{"feat": []}', sections), undefined);
  const fb = fallbackNotes(sections);
  assert.deepStrictEqual(fb.feat.map((l) => l.text), ["dark login page"]);
  assert.deepStrictEqual(fb.fix.map((l) => l.text), ["retry the upload once"]);
  assert.deepStrictEqual(fb.other.map((l) => l.text), ["bump deps"], "merge commits are left out");
  const md = renderNotes(notes, "Release notes", { feat: "Features", fix: "Fixes", other: "Other" });
  assert.strictEqual(md, "# Release notes\n\n## Features\n\n- Dark login page (acme-web abc1234)\n\n## Fixes\n\n- Uploads retry once (cde3456)\n\n## Other\n\n- Dependencies updated\n");
  assert.strictEqual(renderNotes({ feat: [], fix: [], other: [] }, "T", { feat: "F", fix: "X", other: "O" }), "# T\n");
  console.log("ok - release notes: commit messages in, grouped JSON out, kept to the input's hashes; a fallback by prefix");
}

{
  const diffs = budgetDiffs([{ path: "src/a.ts", text: "diff --git a/src/a.ts b/src/a.ts\n+x\n" }], () => false);
  const r = reviewRequest([{ repo: "acme-web", what: "uncommitted changes", diffs }], "zh-cn", signal);
  assert.ok(r.json && (r.turns[0] as { content: string }).content.includes("### acme-web: uncommitted changes"));
  const review = parseReview(JSON.stringify({
    summary: "Two issues.",
    findings: [
      { severity: "low", repo: "acme-web", file: "src/a.ts", line: 3, title: "Name", detail: "Rename it." },
      { severity: "CRITICAL", repo: "acme-web", file: "src/a.ts", line: 12, title: "Token logged", detail: "Remove the log line." },
      { severity: "weird", file: "src/a.ts", line: 1.5, title: "", detail: "No title here\nsecond line" },
      { severity: "high", repo: "acme-web", file: "not/in/diff.ts", line: 9, title: "Elsewhere", detail: "" },
      "junk",
    ],
  }), [{ repo: "acme-web", files: ["src/a.ts"] }])!;
  assert.deepStrictEqual(review.findings.map((f) => [f.severity, f.file, f.line, f.title]), [
    ["critical", "src/a.ts", 12, "Token logged"], ["high", "", 0, "Elsewhere"], ["low", "src/a.ts", 3, "Name"], ["info", "src/a.ts", 0, "No title here"],
  ]);
  const words: ReviewWords = { title: "Review", noFindings: "No problems found.", severity: { critical: "Critical", high: "High", medium: "Medium", low: "Low", info: "Info" } };
  const md = renderReview(review, words, (repo, file, line) => fileLink("D:\\work\\acme-web", file, line));
  assert.ok(md.startsWith("# Review\n\nTwo issues.\n\n## Critical (1)\n\n- **Token logged** — [acme-web/src/a.ts:12](file:///D:/work/acme-web/src/a.ts#L12)\n  Remove the log line."));
  assert.ok(md.includes("- **Elsewhere** — `acme-web`"), "a file outside the diff gets no link");
  assert.ok(md.indexOf("## High") < md.indexOf("## Low") && md.indexOf("## Low") < md.indexOf("## Info"));
  assert.strictEqual(renderReview({ summary: "", findings: [] }, words, () => undefined), "# Review\n\nNo problems found.\n");
  assert.strictEqual(fileLink("/home/dana/acme api", "src/a b.ts", 0), "file:///home/dana/acme%20api/src/a%20b.ts");
  assert.strictEqual(fileLink("/r", "x#1.ts", 2), "file:///r/x%231.ts#L2");
  assert.strictEqual(parseReview("nope", []), undefined);
  console.log("ok - review: findings validated against the diff's files, most severe first, linked to file and line");
}

{
  assert.deepStrictEqual(sideLabels("rebase", "main"), { ours: "the branch being rebased onto (main)", theirs: "your commit being replayed" });
  assert.ok(sideLabels(undefined, "develop").ours.includes("develop"));
  const c = { repo: "acme-api", path: "src/upload.ts", operation: "merge" as const, head: "develop", base: "a\n", ours: "a\nb\n", theirs: undefined, current: "<<<<<<< HEAD\nb\n=======\n>>>>>>> x\n" };
  const r = mergeRequest(c, signal);
  const t = (r.turns[0] as { content: string }).content;
  assert.ok(t.includes("during a merge") && t.includes("Theirs:\n(no such file on this side)") && t.includes("The file now, with conflict markers"));
  assert.strictEqual(conflictTooLarge(c), false);
  assert.strictEqual(conflictTooLarge({ ...c, current: "x".repeat(70_000) }), true);
  assert.ok(t.endsWith("Reply with the merged file between a line ```merged and a line ```, then the Note line."));
  const ok = parseMerge("Here:\n```merged\nconst a = 1;\nconst b = 2;\n```\nNote: kept both constants.\n", { current: "x\r\ny\r\n" });
  assert.deepStrictEqual(ok, { ok: true, content: "const a = 1;\r\nconst b = 2;\r\n", note: "kept both constants." });
  assert.deepStrictEqual(parseMerge("```ts\nonly one block\n```", { current: "x" }), { ok: true, content: "only one block", note: "" });
  assert.deepStrictEqual(parseMerge("```merged\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> x\n```", { current: "x" }), { ok: false, reason: "markers" });
  assert.deepStrictEqual(parseMerge("no block", { current: "x" }), { ok: false, reason: "noBlock" });
  assert.deepStrictEqual(parseMerge("```a\n1\n```\n```b\n2\n```", { current: "x" }), { ok: false, reason: "noBlock" }, "two blocks and none named merged: no guess");
  assert.strictEqual(parseMerge("````merged\nhas ``` inside\n````", { current: "" })?.ok, true);
  console.log("ok - conflicts: ours/theirs named by operation, the merged block parsed (never with markers)");
}

{
  // A README whose merge holds its own code fences: the proposal is the whole file, never cut at the first fence inside it.
  const ours = "# acme-web\n\nInstall:\n\n```sh\nnpm install\n```\n\nThen run it with dana's script.\n";
  const theirs = "# acme-web\n\nInstall:\n\n```sh\nnpm ci\n```\n\nThen run it.\n";
  const current = "# acme-web\n\nInstall:\n\n```sh\n<<<<<<< HEAD\nnpm install\n=======\nnpm ci\n>>>>>>> rin\n```\n\n<<<<<<< HEAD\nThen run it with dana's script.\n=======\nThen run it.\n>>>>>>> rin\n";
  const file = { base: "# acme-web\n\nInstall:\n\n```sh\nnpm i\n```\n\nRun it.\n", ours, theirs, current };
  const fence = mergeFence(file);
  assert.strictEqual(fence, "````", "longer than the file's own fences");
  const c = { repo: "acme-web", path: "README.md", operation: "merge" as const, head: "main", ...file };
  assert.ok((mergeRequest(c, signal).turns[0] as { content: string }).content.includes("between a line ````merged and a line ````"));
  assert.ok(MERGE_SYSTEM.includes("longer than any in the file"), "the model is told why");
  const merged = "# acme-web\n\nInstall:\n\n```sh\nnpm ci\n```\n\nThen run it with dana's script.\n";
  const asked = parseMerge(`${fence}merged\n${merged}${fence}\nNote: took npm ci.`, file);
  assert.deepStrictEqual(asked, { ok: true, content: merged, note: "took npm ci." }, "the fence asked for");
  const plain = parseMerge(`\`\`\`merged\n${merged}\`\`\`\nNote: took npm ci.`, file);
  assert.deepStrictEqual(plain, { ok: true, content: merged, note: "took npm ci." }, "a plain fence anyway: the last one before the note closes it");
  const noNote = parseMerge(`\`\`\`merged\n${merged}\`\`\``, file);
  assert.ok(noNote.ok && noNote.content === merged);
  // The file has a "Note:" line of its own: the answer's note is the last one.
  const noted = "Note: needs Node 22.\n\n```sh\nnpm ci\n```\n";
  const notedFile = { ours: noted, theirs: noted, current: "<<<<<<< HEAD\nNote: needs Node 22.\n=======\nNote: needs Node 22.\n>>>>>>> rin\n\n```sh\nnpm ci\n```\n" };
  assert.deepStrictEqual(parseMerge(`\`\`\`merged\n${noted}\`\`\`\nNote: kept it once.`, notedFile), { ok: true, content: noted, note: "kept it once." });
  // What a cut-off proposal looks like is refused: the end of the file is gone, or it is far shorter than both sides.
  assert.deepStrictEqual(parseMerge("```merged\n# acme-web\n\nInstall:\n\n```sh\nnpm ci\n```", file), { ok: false, reason: "changed" }, "the text after the last conflict is gone");
  assert.deepStrictEqual(parseMerge("```merged\n# acme-web\n\nSee the wiki.\n```", file), { ok: false, reason: "changed" }, "text outside the conflicts rewritten");
  const whole = { ours: `${"a".repeat(400)}\n`, theirs: `${"b".repeat(400)}\n`, current: `<<<<<<< HEAD\n${"a".repeat(400)}\n=======\n${"b".repeat(400)}\n>>>>>>> rin\n` };
  assert.deepStrictEqual(parseMerge("```merged\naaa\n```", whole), { ok: false, reason: "short" });
  assert.ok(parseMerge(`\`\`\`merged\n${"a".repeat(400)}\n${"b".repeat(400)}\n\`\`\``, whole).ok, "both sides kept");
  assert.deepStrictEqual(outsideConflicts(current), [["# acme-web", "", "Install:", "", "```sh"], ["```", ""], [""]]);
  assert.strictEqual(outsideConflicts("no markers\n"), undefined);
  assert.strictEqual(mergeProblem("changed"), "the proposal leaves out or changes text outside the conflicts (cut off?). Resolve it in the merge editor.");
  console.log("ok - conflicts: a merged file with code fences of its own is read whole; a cut-off proposal is refused");
}

{
  assert.strictEqual(matchEol("a\nb", "x\n"), "a\nb\n");
  assert.strictEqual(matchEol("a\r\nb\n", "x"), "a\nb\n");
  const first = reviewStep({ repo: "acme-api", path: "src/upload.ts", index: 1, total: 3, note: "kept both retries" });
  assert.strictEqual(first.title, "Resolve Conflicts with AI (1 of 3): src/upload.ts in acme-api");
  assert.strictEqual(first.placeHolder, "The model says: kept both retries");
  assert.deepStrictEqual(first.items.map((i) => i.id), ["accept", "editor", "skip", "stop"], "one step: accept, the merge editor, skip, or stop the run");
  assert.strictEqual(first.items[0].label, "$(check) Accept and Stage");
  assert.ok(first.items[0].description.includes("git add"));
  assert.strictEqual(first.items[3].description, "leave the other 2 files for now");
  assert.strictEqual(reviewStep({ repo: "acme-api", path: "a.go", index: 2, total: 3 }).items[3].description, "leave the last file for now");
  const lastOne = reviewStep({ repo: "acme-api", path: "a.go", index: 3, total: 3 });
  assert.deepStrictEqual(lastOne.items.map((i) => i.id), ["accept", "editor", "skip"], "nothing left to stop before");
  assert.strictEqual(lastOne.placeHolder, "The proposal is on the left, the file on the right.");
  const none = reviewStep({ repo: "acme-web", path: "big.json", index: 1, total: 1, reason: "too large to send. Resolve it in the merge editor." });
  assert.deepStrictEqual(none.items.map((i) => i.id), ["editor", "skip"], "no proposal: nothing to accept");
  assert.strictEqual(none.title, "Resolve Conflicts with AI: big.json in acme-web");
  assert.strictEqual(none.placeHolder, "No proposal: too large to send. Resolve it in the merge editor.");
  assert.strictEqual(resolveReport({ accepted: 2, reviewed: 3, total: 3, operations: ["rebase"] }),
    "Linyra AI: 2 of 3 conflicted files resolved and staged. Continue the rebase in Source Control once every file is resolved.");
  assert.strictEqual(resolveReport({ accepted: 0, reviewed: 1, total: 4, operations: [undefined] }),
    "Linyra AI: 0 of 4 conflicted files resolved and staged; stopped before the other 3. Continue the merge in Source Control once every file is resolved.");
  assert.ok(resolveReport({ accepted: 1, reviewed: 2, total: 2, operations: ["merge", "cherry-pick"] }).endsWith("Continue each repository's operation in Source Control once every file is resolved."));
  const e = explainConflictsRequest("acme-web", "feature/login", "main", [{ path: "src/a.ts", base: "a", left: "b", right: undefined }], "en", signal);
  assert.ok((e.turns[0] as { content: string }).content.includes("merging feature/login into main") && (e.turns[0] as { content: string }).content.includes("main:\n(no such file on this side)"));
  console.log("ok - conflicts: line endings kept, one choice per file, the run's report");
}

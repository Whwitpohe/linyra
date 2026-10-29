import * as assert from "assert";
import { budgetDiffs, fenced, leftOutNote, newFileDiff, parseJsonObject, splitPatch, stripFences } from "./context";
import { fakeAi } from "./fakeAi";

const PATCH = [
  "diff --git a/src/api.ts b/src/api.ts",
  "index 1111111..2222222 100644",
  "--- a/src/api.ts",
  "+++ b/src/api.ts",
  "@@ -1,2 +1,3 @@",
  " export const retries = 1;",
  "+export const timeout = 30;",
  "diff --git a/package-lock.json b/package-lock.json",
  "--- a/package-lock.json",
  "+++ b/package-lock.json",
  "@@ -1 +1 @@",
  "-\"lockfileVersion\": 2",
  "+\"lockfileVersion\": 3",
  "diff --git a/docs/old name.md b/docs/new name.md",
  "similarity index 90%",
  "rename from docs/old name.md",
  "rename to docs/new name.md",
  "diff --git a/media/logo.png b/media/logo.png",
  "Binary files a/media/logo.png and b/media/logo.png differ",
  "diff --git a/gone.txt b/gone.txt",
  "deleted file mode 100644",
  "--- a/gone.txt",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-bye",
  "",
].join("\n");

{
  const files = splitPatch(PATCH);
  assert.deepStrictEqual(files.map((f) => f.path), ["src/api.ts", "package-lock.json", "docs/new name.md", "media/logo.png", "gone.txt"]);
  assert.strictEqual(files[2].oldPath, "docs/old name.md");
  assert.strictEqual(files[3].binary, true);
  assert.ok(files[0].text.startsWith("diff --git a/src/api.ts") && files[0].text.includes("+export const timeout"));
  assert.ok(!files[0].text.includes("package-lock"));
  assert.deepStrictEqual(splitPatch(""), []);
  const quoted = splitPatch('diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"\n--- "a/caf\\303\\251.txt"\n+++ "b/caf\\303\\251.txt"\n@@ -1 +1 @@\n-a\n+b\n');
  assert.strictEqual(quoted[0].path.length, 8); // café.txt, its é given as git's octal escape
  console.log("ok - splitPatch: one section per file, renames, deletions, binary files and quoted paths");
}

{
  const ai = fakeAi([]);
  const files = splitPatch(PATCH);
  const b = budgetDiffs(files, ai.excluded);
  assert.deepStrictEqual(b.left, [{ path: "package-lock.json", why: "excluded" }, { path: "media/logo.png", why: "binary" }]);
  assert.strictEqual(b.sections.length, 3);
  assert.ok(!b.sections.join("").includes("lockfileVersion"), "an excluded file's diff is never in the prompt");
  const big = budgetDiffs([{ path: "a.ts", text: "x".repeat(500) }, { path: "b.ts", text: "y".repeat(500) }, { path: "c.ts", text: "z".repeat(100) }], () => false, { fileChars: 300, newFileChars: 50, totalChars: 500 });
  assert.deepStrictEqual(big.cut, ["a.ts"]);
  assert.ok(big.sections[0].includes("diff cut here: 200 more characters"));
  assert.ok(big.chars <= 500);
  assert.deepStrictEqual(big.left, [{ path: "b.ts", why: "budget" }]);
  assert.strictEqual(big.sections.length, 2, "a smaller file after one over the budget still fits");
  const note = leftOutNote(b);
  assert.ok(note.includes("excluded by the user's settings: package-lock.json") && note.includes("binary: media/logo.png"));
  assert.strictEqual(leftOutNote({ left: [], cut: [] }), "");
  console.log("ok - budgetDiffs: excluded and binary files by name only, each diff and the total cut to the limits");
}

{
  const f = newFileDiff("notes/todo.md", "one\ntwo\n");
  assert.ok(f.text.includes("+++ b/notes/todo.md") && f.text.includes("@@ -0,0 +1,2 @@\n+one\n+two"));
  assert.strictEqual(newFileDiff("bin.dat", "a\0b").binary, true);
  assert.strictEqual(newFileDiff("unreadable", undefined).binary, true);
  assert.ok(newFileDiff("long.txt", "a".repeat(100), { fileChars: 10, newFileChars: 20, totalChars: 100 }).text.includes("… (cut here)"));
  console.log("ok - newFileDiff: untracked files as a diff would show them, binary ones by name");
}

{
  assert.deepStrictEqual(parseJsonObject('```json\n{"query": "author:dana"}\n```'), { query: "author:dana" });
  assert.deepStrictEqual(parseJsonObject('Here it is: {"a": 1} hope it helps'), { a: 1 });
  assert.strictEqual(parseJsonObject("no json"), undefined);
  assert.strictEqual(parseJsonObject("[1,2]"), undefined);
  assert.strictEqual(stripFences("```text\nhello\n```"), "hello");
  assert.strictEqual(stripFences("  plain  "), "plain");
  assert.strictEqual(fenced("a ``` b"), "````\na ``` b\n````");
  console.log("ok - answers: JSON found inside fences or words, fences longer than the text's backticks");
}

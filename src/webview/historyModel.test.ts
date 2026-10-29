import * as assert from "assert";
import { chipPath, fileChangeLabel, fileChangeView, nameNotes } from "./historyModel";

// ── Each row's change to the file: letter, lines, a rename's old name ─────
{
  assert.strictEqual(fileChangeView(undefined), undefined);
  assert.strictEqual(fileChangeView({ path: "a.ts" }), undefined, "a merge shows no change of its own");
  assert.deepStrictEqual(fileChangeView({ path: "a.ts", status: "M", added: 12, deleted: 3 }), { status: "M", lines: { added: 12, deleted: 3 } });
  assert.deepStrictEqual(fileChangeView({ path: "logo.png", status: "M", added: null, deleted: null }), { status: "M", lines: null }, "binary: null lines");
  assert.deepStrictEqual(fileChangeView({ path: "a.ts", status: "A" }), { status: "A", lines: undefined }, "not read: no lines at all");
  assert.strictEqual(fileChangeLabel({ status: "M", lines: { added: 12, deleted: 3 } }), "Modified, 12 lines added, 3 deleted");
  assert.strictEqual(fileChangeLabel({ status: "R", lines: { added: 1, deleted: 0 }, oldPath: "src/old.ts" }), "Renamed, 1 lines added, 0 deleted, was src/old.ts");
  assert.strictEqual(fileChangeLabel({ status: "M", lines: null }), "Modified, binary");
  console.log("ok - a File History row names its status letter, lines and old name");
}

// ── What follows the subject: the name then, and a rename's old name ───────
{
  assert.deepStrictEqual(nameNotes({ path: "src/client.ts", status: "M" }, "src/client.ts"), {});
  assert.deepStrictEqual(nameNotes({ path: "src/old.ts", status: "M" }, "src/client.ts"), { was: " — src/old.ts" });
  assert.deepStrictEqual(nameNotes({ path: "src/client.ts", oldPath: "src/old.ts", status: "R" }, "src/client.ts"), { from: "← src/old.ts" });
  assert.deepStrictEqual(nameNotes({ path: "src/mid.ts", oldPath: "src/old.ts", status: "R" }, "src/client.ts"), { was: " — src/mid.ts", from: "← src/old.ts" });
  assert.deepStrictEqual(chipPath("src/webview/client.ts"), { dir: "src/webview/", base: "client.ts" });
  assert.deepStrictEqual(chipPath("README.md"), { dir: "", base: "README.md" });
  console.log("ok - the subject names a renamed file's old name, and the chip keeps the file name");
}

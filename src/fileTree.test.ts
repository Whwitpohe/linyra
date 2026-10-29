import * as assert from "assert";
import { fileTree } from "./fileTree";

{
  const f = (path: string) => ({ path, added: 1, deleted: 0 });
  const tree = fileTree([f("src/client.ts"), f("internal/upload/upload_test.go"), f("README.md"), f("internal/upload/upload.go")]);
  const shape = (nodes: ReturnType<typeof fileTree>): unknown => nodes.map((n) => n.kind === "folder" ? [n.name, n.count, shape(n.children)] : n.name);
  assert.deepStrictEqual(shape(tree), [["internal/upload", 2, ["upload.go", "upload_test.go"]], ["src", 1, ["client.ts"]], "README.md"]);
  assert.deepStrictEqual(shape(fileTree([f("a/b/x.ts"), f("a/c/y.ts")])), [["a", 2, [["b", 1, ["x.ts"]], ["c", 1, ["y.ts"]]]]]);
  assert.deepStrictEqual(fileTree([]), []);
  console.log("ok - fileTree groups by folder, folders first, single-child chains compressed");
}

{
  // What every tree of changed files is built from (the Changes view, Compare, the Commit side bar).
  const f = (path: string) => ({ path, added: 1, deleted: 0 });
  const shape = (nodes: ReturnType<typeof fileTree>): unknown => nodes.map((n) => n.kind === "folder" ? [n.name, n.count, shape(n.children)] : n.name);
  // A chain joins only while each folder holds one folder and nothing else.
  assert.deepStrictEqual(shape(fileTree([f("a/b/c/d/x.ts")])), [["a/b/c/d", 1, ["x.ts"]]]);
  assert.deepStrictEqual(shape(fileTree([f("a/b/x.ts"), f("a/y.ts")])), [["a", 2, [["b", 1, ["x.ts"]], "y.ts"]]]);
  // The chain stops at a folder with two folders; the folders under it join on their own.
  assert.deepStrictEqual(shape(fileTree([f("a/b/c/x.ts"), f("a/b/d/e/y.ts")])), [["a/b", 2, [["c", 1, ["x.ts"]], ["d/e", 1, ["y.ts"]]]]]);
  // Two top-level folders are never joined into one; a lone file at the top stays a file.
  assert.deepStrictEqual(shape(fileTree([f("x.ts")])), ["x.ts"]);
  // Names sort by code point, as git lists them: "B" before "a".
  assert.deepStrictEqual(shape(fileTree([f("b.ts"), f("B.ts"), f("a.ts")])), ["B.ts", "a.ts", "b.ts"]);
  console.log("ok - fileTree compresses only lone-folder chains, at any depth");
}

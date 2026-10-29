import * as assert from "assert";
import type { ChangeRow } from "../../changesProtocol";
import { changeLines, changeNote, filterFiles } from "./fileFilterModel";

const file = (id: string, path: string, oldPath?: string): ChangeRow => ({ id, kind: "file", label: path.split("/").pop()!, path,
  oldPath, description: "+1 −1", tooltip: path, contextValue: "file", added: 1, deleted: 1 });
const renamed = file("rename-id", "src/auth/Login.vue", "legacy/SignIn.vue");
const binary = { ...file("binary-id", "src/auth/logo.png"), added: null, deleted: null };
const roots: ChangeRow[] = [{ id: "src", kind: "folder", label: "src", description: "3", tooltip: "src", contextValue: "folder.discardable.changed", children: [
  { id: "auth", kind: "folder", label: "auth", description: "2", tooltip: "src/auth", contextValue: "folder", children: [renamed, binary] },
  file("plain-id", "src/index.ts"),
] }, file("docs-id", "docs/README.md")];

{
  const before = JSON.stringify(roots);
  const result = filterFiles(roots, "LOGIN");
  assert.strictEqual(result.matched, 1);
  assert.strictEqual(result.total, 4);
  assert.strictEqual(result.roots[0].children?.[0].children?.[0], renamed, "the row id and host-owned diff identity are preserved");
  assert.strictEqual(result.roots[0].description, "1");
  assert.strictEqual(result.roots[0].contextValue, "folder", "filtered folders cannot expose bulk actions on hidden children");
  assert.strictEqual(JSON.stringify(roots), before, "filtering never mutates the original tree");
  assert.strictEqual(filterFiles(roots, "legacy/signin").matched, 1, "rename sources are searchable");
  assert.strictEqual(filterFiles(roots, "src\\auth").matched, 2, "repo paths and Windows separators work");
  assert.strictEqual(filterFiles(roots, "src/auth/logo.png").matched, 1, "binary files stay searchable");
  assert.strictEqual(filterFiles(roots, "readme").matched, 1);
  assert.deepStrictEqual(filterFiles(roots, "missing").roots, []);
  assert.strictEqual(filterFiles(roots, " ").roots, roots, "clearing restores the original tree objects");
  assert.strictEqual(filterFiles(roots, " ").matched, 4);
  assert.strictEqual(filterFiles(roots, "*.vue").matched, 0, "the query is literal, not an injected expression");
  console.log("ok - changed-file filtering preserves ancestry and diff ids, matches paths and rename sources, and restores the tree");
}

{
  const combined = [{ id: "repo", kind: "repo" as const, label: "acme-web", description: "2 commits", tooltip: "", contextValue: "combinedRepo", children: roots }];
  const result = filterFiles(combined, "auth");
  assert.strictEqual(result.matched, 2);
  assert.strictEqual(result.roots[0].description, "2 commits", "combined repository metadata keeps its meaning");
  assert.deepStrictEqual(filterFiles([], "a"), { roots: [], total: 0, matched: 0 });
  console.log("ok - combined changes and empty states retain repository structure");
}

{
  // The note drawn before the counts is searchable (staged, binary, new); the counts themselves are not.
  const staged = { ...file("staged-id", "src/a.ts"), staged: true };
  const binary = { ...file("bin-id", "assets/logo.png"), added: null, deleted: null, description: "binary" };
  const untracked = { ...file("new-id", "notes.md"), untracked: true, added: null, deleted: null, description: "new" };
  assert.strictEqual(changeNote(staged), "staged");
  assert.deepStrictEqual(changeLines(staged), { added: 1, deleted: 1 });
  assert.strictEqual(changeNote(binary), "binary");
  assert.strictEqual(changeLines(binary), undefined);
  assert.strictEqual(changeNote(untracked), "new");
  assert.strictEqual(changeNote(file("plain-id", "src/b.ts")), undefined);
  const rows = [staged, binary, untracked, file("plain-id", "src/b.ts")];
  assert.deepStrictEqual(filterFiles(rows, "staged").roots.map((r) => r.id), ["staged-id"]);
  assert.deepStrictEqual(filterFiles(rows, "binary").roots.map((r) => r.id), ["bin-id"]);
  assert.strictEqual(filterFiles(rows, "+1").matched, 0, "the + − counts are not text to find");
  console.log("ok - a file's note (staged, binary, new) is searchable, its counts are not");
}

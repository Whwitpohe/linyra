import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { merge3 } from "./lineMerge";

{
  assert.deepStrictEqual(merge3("a\nb\nc\nd\ne\n", "a\nB\nc\nd\ne\n", "a\nb\nc\nd\nE\n"), { ok: true, text: "a\nB\nc\nd\nE\n" });
  console.log("ok - changes separated by unchanged lines merge");
}
{
  assert.deepStrictEqual(merge3("a\nb\nc\n", "a\nB\nc\n", "a\nb\nC\n"), { ok: false });
  console.log("ok - changes on adjacent lines conflict, as git does");
}
{
  assert.deepStrictEqual(merge3("a\nb\nc\n", "a\nX\nc\n", "a\nY\nc\n"), { ok: false });
  assert.deepStrictEqual(merge3("a\nb\nc\n", "a\nX\nc\n", "a\nX\nc\n"), { ok: true, text: "a\nX\nc\n" });
  console.log("ok - overlapping changes conflict unless identical");
}
{
  assert.deepStrictEqual(merge3("a\nb\n", "a\nb\n", "a\nB\n"), { ok: true, text: "a\nB\n" });
  assert.deepStrictEqual(merge3("a\nb\n", "a\nB\n", "a\nb\n"), { ok: true, text: "a\nB\n" });
  console.log("ok - one side changed: that side");
}
{
  assert.deepStrictEqual(merge3("", "x\n", ""), { ok: true, text: "x\n" });
  assert.deepStrictEqual(merge3("", "", "y\n"), { ok: true, text: "y\n" });
  assert.deepStrictEqual(merge3("x\n", "x\n", ""), { ok: true, text: "" });
  console.log("ok - empty sides (added and deleted files)");
}
{
  assert.deepStrictEqual(merge3("a\nb", "a\nb", "a\nB"), { ok: true, text: "a\nB" });
  assert.deepStrictEqual(merge3("a\r\nb\r\n", "a\r\nb\r\n", "a\r\nB\r\n"), { ok: true, text: "a\r\nB\r\n" });
  console.log("ok - no trailing newline and CRLF keep their bytes");
}

// The oracle: git merge-file decides clean versus conflict, on scratch files outside any repository.
function oracle(base: string, ours: string, theirs: string): { ok: boolean; text: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "polylog-merge-"));
  try {
    for (const [n, t] of [["base", base], ["ours", ours], ["theirs", theirs]]) fs.writeFileSync(path.join(dir, n), t);
    try {
      const text = execFileSync("git", ["merge-file", "-p", "ours", "base", "theirs"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      return { ok: true, text };
    } catch {
      return { ok: false, text: "" };
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

let seed = 7;
const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
function edit(lines: string[]): string[] {
  const out = [...lines];
  const i = rand(out.length + 1);
  const op = rand(3);
  if (op === 0) out.splice(i, 0, `new${rand(100)}`);
  else if (op === 1 && out.length > 0) out.splice(Math.min(i, out.length - 1), 1);
  else if (out.length > 0) out[Math.min(i, out.length - 1)] = `chg${rand(100)}`;
  return out;
}
const text = (lines: string[]) => lines.map((l) => `${l}\n`).join("");
{
  const cases: [string, string, string][] = [
    ["a\nb\nc\nd\ne\n", "a\nB\nc\nd\ne\n", "a\nb\nc\nd\nE\n"],
    ["a\nb\nc\n", "a\nB\nc\n", "a\nb\nC\n"],
    ["a\nb\nc\n", "a\nX\nc\n", "a\nY\nc\n"],
    ["a\nb\nc\n", "a\nX\nc\n", "a\nX\nc\n"],
    ["", "x\n", ""],
    ["x\n", "x\n", ""],
    ["a\nb", "a\nb", "a\nB"],
  ];
  for (let k = 0; k < 40; k++) {
    const base = Array.from({ length: 4 + rand(6) }, (_, j) => `l${j}`);
    cases.push([text(base), text(edit(base)), text(edit(base))]);
  }
  for (const [b, o, t] of cases) {
    const want = oracle(b, o, t);
    const got = merge3(b, o, t);
    assert.strictEqual(got.ok, want.ok, `clean/conflict differs from git for ${JSON.stringify([b, o, t])}`);
    if (got.ok) assert.strictEqual(got.text, want.text, `text differs from git for ${JSON.stringify([b, o, t])}`);
  }
  console.log(`ok - agrees with git merge-file on ${cases.length} cases`);
}
{
  // A file rewritten wholesale on one side: refused quickly instead of a quadratic diff on the host.
  const n = 6000;
  const base = Array.from({ length: n }, (_, i) => `line ${i}\n`).join("");
  const ours = Array.from({ length: n }, (_, i) => `other ${i}\n`).join("");
  const start = Date.now();
  const r = merge3(base, ours, base);
  const ms = Date.now() - start;
  assert.ok(ms < 1500, `took ${ms} ms`);
  assert.deepStrictEqual(r, { ok: false, tooLarge: true });
  console.log(`ok - a huge rewrite is refused as too large (${ms} ms)`);
}

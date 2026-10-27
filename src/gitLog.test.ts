import * as assert from "assert";
import { HISTORY_FORMAT, LOG_FORMAT, parseHistory, parseLog } from "./gitLog";
import { commitKey, isSha } from "./types";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const REPO = "/ws/acme-api";
// One record exactly as git emits it: NUL between fields, RS after the last.
const rec = (sha: string, ct: number, an: string, subject: string, parents: string) =>
  [sha, String(ct), an, `${an}@example.com`, subject, parents].join("\0") + "\x1e";

// ── The format string is the contract the parser relies on ─────────────────
{
  assert.strictEqual(LOG_FORMAT, "--format=%H%x00%ct%x00%an%x00%ae%x00%s%x00%P%x00refs:%D%x1e");
  console.log("ok - LOG_FORMAT is NUL-delimited fields, RS-terminated records");
}

// ── Records become commits; git's newline between records is tolerated ─────
{
  const out = rec(A, 1758600300, "rin", "feat: add retry to uploader", B) + "\n" +
    rec(B, 1758600000, "dana", "feat: scaffold api", "") + "\n";
  assert.deepStrictEqual(parseLog(out, REPO), [
    { repoId: REPO, sha: A, time: 1758600300, author: "rin", email: "rin@example.com", subject: "feat: add retry to uploader", parents: [B] },
    { repoId: REPO, sha: B, time: 1758600000, author: "dana", email: "dana@example.com", subject: "feat: scaffold api", parents: [] },
  ]);
  console.log("ok - parses records; a root commit has no parents");
}

// ── A merge carries both parents ────────────────────────────────────────────
{
  const [merge] = parseLog(rec(A, 1, "dana", "merge origin/release-1.4", `${B} ${C}`), REPO);
  assert.deepStrictEqual(merge.parents, [B, C]);
  console.log("ok - a merge commit carries every parent");
}

// ── Subjects never need escaping ────────────────────────────────────────────
{
  const subjects = [`say "hi" and 'bye'`, "café ✓ 🚀 日本語", "tab\there back\\slash", "looks like %x00 and , ; |"];
  const out = subjects.map((s, i) => rec(String(i).repeat(40), 100 - i, "rin", s, "")).join("\n");
  assert.deepStrictEqual(parseLog(out, REPO).map((c) => c.subject), subjects);
  console.log("ok - quotes, unicode, emoji, tabs and backslashes round-trip");
}

// ── Empty output is an empty history, not an error ──────────────────────────
{
  assert.deepStrictEqual(parseLog("", REPO), []);
  assert.deepStrictEqual(parseLog("\n", REPO), []);
  console.log("ok - empty output parses to no commits");
}

// ── A record cut off by a killed process is dropped, earlier ones kept ─────
{
  const out = rec(A, 5, "dana", "complete", "") + "\n" + [B, "17586", "da"].join("\0");
  assert.deepStrictEqual(parseLog(out, REPO).map((c) => c.sha), [A]);
  console.log("ok - a truncated final record is dropped");
}

// ── Malformed records are skipped, SHA-256 repositories accepted ───────────
{
  const bad = ["x".repeat(40), "1", "a", "b", "c", ""].join("\0") + "\x1e"; // not hex
  const noTime = [A, "soon", "a", "b", "c", ""].join("\0") + "\x1e";
  const tooFew = [A, "1", "a"].join("\0") + "\x1e";
  const sha256 = "d".repeat(64);
  const out = bad + noTime + tooFew + rec(sha256, 9, "rin", "sha256 repo", "");
  assert.deepStrictEqual(parseLog(out, REPO).map((c) => c.sha), [sha256]);
  console.log("ok - malformed records are skipped; 64-hex SHAs are accepted");
}

// ── Helpers ─────────────────────────────────────────────────────────────────
{
  assert.notStrictEqual(commitKey({ repoId: "/a", sha: A }), commitKey({ repoId: "/b", sha: A }));
  assert.ok(isSha(A) && isSha("d".repeat(64)));
  assert.ok(!isSha("--output=/tmp/x") && !isSha(A.toUpperCase()) && !isSha("a".repeat(39)) && !isSha(undefined));
  console.log("ok - commitKey separates repos; isSha accepts only 40/64 lowercase hex");
}

// ── File history: RS starts each record; the file's status follows it ──────
// Byte shape from git 2.43: RS <fields NUL-separated> NUL "\n" <STATUS> NUL <path> NUL [<new> NUL]
{
  assert.strictEqual(HISTORY_FORMAT, "--format=%x1e%H%x00%ct%x00%an%x00%ae%x00%s%x00%P%x00refs:%D");
  const hrec = (sha: string, ct: number, subject: string, status: string, ...paths: string[]) =>
    "\x1e" + [sha, String(ct), "dana", "dana@example.com", subject, ""].join("\0") + "\0\n" + status + "\0" + paths.join("\0") + "\0";
  const out = hrec(A, 400, "edit new", "M", "src/new.ts") + hrec(B, 300, "rename", "R100", "src/old.ts", "src/new.ts") + hrec(C, 200, "edit old", "M", "src/old.ts");
  assert.deepStrictEqual(parseHistory(out, REPO, "src/new.ts").map((c) => [c.subject, c.file]), [
    ["edit new", { path: "src/new.ts", status: "M" }],
    ["rename", { path: "src/new.ts", oldPath: "src/old.ts", status: "R" }],
    ["edit old", { path: "src/old.ts", status: "M" }],
  ]);
  assert.deepStrictEqual(parseHistory("", REPO, "x"), []);
  const cut = hrec(A, 1, "whole", "M", "a.ts") + "\x1e" + [B, "2", "da"].join("\0");
  assert.deepStrictEqual(parseHistory(cut, REPO, "a.ts").map((c) => c.subject), ["whole"], "a record cut off by a kill is dropped");
  const merge = "\x1e" + [C, "5", "rin", "rin@example.com", "merge", `${A} ${B}`].join("\0") + "\0";
  assert.deepStrictEqual(parseHistory(merge, REPO, "a.ts")[0].file, { path: "a.ts" }, "a record with no status keeps the file's current path");
  console.log("ok - parseHistory reads each commit's path and status, following renames");
}

{
  const fields = [A, "1", "dana", "dana@example.com", "feat: branch tip", B, "refs:HEAD -> refs/heads/develop, refs/remotes/origin/develop, tag: refs/tags/v1"];
  const refs = [{ kind: "head", name: "HEAD" }, { kind: "local", name: "develop" }, { kind: "remote", name: "origin/develop" }, { kind: "tag", name: "v1" }];
  assert.deepStrictEqual(parseLog(fields.join("\0") + "\x1e", REPO)[0].refs, refs);
  const history = parseHistory("\x1e" + fields.join("\0") + "\0\nR100\0src/old.ts\0src/new.ts\0", REPO, "src/new.ts")[0];
  assert.deepStrictEqual(history.refs, refs);
  assert.deepStrictEqual(history.file, { path: "src/new.ts", oldPath: "src/old.ts", status: "R" });
  console.log("ok - local/remote/tag decorations do not shift file-history status or rename paths");
}

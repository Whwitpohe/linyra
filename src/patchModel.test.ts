import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { gitEnv, makeRepo } from "./fixtures";
import { amArgs, applyArgs, isMailbox, looksLikePatch, mailboxCommits, patchFiles, patchFit, patchSources } from "./patchModel";

const diff = "diff --git a/src/app.ts b/src/app.ts\nindex 1111111..2222222 100644\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-a\n+b\n";
{
  assert.ok(looksLikePatch(diff));
  assert.ok(looksLikePatch("--- notes.md\t2026-10-29\n+++ notes.md\t2026-10-29\n@@ -1 +1 @@\n-a\n+b\n"), "a plain unified diff");
  assert.ok(!looksLikePatch("just some words\n--- not a header"));
  assert.deepStrictEqual(patchFiles(`${diff}diff --git a/old.css b/new.css\nsimilarity index 90%\nrename from old.css\nrename to new.css\n`), ["src/app.ts", "new.css"]);
  assert.deepStrictEqual(patchFiles("--- a/notes.md\n+++ b/notes.md\n@@ -1 +1 @@\n-a\n+b\n--- a/gone.txt\n+++ /dev/null\n"), ["notes.md"]);
  const mbox = `From ${"a".repeat(40)} Mon Sep 17 00:00:00 2001\nFrom: dana <dana@example.com>\nSubject: [PATCH 1/2] feat: one\n\n---\n${diff}\nFrom ${"b".repeat(40)} Mon Sep 17 00:00:00 2001\n`;
  assert.ok(isMailbox(mbox) && !isMailbox(diff));
  assert.strictEqual(mailboxCommits(mbox), 2);
  assert.deepStrictEqual(applyArgs({ check: true }), ["apply", "--check", "--whitespace=nowarn", "-"]);
  assert.deepStrictEqual(applyArgs({ threeWay: true }), ["apply", "--3way", "--whitespace=nowarn", "-"]);
  console.log("ok - a patch, its files, and a format-patch mailbox are told apart");
}

{
  // Real git: Create Patch…'s output applied as changes, as a three-way merge, and as commits.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "linyra-patch-"));
  const ID = { GIT_AUTHOR_NAME: "dana", GIT_AUTHOR_EMAIL: "dana@example.com", GIT_COMMITTER_NAME: "dana", GIT_COMMITTER_EMAIL: "dana@example.com" };
  const git = (cwd: string, args: string[], input?: string) => execFileSync("git", args, { cwd, input, env: { ...gitEnv(home), ...ID, LC_ALL: "C", GIT_EDITOR: ":" }, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  const fails = (cwd: string, args: string[], input?: string) => {
    try { git(cwd, args, input); return ""; } catch (e) { return String((e as { stderr?: unknown }).stderr ?? e); }
  };
  try {
    const source = path.join(home, "acme-web");
    makeRepo(source, [{ time: 1000, author: "dana", message: "feat: base", files: { "a.txt": "1\n2\n3\n" } }], home);
    const target = path.join(home, "acme-web-copy");
    git(home, ["clone", "-q", source, target]);
    fs.writeFileSync(path.join(source, "a.txt"), "one\n2\n3\n");
    git(source, ["commit", "-qam", "feat: one"]);
    const mbox = git(source, ["format-patch", "--stdout", "-1", "HEAD"]) + "\n";
    assert.ok(isMailbox(mbox));

    git(target, applyArgs({ check: true }), mbox);
    git(target, applyArgs(), mbox);
    assert.strictEqual(fs.readFileSync(path.join(target, "a.txt"), "utf8"), "one\n2\n3\n", "as changes");
    assert.strictEqual(git(target, ["log", "-1", "--format=%s"]), "feat: base", "no commit");
    git(target, ["checkout", "-q", "--", "a.txt"]);

    // The target moved on the same line: --check refuses, --3way leaves conflict markers.
    fs.writeFileSync(path.join(target, "a.txt"), "uno\n2\n3\n");
    git(target, ["commit", "-qam", "feat: uno"]);
    assert.match(fails(target, applyArgs({ check: true }), mbox), /patch does not apply/);
    assert.notStrictEqual(fails(target, applyArgs({ threeWay: true }), mbox), "", "applied with conflicts: non-zero");
    assert.match(fs.readFileSync(path.join(target, "a.txt"), "utf8"), /<<<<<<<[\s\S]*=======[\s\S]*>>>>>>>/);
    git(target, ["reset", "-q", "--hard", "HEAD~1"]);

    git(target, amArgs(), mbox);
    assert.strictEqual(git(target, ["log", "-1", "--format=%s|%an"]), "feat: one|dana", "as a commit, with its author");

    // git's own diff removing an SQL comment: that hunk line reads "--- create…", and is no file.
    fs.writeFileSync(path.join(source, "init.sql"), "-- create the users table\nCREATE TABLE users (id int);\n");
    git(source, ["add", "init.sql"]);
    git(source, ["commit", "-qm", "feat: users"]);
    fs.writeFileSync(path.join(source, "init.sql"), "CREATE TABLE users (id int);\n");
    assert.deepStrictEqual(patchSources(git(source, ["diff"]) + "\n"), ["init.sql"]);
    console.log("ok - real git: a patch applied as changes, by three-way merge with conflicts, and as commits");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

{
  const diff = "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-a\n+b\n"
    + "diff --git a/new.md b/new.md\nnew file mode 100644\n--- /dev/null\n+++ b/new.md\n@@ -0,0 +1 @@\n+n\n";
  assert.deepStrictEqual(patchSources(diff), ["src/app.ts"], "a file the patch adds is not expected to exist");
  const repos = [{ id: "acme-web" }, { id: "acme-api" }, { id: "acme-libs" }];
  assert.deepStrictEqual(patchFit(repos, 1, new Map([["acme-api", 1]])), { sure: { id: "acme-api" }, offer: [{ id: "acme-api" }], fits: 1 }, "one fits: no question");
  assert.strictEqual(patchFit(repos, 1, new Map([["acme-web", 1], ["acme-api", 1], ["acme-libs", 1]])).fits, 3, "all fit: several, not none");
  assert.deepStrictEqual(patchFit(repos, 2, new Map([["acme-web", 2], ["acme-libs", 2]])).offer.map((r) => r.id), ["acme-web", "acme-libs"], "several fit: only those");
  assert.deepStrictEqual(patchFit(repos, 3, new Map([["acme-libs", 2], ["acme-api", 1]])).offer.map((r) => r.id), ["acme-libs", "acme-api", "acme-web"], "none fits: all, best first");
  assert.strictEqual(patchFit(repos, 0, new Map()).sure, undefined, "a patch that only adds files: asked");
  console.log("ok - Apply Patch… finds the repository from the files the patch changes");
}

{
  // A hunk's own lines can look like headers: a removed "-- comment" is "--- comment", an added "++ x" is "+++ x".
  const sql = "diff --git a/db/init.sql b/db/init.sql\nindex 1111111..2222222 100644\n--- a/db/init.sql\n+++ b/db/init.sql\n"
    + "@@ -1,3 +1,3 @@\n--- create the users table\n+++ create the user table\n CREATE TABLE users (id int);\n-DROP TABLE old;\n+DROP TABLE older;\n";
  assert.deepStrictEqual(patchSources(sql), ["db/init.sql"], "a removed SQL comment is not a file the patch expects");
  const repos = [{ id: "acme-api" }, { id: "acme-web" }];
  assert.strictEqual(patchFit(repos, patchSources(sql).length, new Map([["acme-api", 1]])).sure?.id, "acme-api", "so the one repository with db/init.sql fits");
  // A plain unified diff (no diff --git): its files from its headers too, never from its hunks.
  const plain = "--- notes.md\t2026-10-29\r\n+++ notes.md\t2026-10-29\r\n@@ -1,2 +1,2 @@\r\n-- one\r\n++ two\r\n kept\r\n\\ No newline at end of file\r\n"
    + "--- a/b c.md\t\n+++ b/b c.md\t\n@@ -1 +1 @@\n--- x\n+++ y\n";
  assert.deepStrictEqual(patchFiles(plain), ["notes.md", "b c.md"], "CRLF, a date after the tab, a path with a space (git's trailing tab)");
  assert.deepStrictEqual(patchSources(plain), ["notes.md", "b c.md"]);
  console.log("ok - Apply Patch… reads file headers only between hunks");
}

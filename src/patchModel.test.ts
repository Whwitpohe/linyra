import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { gitEnv, makeRepo } from "./fixtures";
import { amArgs, applyArgs, isMailbox, looksLikePatch, mailboxCommits, patchFiles } from "./patchModel";

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
    console.log("ok - real git: a patch applied as changes, by three-way merge with conflicts, and as commits");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

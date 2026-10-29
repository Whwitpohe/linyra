import * as assert from "assert";
import { commandText, isReadOnly, parseCommandLine, runReport } from "./runAcrossModel";

{
  assert.deepStrictEqual(parseCommandLine("status -sb"), ["status", "-sb"]);
  assert.deepStrictEqual(parseCommandLine("git  log -1 --format='%h %s'"), ["log", "-1", "--format=%h %s"], "a leading git, and single quotes");
  assert.deepStrictEqual(parseCommandLine(`commit -m "say \\"hi\\" \\\\ there"`), ["commit", "-m", `say "hi" \\ there`]);
  assert.deepStrictEqual(parseCommandLine(`grep -e ""`), ["grep", "-e", ""], "an empty quoted word is a word");
  assert.strictEqual(parseCommandLine("log 'oops"), "A quote is not closed.");
  assert.strictEqual(parseCommandLine("  git "), "Type a git command, for example: status -sb");
  assert.deepStrictEqual(parseCommandLine("status; rm -rf /"), ["status;", "rm", "-rf", "/"], "no shell: ; is just a character git rejects");
  console.log("ok - a command line is split as a shell would, without one");
}

{
  for (const ro of ["status -sb", "log --oneline -5", "diff --stat", "branch", "branch -vv", "branch --list feat*", "tag -l v1.*", "remote -v", "stash list", "config --get user.email", "worktree list", "rev-parse HEAD"]) {
    assert.ok(isReadOnly(parseCommandLine(ro) as string[]), ro);
  }
  for (const rw of ["fetch --prune", "pull", "checkout main", "branch topic", "branch -D topic", "tag v1.4.0", "remote add up x", "stash", "stash pop", "config user.email x", "-c x=y status", "diff --output=x", "worktree prune", "gc"]) {
    assert.ok(!isReadOnly(parseCommandLine(rw) as string[]), rw);
  }
  console.log("ok - commands that only read run at once; anything that may write is asked first");
}

{
  const report = runReport("status -sb", [
    { repo: "acme-web", code: 0, stdout: "## main\n", stderr: "" },
    { repo: "acme-api", code: 128, stdout: "", stderr: "fatal: not a git repository\n" },
    { repo: "acme-libs", code: 0, stdout: "", stderr: "" },
  ]);
  assert.strictEqual(report, "$ git status -sb\n3 repositories, 1 failed.\n\n── acme-api (exit 128) ──\nfatal: not a git repository\n\n── acme-web ──\n## main\n\n── acme-libs ──\n(no output)\n");
  assert.strictEqual(commandText(["log", "--format=%h %s", "-1"]), `log "--format=%h %s" -1`);
  console.log("ok - the report lists failures first, each repository under its name");
}

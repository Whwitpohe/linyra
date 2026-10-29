// The Repo List's marks and a stopped merge, rebase, cherry-pick or revert, on the fixture
// repositories: each repository's branch and * + !, a merge stopped by a terminal's git, Continue
// once resolved, Abort, and Abort in All Repositories. Every HEAD and file is put back afterwards.
import * as assert from "assert";
import * as vscode from "vscode";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { ALL, send, snapshot, until } from "./helpers";

describe("Repo List marks", () => {
  let repos: { id: string; root: string; name: string }[] = [];
  const heads = new Map<string, string>();
  const ID = { GIT_AUTHOR_NAME: "dana", GIT_AUTHOR_EMAIL: "dana@example.com", GIT_COMMITTER_NAME: "dana", GIT_COMMITTER_EMAIL: "dana@example.com" };
  const git = (root: string, args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...ID, GIT_EDITOR: ":" } }).trim();
  const stops = (root: string, args: string[]) => assert.throws(() => git(root, args), Error, `${args.join(" ")} stops on a conflict`);
  const answer = (value: string | undefined) => vscode.commands.executeCommand("linyra._itest.answer", value);
  const repo = (name: string) => repos.find((r) => r.name === name)!;
  const write = (name: string, file: string, text: string) => fs.writeFileSync(path.join(repo(name).root, file), text);

  /** A side branch and main both change ci-marks.txt: merging it into main stops on a conflict. */
  const conflictingSides = (name: string) => {
    const root = repo(name).root;
    git(root, ["checkout", "-q", "-b", "ci-side", "--"]);
    write(name, "ci-marks.txt", "side\n");
    git(root, ["add", "ci-marks.txt"]);
    git(root, ["commit", "-qm", "test: side"]);
    git(root, ["checkout", "-q", "main", "--"]);
    write(name, "ci-marks.txt", "main\n");
    git(root, ["add", "ci-marks.txt"]);
    git(root, ["commit", "-qm", "test: main"]);
  };

  before(async () => {
    await vscode.commands.executeCommand("linyra.open");
    await until("the Log webview", (s) => s.readyCount >= 1 && s.repos.length === 3);
    await send({ type: "logMode", mode: "commits" });
    await send({ type: "filter", filter: ALL });
    repos = (await snapshot()).repos;
    for (const r of repos) heads.set(r.id, git(r.root, ["rev-parse", "HEAD"]));
  });

  after(async () => {
    await answer(undefined);
    for (const r of repos) {
      for (const op of ["merge", "cherry-pick", "rebase"]) {
        try { git(r.root, [op, "--abort"]); } catch { /* none in progress */ }
      }
      git(r.root, ["checkout", "-q", "-f", "main", "--"]);
      git(r.root, ["reset", "-q", "--hard", heads.get(r.id)!]);
      try { git(r.root, ["branch", "-D", "ci-side"]); } catch { /* not created */ }
      fs.rmSync(path.join(r.root, "ci-marks.txt"), { force: true });
    }
    await send({ type: "refresh" });
    await until("no operation left", (s) => Object.values(s.marks).every((m) => !m.operation));
  });

  it("names each repository's branch, from the git dir's files", async () => {
    const s = await until("a mark for every repository", (x) => Object.keys(x.marks).length === 3);
    for (const r of repos) {
      assert.strictEqual(s.marks[r.id].branch, "main", r.name);
      assert.strictEqual(s.marks[r.id].operation, undefined);
    }
  });

  it("shows a merge a terminal's git stopped, and continues it once the conflict is resolved", async () => {
    conflictingSides("acme-web");
    const web = repo("acme-web");
    stops(web.root, ["merge", "--no-edit", "ci-side"]);
    // Nothing of Linyra's ran the merge: VS Code's Git reporting it (or a focus) reads the git dir again.
    await send({ type: "refresh" });
    let m = await until("acme-web merging with a conflict", (s) => s.marks[web.id]?.operation === "merge" && s.marks[web.id]?.work?.conflicts === 1);
    assert.strictEqual(m.marks[web.id].branch, "main");

    // Continue refuses while a file still has conflicts.
    await vscode.commands.executeCommand("linyra.continueMerge", { repoId: web.id });
    assert.match(String(await vscode.commands.executeCommand("linyra._itest.operationError")), /still have conflicts/);
    assert.ok(fs.existsSync(path.join(web.root, ".git", "MERGE_HEAD")), "the merge is still in progress");

    // A command for another operation than the repository's does nothing.
    await vscode.commands.executeCommand("linyra.abortRebase", { repoId: web.id });
    assert.ok(fs.existsSync(path.join(web.root, ".git", "MERGE_HEAD")));

    write("acme-web", "ci-marks.txt", "both\n");
    git(web.root, ["add", "ci-marks.txt"]);
    await vscode.commands.executeCommand("linyra.continueMerge", { repoId: web.id });
    assert.strictEqual(await vscode.commands.executeCommand("linyra._itest.operationError"), undefined);
    assert.strictEqual(git(web.root, ["rev-list", "--count", "--merges", "-1", "HEAD"]), "1", "a merge commit, with the message git prepared");
    assert.match(git(web.root, ["log", "-1", "--format=%s"]), /Merge branch 'ci-side'/);
    m = await until("acme-web no longer merging", (s) => s.marks[web.id]?.operation === undefined);
    assert.strictEqual(m.marks[web.id].branch, "main");
  });

  it("aborts after asking: the branch and the working tree go back", async () => {
    const web = repo("acme-web");
    git(web.root, ["reset", "-q", "--hard", "HEAD~1"]);
    const before = git(web.root, ["rev-parse", "HEAD"]);
    stops(web.root, ["merge", "--no-edit", "ci-side"]);
    await send({ type: "refresh" });
    await until("acme-web merging", (s) => s.marks[web.id]?.operation === "merge");

    await answer("Cancel");
    await vscode.commands.executeCommand("linyra.abortMerge", { repoId: web.id });
    assert.ok(fs.existsSync(path.join(web.root, ".git", "MERGE_HEAD")), "declined: nothing aborted");

    await answer("Abort Merge");
    await vscode.commands.executeCommand("linyra.abortMerge", { repoId: web.id });
    assert.strictEqual(await vscode.commands.executeCommand("linyra._itest.lastWarning"), "Abort the merge in acme-web?");
    assert.ok(!fs.existsSync(path.join(web.root, ".git", "MERGE_HEAD")));
    assert.strictEqual(git(web.root, ["rev-parse", "HEAD"]), before);
    assert.strictEqual(git(web.root, ["status", "--porcelain"]), "");
    await until("acme-web no longer merging", (s) => s.marks[web.id]?.operation === undefined);
  });

  it("aborts a merge and a cherry-pick in two repositories at once", async () => {
    const web = repo("acme-web"), api = repo("acme-api");
    stops(web.root, ["merge", "--no-edit", "ci-side"]);
    conflictingSides("acme-api");
    stops(api.root, ["cherry-pick", "ci-side"]);
    await send({ type: "refresh" });
    await until("two repositories in the middle of something", (s) => s.marks[web.id]?.operation === "merge" && s.marks[api.id]?.operation === "cherry-pick");

    await answer(JSON.stringify(["acme-web", "acme-api"]));
    await answer("Abort All");
    await vscode.commands.executeCommand("linyra.abortAll");
    assert.strictEqual(await vscode.commands.executeCommand("linyra._itest.operationError"), undefined);
    assert.ok(!fs.existsSync(path.join(web.root, ".git", "MERGE_HEAD")));
    assert.ok(!fs.existsSync(path.join(api.root, ".git", "CHERRY_PICK_HEAD")));
    await until("both back", (s) => s.marks[web.id]?.operation === undefined && s.marks[api.id]?.operation === undefined);
  });
});

// Branches across repositories, Push… and Update Project on the three fixture repositories; every
// ref, remote and HEAD it moves is put back afterwards (runs last but one, see index.ts).
import * as assert from "assert";
import * as vscode from "vscode";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { MultiResult } from "../multiRepo";
import type { RunResult } from "../runAcrossModel";
import { ALL, send, snapshot, until } from "./helpers";

describe("Across repositories", () => {
  let repos: { id: string; root: string; name: string }[] = [];
  const heads = new Map<string, string>();
  let home: string;
  const ID = { GIT_AUTHOR_NAME: "dana", GIT_AUTHOR_EMAIL: "dana@example.com", GIT_COMMITTER_NAME: "dana", GIT_COMMITTER_EMAIL: "dana@example.com" };
  const git = (root: string, args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...ID } }).trim();
  const answer = (value: string) => vscode.commands.executeCommand("linyra._itest.answer", value);
  const run = (command: string) => vscode.commands.executeCommand<MultiResult | undefined>(`linyra.${command}`);
  const repo = (name: string) => repos.find((r) => r.name === name)!;
  const current = (name: string) => git(repo(name).root, ["branch", "--show-current"]);

  before(async () => {
    await vscode.commands.executeCommand("linyra.open");
    await until("the Log webview", (s) => s.readyCount >= 1 && s.repos.length === 3);
    // An earlier suite may have left the Log on its Uncommitted side (Show Uncommitted Changes).
    await send({ type: "logMode", mode: "commits" });
    await send({ type: "filter", filter: ALL });
    repos = (await snapshot()).repos;
    for (const r of repos) heads.set(r.id, git(r.root, ["rev-parse", "HEAD"]));
    home = fs.mkdtempSync(path.join(os.tmpdir(), "linyra-multi-itest-"));
  });

  after(async () => {
    await vscode.commands.executeCommand("linyra._itest.answer", undefined);
    for (const r of repos) {
      try { git(r.root, ["merge", "--abort"]); } catch { /* none in progress */ }
      git(r.root, ["checkout", "-f", "main", "--"]);
      git(r.root, ["reset", "-q", "--hard", heads.get(r.id)!]);
      try { git(r.root, ["branch", "-D", "ci-shared"]); } catch { /* not created */ }
      try { git(r.root, ["branch", "-D", "ci-force"]); } catch { /* not created */ }
      try { git(r.root, ["tag", "-d", "ci-v1"]); } catch { /* not created */ }
      try { git(r.root, ["branch", "-D", "ci-smart"]); } catch { /* not created */ }
      try { git(r.root, ["branch", "-D", "ci-run"]); } catch { /* not created */ }
      // Only the stashes Smart Checkout left, by their own names (newest last, so the indexes stay right).
      for (const [ref, subject] of git(r.root, ["stash", "list", "--format=%gd%x09%gs"]).split("\n").filter(Boolean).map((l) => l.split("\t")).reverse()) {
        if (subject?.includes("Smart Checkout")) git(r.root, ["stash", "drop", "-q", ref]);
      }
      try { git(r.root, ["remote", "remove", "ci-origin"]); } catch { /* not added */ }
    }
    await send({ type: "refresh" });
    await until("the fixture log again", (s) => s.rows.length === 6);
  });

  it("creates, checks out and merges one branch name in every ticked repository", async () => {
    await answer("New Branch…"); await answer("ci-shared");
    let r = await run("branchesAcross");
    assert.deepStrictEqual(r?.done.sort(), ["acme-api", "acme-libs", "acme-web"]);
    assert.ok(repos.every((x) => current(x.name) === "ci-shared"));

    await answer("Check Out Branch…"); await answer("main"); await answer("Check Out");
    r = await run("branchesAcross");
    assert.strictEqual(r?.done.length, 3);
    assert.ok(repos.every((x) => current(x.name) === "main"));

    // A commit on ci-shared in acme-api only; merging it into main everywhere fast-forwards api, the others are already there.
    const api = repo("acme-api").root;
    git(api, ["checkout", "-q", "ci-shared", "--"]);
    fs.writeFileSync(path.join(api, "shared.txt"), "shared\n");
    git(api, ["add", "shared.txt"]); git(api, ["commit", "-q", "-m", "feat: shared change"]);
    git(api, ["checkout", "-q", "main", "--"]);
    await answer("Merge into Current…"); await answer("ci-shared"); await answer("Merge");
    r = await run("branchesAcross");
    assert.strictEqual(r?.skipped.length, 0, JSON.stringify(r?.skipped));
    assert.ok(fs.existsSync(path.join(api, "shared.txt")));
    assert.strictEqual(git(api, ["branch", "--show-current"]), "main");
    await until("the merged commit listed", (s) => s.rows.some((c) => c.subject === "feat: shared change"));
  });

  it("Push… sends the picked repositories' outgoing commits, with an upstream for a new branch", async () => {
    const web = repo("acme-web").root;
    const remote = path.join(home, "web.git");
    git(home, ["init", "-q", "--bare", remote]);
    git(web, ["remote", "add", "ci-origin", remote]);
    fs.writeFileSync(path.join(web, "push.txt"), "push\n");
    git(web, ["add", "push.txt"]); git(web, ["commit", "-q", "-m", "feat: to push"]);
    await answer(JSON.stringify(["acme-web"]));
    const r = await run("pushAll");
    assert.deepStrictEqual(r?.done, ["acme-web"]);
    assert.strictEqual(git(remote, ["log", "-1", "--format=%s", "main"]), "feat: to push");
    assert.strictEqual(git(web, ["rev-parse", "--abbrev-ref", "main@{upstream}"]), "ci-origin/main", "a branch without upstream gets one");
  });

  it("Update Project fetches, then merges what came in, and names repositories without an upstream", async () => {
    const web = repo("acme-web").root;
    const tip = git(web, ["rev-parse", "HEAD"]);
    git(web, ["reset", "-q", "--hard", "HEAD~1"]); // one commit behind ci-origin/main
    await answer("Merge incoming changes");
    let r = await run("updateProject");
    assert.deepStrictEqual(r?.done, ["acme-web"]);
    assert.strictEqual(git(web, ["rev-parse", "HEAD"]), tip);
    assert.deepStrictEqual(r?.skipped.map((s) => s.name).sort(), ["acme-api", "acme-libs"], "no upstream there");
    // Nothing behind any more: already up to date, not "done in 0".
    await answer("Merge incoming changes");
    r = await run("updateProject");
    assert.deepStrictEqual([r?.done, r?.unchanged, r?.stopped], [[], ["acme-web"], []]);
  });

  it("Update Project also fast-forwards a branch that is not checked out and only behind its upstream, without a checkout", async () => {
    const web = repo("acme-web").root;
    // ci-release: pushed with one more commit on ci-origin, then one commit behind it locally.
    git(web, ["switch", "-q", "-c", "ci-release"]);
    fs.writeFileSync(path.join(web, "release.txt"), "fix\n");
    git(web, ["add", "release.txt"]); git(web, ["commit", "-q", "-m", "fix: on the release"]);
    git(web, ["push", "-q", "-u", "ci-origin", "ci-release"]);
    const pushed = git(web, ["rev-parse", "HEAD"]);
    git(web, ["reset", "-q", "--hard", "HEAD~1"]);
    git(web, ["switch", "-q", "main"]);
    const main = git(web, ["rev-parse", "HEAD"]);
    try {
      await answer("Merge incoming changes");
      const r = await run("updateProject");
      assert.deepStrictEqual(r?.forwarded, [{ name: "acme-web", branches: ["ci-release"] }]);
      assert.strictEqual(git(web, ["rev-parse", "ci-release"]), pushed, "moved to its upstream");
      assert.deepStrictEqual([git(web, ["branch", "--show-current"]), git(web, ["rev-parse", "HEAD"]), git(web, ["status", "--porcelain"])], ["main", main, ""], "the checked-out branch and the working tree untouched");
      assert.ok(!fs.existsSync(path.join(web, "release.txt")));
    } finally {
      git(web, ["branch", "-q", "-D", "ci-release"]);
      git(web, ["push", "-q", "ci-origin", "--delete", "ci-release"]);
    }
  });

  it("Update Project: fast-forward only leaves a diverged branch alone; a conflict is reported as stopped; 📌 stops the question", async () => {
    const web = repo("acme-web").root;
    const config = () => vscode.workspace.getConfiguration("linyra");
    const tip = git(web, ["rev-parse", "HEAD"]);
    // Diverged: a local commit, and one more on ci-origin/main, touching the same file.
    git(web, ["switch", "-q", "-c", "ci-other"]);
    fs.writeFileSync(path.join(web, "push.txt"), "theirs\n");
    git(web, ["commit", "-q", "-am", "feat: theirs"]);
    git(web, ["push", "-q", "ci-origin", "HEAD:main"]);
    git(web, ["switch", "-q", "main"]);
    git(web, ["branch", "-q", "-D", "ci-other"]);
    fs.writeFileSync(path.join(web, "push.txt"), "mine\n");
    git(web, ["commit", "-q", "-am", "feat: mine"]);
    const mine = git(web, ["rev-parse", "HEAD"]);
    try {
      // The last method comes first; fast-forward only does not touch a diverged branch.
      await answer("Fast-forward only");
      let r = await run("updateProject");
      assert.deepStrictEqual(r?.done, []);
      assert.deepStrictEqual(r?.skipped.find((s) => s.name === "acme-web")?.reason, "it has diverged from its upstream: merge or rebase it");
      assert.strictEqual(git(web, ["rev-parse", "HEAD"]), mine, "left as it was");
      // Merge stops on the conflict: reported as stopped (mid-merge), not as "left as it was". The pin sets the method.
      await answer("Merge incoming changes|button");
      r = await run("updateProject");
      assert.deepStrictEqual(r?.stopped.map((s) => s.name), ["acme-web"]);
      assert.ok(!r?.skipped.some((s) => s.name === "acme-web"));
      assert.ok(fs.existsSync(path.join(web, ".git", "MERGE_HEAD")), "mid-merge");
      git(web, ["merge", "--abort"]);
      assert.strictEqual(config().get("updateMethod"), "merge", "📌: the setting");
      // Set: no question (nothing queued to answer it), the same method.
      const asked = await vscode.commands.executeCommand<number>("linyra._itest.asked");
      r = await run("updateProject");
      assert.strictEqual(await vscode.commands.executeCommand<number>("linyra._itest.asked"), asked, "not asked");
      assert.deepStrictEqual(r?.stopped.map((s) => s.name), ["acme-web"]);
      git(web, ["merge", "--abort"]);
    } finally {
      await config().update("updateMethod", undefined, vscode.ConfigurationTarget.Global);
      try { git(web, ["merge", "--abort"]); } catch { /* none */ }
      git(web, ["reset", "-q", "--hard", tip]);
      git(web, ["push", "-q", "-f", "ci-origin", "HEAD:main"]);
      git(web, ["fetch", "-q", "ci-origin"]);
    }
  });

  it("Push… force pushes a diverged branch with a lease after asking, and never main", async () => {
    const web = repo("acme-web").root;
    const remote = path.join(home, "web.git");
    // main amended after it was pushed: protected, so it is named and left as it was.
    git(web, ["commit", "-q", "--amend", "-m", "feat: to push, amended"]);
    let r = await run("pushAll");
    assert.deepStrictEqual(r?.done, []);
    assert.match(r?.skipped.find((s) => s.name === "acme-web")?.reason ?? "", /protected branch is never force pushed/);
    assert.strictEqual(git(remote, ["log", "-1", "--format=%s", "main"]), "feat: to push");
    git(web, ["reset", "-q", "--hard", "ci-origin/main"]);

    git(web, ["switch", "-q", "-c", "ci-force"]);
    fs.writeFileSync(path.join(web, "force.txt"), "one\n");
    git(web, ["add", "force.txt"]); git(web, ["commit", "-q", "-m", "feat: force"]);
    git(web, ["push", "-q", "-u", "ci-origin", "ci-force"]);
    git(web, ["commit", "-q", "--amend", "-m", "feat: force, amended"]);
    await answer(JSON.stringify(["acme-web"])); await answer("Cancel");
    r = await run("pushAll");
    assert.strictEqual(r, undefined, "declined: nothing pushed");
    assert.strictEqual(git(remote, ["log", "-1", "--format=%s", "ci-force"]), "feat: force");

    await answer(JSON.stringify(["acme-web"])); await answer("Force Push");
    r = await run("pushAll");
    assert.deepStrictEqual(r?.done, ["acme-web"]);
    assert.strictEqual(await vscode.commands.executeCommand("linyra._itest.lastWarning"), "Force push ci-force to ci-origin/ci-force in acme-web?");
    assert.strictEqual(git(remote, ["log", "-1", "--format=%s", "ci-force"]), "feat: force, amended");

    // Someone else pushed meanwhile: diverged too, but the commit dropped would be rin's.
    const rins = execFileSync("git", ["commit-tree", "-p", "ci-origin/ci-force", "-m", "fix: rin's work", "HEAD^{tree}"], { cwd: web, encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_NAME: "rin", GIT_AUTHOR_EMAIL: "rin@example.com", GIT_COMMITTER_NAME: "rin", GIT_COMMITTER_EMAIL: "rin@example.com" } }).trim();
    git(web, ["push", "-q", "ci-origin", `${rins}:refs/heads/ci-force`]);
    git(web, ["fetch", "-q", "ci-origin"]);
    git(web, ["commit", "-q", "--amend", "-m", "feat: force, amended again"]);
    await answer(JSON.stringify(["acme-web"])); await answer("Force Push");
    r = await run("pushAll");
    assert.strictEqual(r, undefined, "the button is Force Push Anyway: a plain yes is not enough");
    assert.strictEqual(git(remote, ["log", "-1", "--format=%s", "ci-force"]), "fix: rin's work", "rin's commit is still there");
    await answer(JSON.stringify(["acme-web"])); await answer("Force Push Anyway");
    r = await run("pushAll");
    assert.deepStrictEqual(r?.done, ["acme-web"]);
    assert.strictEqual(git(remote, ["log", "-1", "--format=%s", "ci-force"]), "feat: force, amended again");
    git(web, ["switch", "-q", "main"]);
  });

  it("Tag Across Repositories… tags each checked-out commit and pushes where there is a remote", async () => {
    await answer(JSON.stringify({ name: "ci-v1", message: "Release ci-v1", push: true }));
    const r = await run("tagAcross");
    type LastForm = { spec: { title: string; fields: { id: string; label: string }[] }; problems: Record<string, string> };
    const form = await vscode.commands.executeCommand<LastForm>("linyra._itest.lastForm");
    assert.deepStrictEqual(form.spec.fields.map((f) => f.label), ["Tag name", "Message (optional)", "Push the tag to each repository's remote", "Repositories"], "one form, no \"lightweight\"");
    assert.deepStrictEqual(r?.done, ["acme-web"]);
    assert.deepStrictEqual(r?.skipped.map((s) => `${s.name}: ${s.reason}`).sort(), ["acme-api: tagged, but it has no remote to push to", "acme-libs: tagged, but it has no remote to push to"]);
    for (const x of repos) {
      assert.strictEqual(git(x.root, ["cat-file", "-t", "ci-v1"]), "tag", `${x.name}: annotated`);
      assert.strictEqual(git(x.root, ["rev-parse", "ci-v1^{commit}"]), git(x.root, ["rev-parse", "HEAD"]));
    }
    assert.strictEqual(git(path.join(home, "web.git"), ["for-each-ref", "--format=%(contents:subject)", "refs/tags/ci-v1"]), "Release ci-v1");

    // Every ticked repository has it already: refused in the form, nothing runs.
    await answer(JSON.stringify({ name: "ci-v1" }));
    assert.strictEqual(await run("tagAcross"), undefined);
    assert.deepStrictEqual((await vscode.commands.executeCommand<LastForm>("linyra._itest.lastForm")).problems, { name: "Every ticked repository already has ci-v1." });
    // One of them untagged again: that one is tagged, the others keep their own, named.
    git(repo("acme-libs").root, ["tag", "-d", "ci-v1"]);
    await answer(JSON.stringify({ name: "ci-v1", push: false }));
    const again = await run("tagAcross");
    assert.deepStrictEqual(again?.done, ["acme-libs"]);
    assert.deepStrictEqual(again?.skipped.map((s) => s.reason), ["the tag already exists", "the tag already exists"], "each keeps its own");
  });

  it("Branches Across Repositories offers Smart Checkout where local changes are in the way", async () => {
    const web = repo("acme-web").root;
    const smart = path.join(web, "smart.txt");
    fs.writeFileSync(smart, "1\n2\n3\n");
    git(web, ["add", "smart.txt"]); git(web, ["commit", "-q", "-m", "test: smart base"]);
    for (const x of repos) git(x.root, ["branch", "ci-smart"]);
    git(web, ["switch", "-q", "ci-smart"]);
    fs.writeFileSync(smart, "one\n2\n3\n");
    git(web, ["commit", "-q", "-am", "test: smart branch"]);
    git(web, ["switch", "-q", "main"]);
    fs.writeFileSync(smart, "1\n2\nthree\n"); // in the branch's way, but not on its line

    await answer("Check Out Branch…"); await answer("ci-smart"); await answer("Check Out"); await answer("Smart Checkout");
    const r = await run("branchesAcross");
    assert.deepStrictEqual(r?.done.sort(), ["acme-api", "acme-libs", "acme-web"]);
    assert.deepStrictEqual(r?.skipped, []);
    assert.strictEqual(await vscode.commands.executeCommand("linyra._itest.lastWarning"), "Local changes in acme-web would be overwritten by checking out ci-smart.");
    assert.ok(repos.every((x) => current(x.name) === "ci-smart"));
    assert.strictEqual(fs.readFileSync(smart, "utf8").replace(/\r\n/g, "\n"), "one\n2\nthree\n", "the branch's line and the local edit");
    assert.strictEqual(git(web, ["stash", "list"]), "", "put back: no stash left");
    for (const x of repos) git(x.root, ["switch", "-q", "-f", "main"]);
  });

  it("Run Git Command Across Repositories…: a reading command at once, one that writes after asking, each repository's answer", async () => {
    const across = (line: string) => vscode.commands.executeCommand<RunResult[] | undefined>("linyra._itest.runAcross", line);
    const asked = () => vscode.commands.executeCommand<number>("linyra._itest.asked");
    const before = await asked();
    let r = await across("rev-parse --abbrev-ref HEAD");
    assert.strictEqual(await asked(), before, "reads: nothing asked");
    assert.deepStrictEqual(r?.map((x) => `${x.repo} ${x.code} ${x.stdout.trim()}`).sort(), ["acme-api 0 main", "acme-libs 0 main", "acme-web 0 main"]);

    await answer("Cancel");
    assert.strictEqual(await across("branch ci-run"), undefined, "declined: not run");
    assert.ok(repos.every((x) => git(x.root, ["branch", "--list", "ci-run"]) === ""));
    await answer("Run");
    r = await across("branch ci-run");
    assert.strictEqual(await vscode.commands.executeCommand("linyra._itest.lastWarning"), "Run “git branch ci-run” in 3 repositories?");
    assert.ok(r?.every((x) => x.code === 0));
    assert.ok(repos.every((x) => git(x.root, ["branch", "--list", "ci-run"]).endsWith("ci-run")));

    await answer("Run");
    r = await across("switch no-such-branch");
    assert.ok(r?.every((x) => x.code !== 0 && /invalid reference|no-such-branch/.test(x.stderr)), "each repository's own error, in full");
  });
});

// Branches across repositories, Push… and Update Project on the three fixture repositories; every
// ref, remote and HEAD it moves is put back afterwards (runs last but one, see index.ts).
import * as assert from "assert";
import * as vscode from "vscode";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { MultiResult } from "../multiRepo";
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
    const r = await run("updateProject");
    assert.deepStrictEqual(r?.done, ["acme-web"]);
    assert.strictEqual(git(web, ["rev-parse", "HEAD"]), tip);
    assert.deepStrictEqual(r?.skipped.map((s) => s.name).sort(), ["acme-api", "acme-libs"], "no upstream there");
  });
});

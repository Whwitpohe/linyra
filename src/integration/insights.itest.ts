// Linyra Insights on the fixture repositories: each tab reads only when shown, one git process per
// repository, and nothing again until the scope, the range or a repository changes.
import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { InsightsHostMessage } from "../insights/protocol";
import type { InsightsScope, InsightsTab } from "../insights/range";
import { ALL, send, snapshot, until, waitFor } from "./helpers";

interface InsightsSnapshot { open: boolean; visible: boolean; tab: InsightsTab; scope: InsightsScope; reading: InsightsTab[]; posted: InsightsHostMessage[]; spawned: { root: string; args: string[] }[]; lastWrite: { repo: string; command: string; error?: string }[] }
const insights = () => vscode.commands.executeCommand<InsightsSnapshot>("linyra._itest.insights");
const tell = (m: unknown) => vscode.commands.executeCommand("linyra._itest.insightsSend", m);
type Ready<T extends InsightsHostMessage["type"]> = Extract<InsightsHostMessage, { type: T }> & { status: "ready" };

describe("Insights", () => {
  let repos: { id: string; root: string; name: string }[] = [];
  const heads = new Map<string, string>();
  const ID = { GIT_AUTHOR_NAME: "dana", GIT_AUTHOR_EMAIL: "dana@example.com", GIT_COMMITTER_NAME: "dana", GIT_COMMITTER_EMAIL: "dana@example.com" };
  const git = (root: string, args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...ID } }).trim();
  const repo = (name: string) => repos.find((r) => r.name === name)!;
  /** The posts after `from`, and the git processes Insights started after `spawnedFrom`. */
  let posted = 0, spawned = 0;
  const mark = async () => { const s = await insights(); posted = s.posted.length; spawned = s.spawned.length; };
  const sinceMark = async () => { const s = await insights(); return { posts: s.posted.slice(posted), spawns: s.spawned.slice(spawned) }; };
  /** The latest "ready" answer of a type after the mark (that `ok` accepts: a read superseded on the way may answer first). */
  const answer = <T extends "history" | "tree" | "health">(type: T, ok: (m: Ready<T>) => boolean = () => true) => waitFor(`an Insights ${type} answer`, async () => {
    const { posts } = await sinceMark();
    const last = posts.reverse().find((m): m is Ready<T> => m.type === type && m.status === "ready");
    return last && ok(last) ? last : undefined;
  });
  /** VS Code's Git looks at the repository now (its watcher may take a while to notice a terminal's commit). */
  const vscodeGitStatus = async (root: string) => {
    const api = (await vscode.extensions.getExtension<{ getAPI(v: 1): { getRepository(uri: vscode.Uri): { status(): Promise<void> } | null } }>("vscode.git")!.activate()).getAPI(1);
    await api.getRepository(vscode.Uri.file(root))?.status();
  };
  const quiet = async () => {
    await waitFor("Insights to finish reading", async () => ((await insights()).reading.length === 0 ? true : undefined));
    // A refs change waits 250 ms before reading (several repositories reporting at once).
    await new Promise((r) => setTimeout(r, 400));
  };
  const perRepo = (spawns: { root: string; args: string[] }[]) => {
    const counts: Record<string, string[]> = {};
    for (const s of spawns) (counts[repos.find((r) => r.root === s.root)?.name ?? s.root] ??= []).push(s.args[0]);
    return counts;
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
    await vscode.commands.executeCommand("linyra._itest.answer", undefined);
    for (const r of repos) {
      git(r.root, ["reset", "-q", "--hard", heads.get(r.id)!]);
      fs.rmSync(path.join(r.root, "insights.txt"), { force: true });
      try { git(r.root, ["config", "--local", "--unset", "core.untrackedCache"]); } catch { /* not set */ }
      // git writes the commit-graph read-only, and another git may still hold it open: a leftover is harmless.
      const graph = path.join(r.root, ".git", "objects", "info", "commit-graph");
      try {
        if (fs.existsSync(graph)) { fs.chmodSync(graph, 0o666); fs.rmSync(graph, { force: true }); }
      } catch { /* in use */ }
    }
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  it("opens on Visual History and reads one git log per ticked repository", async () => {
    await mark();
    await vscode.commands.executeCommand("linyra.insights");
    await waitFor("the Insights tab", async () => ((await insights()).open ? true : undefined));
    await tell({ type: "tab", tab: "history" });
    await tell({ type: "range", range: "all" });
    const h = await answer("history", (m) => m.data!.since === undefined);
    await quiet();
    const expected = repos.reduce((n, r) => n + Number(git(r.root, ["rev-list", "--count", "--no-merges", "HEAD"])), 0);
    assert.strictEqual(h.data!.commits.length, expected, "every commit of every ticked repository, in all of history");
    assert.ok(h.data!.commits.every((c) => c.added + c.deleted > 0 && c.files > 0), "each with its lines and files from --numstat");
    const counts = perRepo((await sinceMark()).spawns.filter((s) => s.args[0] === "log"));
    for (const r of repos) assert.ok((counts[r.name] ?? []).length >= 1, `${r.name} was read`);
    // The range change superseded the first read: what counts is that the last answer took one log each.
    await mark();
    await tell({ type: "refresh" });
    await answer("history");
    await quiet();
    assert.deepStrictEqual(perRepo((await sinceMark()).spawns), Object.fromEntries(repos.map((r) => [r.name, ["log"]])), "Refresh: one git log per repository, nothing else");
    const args = (await insights()).spawned.at(-1)!.args;
    assert.ok(args.includes("--numstat") && args.includes("--no-merges") && args.includes("HEAD") && !args.some((a) => a.startsWith("--since")), args.join(" "));
  });

  it("shows what it has again without git: the same tab, one repository of the scope", async () => {
    await mark();
    await tell({ type: "tab", tab: "history" });
    await tell({ type: "scope", scope: { kind: "repo", repoId: repo("acme-web").id } });
    const h = await answer("history");
    await quiet();
    assert.ok(h.data!.commits.every((c) => c.repoId === repo("acme-web").id));
    assert.deepStrictEqual((await sinceMark()).spawns, [], "one repository of what was read reads nothing");
    await tell({ type: "scope", scope: { kind: "ticked" } });
    await answer("history");
  });

  it("reads a range with --since, and a file with its pathspec", async () => {
    await mark();
    await tell({ type: "range", range: "1w" });
    const week = await answer("history", (m) => m.data!.since !== undefined);
    await quiet();
    assert.strictEqual(week.data!.commits.length, 0, "the fixture's commits are older than a week");
    const spawns = (await sinceMark()).spawns;
    assert.strictEqual(spawns.length, repos.length);
    assert.ok(spawns.every((s) => s.args.some((a) => /^--since=\d{4}-\d\d-\d\dT/.test(a))), "an ISO date git reads exactly");
    await tell({ type: "range", range: "all" });
    await answer("history", (m) => m.data!.since === undefined);
    await quiet();

    await mark();
    await vscode.commands.executeCommand("linyra.visualHistory", vscode.Uri.file(path.join(repo("acme-web").root, "client.ts")));
    const file = await answer("history");
    await quiet();
    assert.deepStrictEqual((await insights()).scope, { kind: "path", repoId: repo("acme-web").id, path: "client.ts", folder: false });
    const expected = Number(git(repo("acme-web").root, ["rev-list", "--count", "--no-merges", "HEAD", "--", "client.ts"]));
    assert.strictEqual(file.data!.commits.length, expected);
    const { spawns: fileSpawns } = await sinceMark();
    assert.strictEqual(fileSpawns.length, 1, "one repository, one process");
    assert.deepStrictEqual(fileSpawns[0].args.slice(-2), ["--", ":(literal)client.ts"]);
    await tell({ type: "scope", scope: { kind: "ticked" } });
    await answer("history");
    await quiet();
  });

  it("a commit makes only its repository read again", async () => {
    await mark();
    const web = repo("acme-web");
    fs.writeFileSync(path.join(web.root, "insights.txt"), "one\ntwo\n");
    git(web.root, ["add", "insights.txt"]);
    git(web.root, ["commit", "-qm", "test: insights"]);
    await vscodeGitStatus(web.root);
    const h = await waitFor("the new commit in Visual History", async () => {
      const { posts } = await sinceMark();
      const last = posts.reverse().find((m): m is Ready<"history"> => m.type === "history" && m.status === "ready");
      return last?.data!.commits.some((c) => c.subject === "test: insights") ? last : undefined;
    });
    await quiet();
    const c = h.data!.commits.find((x) => x.subject === "test: insights")!;
    assert.deepStrictEqual([c.added, c.deleted, c.files], [2, 0, 1]);
    assert.deepStrictEqual(perRepo((await sinceMark()).spawns), { "acme-web": ["log"] }, "the other repositories are not read again");
  });

  it("Files: one ls-tree of HEAD per repository, sizes of every tracked file; a folder opens without git", async () => {
    await mark();
    await tell({ type: "tab", tab: "files" });
    const files = await answer("tree", (m) => m.tab === "files");
    await quiet();
    assert.deepStrictEqual(perRepo((await sinceMark()).spawns), Object.fromEntries(repos.map((r) => [r.name, ["ls-tree"]])), "one process per repository");
    assert.ok((await insights()).spawned.at(-1)!.args.join(" ").startsWith("ls-tree -r -l -z HEAD"));
    const d = files.data!;
    assert.strictEqual(d.node.kind, "root");
    assert.deepStrictEqual(d.node.children!.map((c) => c.name).sort(), repos.map((r) => r.name).sort());
    const web = d.node.children!.find((c) => c.name === "acme-web")!;
    const client = web.children!.find((c) => c.name === "client.ts")!;
    assert.strictEqual(client.value, fs.statSync(path.join(repo("acme-web").root, "client.ts")).size, "a file's area is its size at HEAD");
    assert.ok(d.legend.some((l) => l.ext === "ts"));

    await mark();
    await tell({ type: "drill", tab: "files", path: [repo("acme-web").id] });
    const opened = await answer("tree", (m) => m.tab === "files" && m.data!.path.length === 1);
    assert.strictEqual(opened.data!.node.name, "acme-web");
    assert.deepStrictEqual(opened.data!.crumbs, ["Ticked repositories (3)", "acme-web"]);
    await tell({ type: "drill", tab: "files", path: ["no-such-folder"] });
    await tell({ type: "drill", tab: "files", path: [] });
    await answer("tree", (m) => m.tab === "files" && m.data!.path.length === 0);
    assert.deepStrictEqual((await sinceMark()).spawns, [], "opening a folder reads nothing");
  });

  it("Commits: one git log --name-only per repository; switching tabs back reads nothing", async () => {
    await mark();
    await tell({ type: "tab", tab: "commits" });
    const commits = await answer("tree", (m) => m.tab === "commits");
    await quiet();
    assert.deepStrictEqual(perRepo((await sinceMark()).spawns), Object.fromEntries(repos.map((r) => [r.name, ["log"]])));
    const args = (await insights()).spawned.at(-1)!.args;
    assert.ok(args.includes("--name-only") && args.includes("-z") && args.includes("--format=") && args.includes("--no-merges"), args.join(" "));
    const web = commits.data!.node.children!.find((c) => c.name === "acme-web")!;
    const touched = Number(git(repo("acme-web").root, ["rev-list", "--count", "--no-merges", "HEAD", "--", "client.ts"]));
    assert.strictEqual(web.children!.find((c) => c.name === "client.ts")!.value, touched, "a file's area is the commits touching it");
    assert.ok(commits.data!.heat.length > 0 || commits.data!.node.value > 0);

    await mark();
    for (const tab of ["history", "files", "commits", "files", "history"]) await tell({ type: "tab", tab });
    await answer("history");
    await quiet();
    assert.deepStrictEqual((await sinceMark()).spawns, [], "every tab shows what it read, without git");
  });

  it("Health: count-objects and one git config per repository; the commit-graph and the file count from the git dir", async () => {
    await mark();
    await tell({ type: "tab", tab: "health" });
    const h = await answer("health");
    await quiet();
    const counts = perRepo((await sinceMark()).spawns);
    for (const r of repos) assert.deepStrictEqual((counts[r.name] ?? []).sort(), ["config", "count-objects"], `${r.name}: two processes`);
    const web = h.data!.rows.find((r) => r.name === "acme-web")!;
    const cell = (id: string) => web.checks.find((c) => c.id === id)!;
    const files = git(repo("acme-web").root, ["ls-files"]).split("\n").filter(Boolean).length;
    assert.strictEqual(cell("tracked").value, `${files} files`, "the index's own count");
    assert.strictEqual(cell("commitGraph").value, "Missing");
    assert.match(cell("objects").value, /^\d+ loose · \d+ packs? · /);
    assert.strictEqual(cell("untrackedCache").value, "Off");
    assert.strictEqual(cell("maintenance").value, "Not registered");
    assert.deepStrictEqual(web.optimize, [], "a fixture this small has nothing to optimize");
  });

  it("Health writes only after the confirmation, exactly the command it names; declined, nothing is written", async () => {
    const web = repo("acme-web");
    const graph = path.join(web.root, ".git", "objects", "info", "commit-graph");
    const ask = (v: string | undefined) => vscode.commands.executeCommand("linyra._itest.answer", v);

    // Declined: no process at all.
    await mark();
    await ask("Cancel");
    await tell({ type: "health", action: "commitGraph", repoIds: [web.id] });
    assert.deepStrictEqual((await sinceMark()).spawns, []);
    assert.ok(!fs.existsSync(graph));
    assert.strictEqual(await vscode.commands.executeCommand("linyra._itest.lastWarning"), "Write the commit-graph in acme-web?");

    await mark();
    await ask("Write Commit-Graph");
    await tell({ type: "health", action: "commitGraph", repoIds: [web.id] });
    assert.deepStrictEqual((await insights()).lastWrite, [{ repo: "acme-web", command: "git commit-graph write --reachable" }]);
    assert.ok(fs.existsSync(graph), "the commit-graph is written");
    const after = await answer("health", (m) => m.data!.rows.find((r) => r.name === "acme-web")!.checks[0].value === "Present");
    assert.ok(after);
    await quiet();
    const spawns = (await sinceMark()).spawns;
    assert.deepStrictEqual(spawns[0].args, ["commit-graph", "write", "--reachable"]);
    assert.deepStrictEqual(perRepo(spawns.slice(1))["acme-web"].sort(), ["config", "count-objects"], "only the written repository is read again");
    assert.deepStrictEqual(Object.keys(perRepo(spawns)), ["acme-web"]);

    // A setting: git config --local, both ways.
    await ask("Turn On");
    await tell({ type: "health", action: "config", repoIds: [web.id], key: "core.untrackedCache", value: true });
    assert.strictEqual(git(web.root, ["config", "--local", "--get", "core.untrackedCache"]), "true");
    await answer("health", (m) => m.data!.rows.find((r) => r.name === "acme-web")!.checks.find((c) => c.id === "untrackedCache")!.value === "On");
    await ask("Turn Off");
    await tell({ type: "health", action: "config", repoIds: [web.id], key: "core.untrackedCache", value: false });
    assert.strictEqual(git(web.root, ["config", "--local", "--get", "core.untrackedCache"]), "false");
    assert.strictEqual(await vscode.commands.executeCommand("linyra._itest.lastWarning"), "Set core.untrackedCache to false in acme-web?");
    // Not one of Health's keys: refused before anything is asked.
    await mark();
    await tell({ type: "health", action: "config", repoIds: [web.id], key: "core.hooksPath", value: true });
    assert.deepStrictEqual((await sinceMark()).spawns, []);

    // Maintenance: the tasks picked, then the confirmation.
    await ask(JSON.stringify(["loose-objects"]));
    await ask("Run Maintenance");
    await tell({ type: "health", action: "maintenance", repoIds: [web.id] });
    assert.deepStrictEqual((await insights()).lastWrite, [{ repo: "acme-web", command: "git maintenance run --task=loose-objects" }]);
    await quiet();

    // Optimize Selected over small repositories: nothing recommended, nothing asked, nothing written.
    await mark();
    const asked = Number(await vscode.commands.executeCommand("linyra._itest.asked"));
    await tell({ type: "health", action: "optimize", repoIds: repos.map((r) => r.id) });
    assert.strictEqual(Number(await vscode.commands.executeCommand("linyra._itest.asked")), asked);
    assert.deepStrictEqual((await sinceMark()).spawns, []);

    // Copy Command: git maintenance start, for a terminal; Linyra runs nothing.
    await tell({ type: "health", action: "copy", repoIds: [web.id] });
    assert.strictEqual(await vscode.commands.executeCommand("linyra._itest.clipboard"), `git -C "${web.root}" maintenance start`);
    assert.deepStrictEqual((await sinceMark()).spawns, []);
  });

  it("a bubble's click shows the commit in the Log", async () => {
    const h = (await insights()).posted.filter((m): m is Ready<"history"> => m.type === "history" && m.status === "ready").at(-1)!;
    const c = h.data!.commits.find((x) => x.subject === "test: insights")!;
    await send({ type: "refresh" });
    await until("the new commit listed", (s) => s.rows.some((r) => r.sha === c.sha));
    await tell({ type: "reveal", repoId: c.repoId, sha: c.sha });
    await until("its details in the Changes view", (s) => s.changes.description.includes(c.sha.slice(0, 7)));
    await tell({ type: "reveal", repoId: c.repoId, sha: "not-a-sha" });
    await tell({ type: "reveal", repoId: "/elsewhere", sha: c.sha });
  });
});

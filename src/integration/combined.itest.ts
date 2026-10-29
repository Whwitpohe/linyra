// Combined Changes: several selected commits as one tree (runs after compare.itest, see index.ts).
import * as assert from "assert";
import * as vscode from "vscode";
import { snapshot, send, sleep, ALL, waitFor, until, diffTab, closeEditors } from "./helpers";

describe("Combined Changes", () => {
  before(async () => {
    await vscode.commands.executeCommand("linyra.open");
    await until("the Log webview", (s) => s.readyCount >= 1 && s.repos.length === 3);
    // An earlier suite may have left the Log on its Uncommitted side (Show Uncommitted Changes).
    await send({ type: "logMode", mode: "commits" });
    await send({ type: "filter", filter: ALL });
  });

  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  const cp = require("child_process") as typeof import("child_process");
  const heads = new Map<string, string>();
  let web: { id: string; root: string };
  let api: { id: string; root: string };
  const sha: Record<string, string> = {};
  const lines = (n: number, edit: Record<number, string> = {}) => Array.from({ length: n }, (_, i) => edit[i + 1] ?? `L${i + 1}`).join("\n") + "\n";
  const css = (size: string, more = "") => `.title {\n  font-size: ${size};\n  margin: 0;\n}\n${more}`;
  let t = 1758000000 + 5000;
  function commit(root: string, name: string, author: "dana" | "rin", files: Record<string, string | null>): void {
    for (const [f, content] of Object.entries(files)) {
      const p = path.join(root, f);
      if (content === null) fs.rmSync(p);
      else {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content);
      }
    }
    const date = `@${t++} +0000`;
    const env = { ...process.env, GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: `${author}@example.com`, GIT_AUTHOR_DATE: date, GIT_COMMITTER_NAME: author, GIT_COMMITTER_EMAIL: `${author}@example.com`, GIT_COMMITTER_DATE: date };
    cp.execFileSync("git", ["add", "-A"], { cwd: root, env });
    cp.execFileSync("git", ["commit", "-q", "-m", name], { cwd: root, env });
    sha[name] = cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();
  }
  const git = (root: string, ...args: string[]) => cp.execFileSync("git", args, { cwd: root }).toString();
  const ref = (name: string, root: { id: string }) => ({ repoId: root.id, sha: sha[name] });
  const changes = () => snapshot().then((s) => s.changes);

  before(async () => {
    await send({ type: "filter", filter: ALL });
    // The suites before rewrote the repositories behind the Log's back: read them again (the same
    // filter again reads nothing, see sameFilter).
    await send({ type: "refresh" });
    const s = await until("six rows", (x) => x.rows.length === 6);
    web = s.repos.find((r) => r.name === "acme-web")!;
    api = s.repos.find((r) => r.name === "acme-api")!;
    for (const r of [web, api]) heads.set(r.root, git(r.root, "rev-parse", "HEAD").trim());
    commit(web.root, "web: header base", "rin", { "src/header.ts": lines(10), "src/header.css": css("20px") });
    commit(web.root, "fix(header): a", "dana", { "src/header.ts": lines(10, { 6: "a6" }), "src/header.css": css("18px"), "src/debug.ts": "export const DEBUG = true;\n" });
    commit(web.root, "header: x by rin", "rin", { "src/header.ts": lines(10, { 4: "x4", 6: "a6" }), "src/header.css": css("1.1rem") });
    commit(web.root, "fix(header): c", "dana", { "src/header.ts": lines(10, { 4: "x4", 6: "a6", 8: "c8" }), "src/header.css": css("1.1rem", "@media (max-width: 600px) {}\n"), "src/debug.ts": null });
    commit(api.root, "api: p1 status", "dana", { "routes/status.ts": "export const ok = true;\n" });
    commit(api.root, "deps: r by rin", "rin", { "package.json": "{ \"v\": 2 }\n" });
    commit(api.root, "api: p2 version", "dana", { "routes/status.ts": "export const ok = true;\nexport const version = 1;\n" });
    await send({ type: "refresh" });
    await until("the new commits", (x) => x.rows.length === 13);
  });

  after(async () => {
    await closeEditors();
    for (const [root, head] of heads) git(root, "reset", "-q", "--hard", head);
    await send({ type: "filter", filter: ALL });
    await send({ type: "refresh" });
    await until("the fixture again", (x) => x.rows.length === 6);
  });

  it("lists each file once under its repository, with ⚠ where the changes can't be shown apart", async () => {
    const objects = git(web.root, "count-objects", "-v");
    await send({ type: "selectMany", items: [ref("fix(header): c", web), ref("api: p2 version", api), ref("api: p1 status", api), ref("fix(header): a", web)], focus: ref("api: p2 version", api) });
    const c = await waitFor("the combined tree", async () => {
      const x = await changes();
      return x.items.some((i) => i.startsWith("acme-web |")) && x.items.some((i) => i.startsWith("acme-api |")) ? x : undefined;
    });
    const s4 = (n: string) => sha[n].slice(0, 4);
    assert.strictEqual(c.description, "4 commits · 2 repositories");
    assert.strictEqual(c.message, "1 file with no net change: src/debug.ts");
    for (const want of [
      "acme-web | 2 commits", `    header.css | ⚠ ${s4("fix(header): a")} · ${s4("fix(header): c")}`, `    header.ts | ${s4("fix(header): a")} · ${s4("fix(header): c")}`,
      "acme-api | 2 commits", `    status.ts | ${s4("api: p1 status")} · ${s4("api: p2 version")}`,
    ]) assert.ok(c.items.includes(want), `${want}\n in ${c.items.join("\n")}`);
    assert.ok(!c.items.some((i) => i.includes("debug.ts") || i.includes("package.json")), "nothing unselected, nothing cancelled out");
    assert.deepStrictEqual(c.combined.map((o) => `${o.path} ${o.mode}`).sort(), ["routes/status.ts fast", "src/header.css fallback", "src/header.ts merge"]);

    const ts = c.combined.find((o) => o.path === "src/header.ts")!;
    await vscode.commands.executeCommand("linyra.openCombinedDiff", ts);
    const tab = await diffTab();
    const left = (await vscode.workspace.openTextDocument(tab.original)).getText();
    const right = (await vscode.workspace.openTextDocument(tab.modified)).getText();
    assert.strictEqual(left, lines(10, { 4: "x4" }), "rin's line stays as context; dana's lines are taken out");
    assert.strictEqual(right, git(web.root, "show", `${sha["fix(header): c"]}:src/header.ts`));
    assert.strictEqual(vscode.window.tabGroups.activeTabGroup.activeTab?.label, "header.ts (2 selected commits)");

    const cssOpen = c.combined.find((o) => o.path === "src/header.css")!;
    await closeEditors();
    await vscode.commands.executeCommand("linyra.openCombinedDiff", cssOpen);
    const tab2 = await diffTab();
    assert.strictEqual(JSON.parse(tab2.original.query).ref, sha["web: header base"], "the fallback starts before the first selected commit");
    assert.ok(vscode.window.tabGroups.activeTabGroup.activeTab?.label.includes("includes 1 unselected commit"));

    assert.strictEqual(git(web.root, "status", "--porcelain"), "", "the working tree is untouched");
    assert.strictEqual(git(web.root, "count-objects", "-v"), objects, "nothing was written to .git");
    await closeEditors();
  });

  it("a filter that hides the selected commits mid-read leaves no stale tree", async () => {
    await send({ type: "selectMany", items: [ref("fix(header): c", web), ref("fix(header): a", web)], focus: ref("fix(header): c", web) });
    await send({ type: "filter", filter: { ...ALL, author: "rin" } });
    await waitFor("dana's commits gone from the tree", async () => {
      const x = await changes();
      return !x.items.some((i) => i.startsWith("acme-web | 2 commits")) && x.description !== "2 commits · 1 repository" ? x : undefined;
    });
    await sleep(500);
    const x = await changes();
    assert.ok(!x.items.some((i) => i.startsWith("acme-web | 2 commits")), x.items.join("\n"));
    await send({ type: "filter", filter: ALL });
    await until("all rows", (s) => s.rows.length === 13);
  });

  it("a plain click afterwards shows one commit, as before", async () => {
    await send({ type: "selectMany", items: [ref("fix(header): c", web), ref("fix(header): a", web)], focus: ref("fix(header): c", web) });
    await waitFor("combined", async () => ((await changes()).description === "2 commits · 1 repository" ? true : undefined));
    await send({ type: "select", ...ref("fix(header): c", web) });
    const c = await waitFor("one commit", async () => {
      const x = await changes();
      return x.items[0]?.startsWith("fix(header): c |") ? x : undefined;
    });
    assert.deepStrictEqual(c.combined, []);
    assert.ok(c.description.startsWith("acme-web · "), c.description);
  });

  it("Clear Selection goes back to the focused commit", async () => {
    await send({ type: "selectMany", items: [ref("fix(header): c", web), ref("fix(header): a", web)], focus: ref("fix(header): a", web) });
    await waitFor("combined", async () => ((await changes()).description === "2 commits · 1 repository" ? true : undefined));
    await vscode.commands.executeCommand("linyra.clearSelection");
    await waitFor("the focused commit alone", async () => ((await changes()).items[0]?.startsWith("fix(header): a |") ? true : undefined));
  });
});

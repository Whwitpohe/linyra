import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { commitGraphPathArgs, SLOW_TOPO_MS, wantsCommitGraphHint } from "./commitGraphModel";
import { gitEnv, makeRepo } from "./fixtures";

assert.strictEqual(wantsCommitGraphHint("topo", SLOW_TOPO_MS), true);
assert.strictEqual(wantsCommitGraphHint("topo", SLOW_TOPO_MS - 1), false, "a fast page asks nothing");
assert.strictEqual(wantsCommitGraphHint("date", 10_000), false, "date order does not walk the whole history per page");
assert.strictEqual(wantsCommitGraphHint(undefined, 10_000), false);

const home = fs.mkdtempSync(path.join(os.tmpdir(), "linyra-graph-"));
try {
  const root = path.join(home, "acme-api");
  makeRepo(root, [{ time: 1000, author: "dana", message: "feat: base", files: { "a.txt": "one\n" } }], home);
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, env: gitEnv(home), encoding: "utf8" }).trim();
  const paths = () => git(commitGraphPathArgs()).split(/\r?\n/).map((p) => path.resolve(root, p));
  assert.ok(!paths().some((p) => fs.existsSync(p)), "a fresh repository has none");
  git(["commit-graph", "write", "--reachable"]);
  assert.ok(paths().some((p) => fs.existsSync(p)), "git's own path finds the graph it wrote");
  console.log("ok - the commit-graph hint is for slow topological pages, and finds the graph where git keeps it");
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { walkForRepos } from "./discoverWalk";

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "linyra-walk-"));
const repoAt = (rel: string, kind: "dir" | "file" = "dir") => {
  const dir = path.join(ws, rel);
  fs.mkdirSync(dir, { recursive: true });
  if (kind === "dir") fs.mkdirSync(path.join(dir, ".git"));
  else fs.writeFileSync(path.join(dir, ".git"), "gitdir: ../elsewhere\n"); // worktree / submodule
};
repoAt("acme-web");
repoAt("group/acme-api");
repoAt("wt", "file");
repoAt("group/deeper/deep/acme-libs");
repoAt("node_modules/pkg");

(async () => {
  {
    const found = (await walkForRepos([ws], 2)).map((p) => path.relative(ws, p).split(path.sep).join("/"));
    assert.deepStrictEqual(found, ["acme-web", "group/acme-api", "wt"]);
    console.log("ok - finds repos (including .git files) within depth, skipping node_modules");
  }
  {
    assert.deepStrictEqual(await walkForRepos([ws], 0), []);
    assert.deepStrictEqual((await walkForRepos([path.join(ws, "acme-web")], 0)).length, 1);
    console.log("ok - depth 0 checks only the roots themselves");
  }
  {
    assert.deepStrictEqual(await walkForRepos([path.join(ws, "does-not-exist")], 2), []);
    console.log("ok - unreadable or missing roots are ignored");
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

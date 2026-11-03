import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { gitEnv, makeRepo } from "./fixtures";
import { runGit } from "./git";
import { conflictCount, objectsDir, scratchEnv } from "./mergeCheck";

{
  assert.deepStrictEqual(scratchEnv("/tmp/s", "/work/acme-web/.git/objects", ":"), { GIT_OBJECT_DIRECTORY: "/tmp/s", GIT_ALTERNATE_OBJECT_DIRECTORIES: "/work/acme-web/.git/objects" });
  assert.strictEqual(scratchEnv("/tmp/s", "/work/proj:2/acme-web/.git/objects", ":").GIT_ALTERNATE_OBJECT_DIRECTORIES, '"/work/proj:2/acme-web/.git/objects"', "a separator in the path: quoted");
  assert.strictEqual(scratchEnv("C:\\s", "C:\\work\\a;b\\.git\\objects", ";").GIT_ALTERNATE_OBJECT_DIRECTORIES, '"C:\\\\work\\\\a;b\\\\.git\\\\objects"', "Windows: its backslashes escaped");
  assert.strictEqual(scratchEnv("C:\\s", "C:\\work\\acme-web\\.git\\objects", ";").GIT_ALTERNATE_OBJECT_DIRECTORIES, "C:\\work\\acme-web\\.git\\objects", "a drive's colon is no separator there");
  assert.strictEqual(scratchEnv("/tmp/s", '/work/a"b:c/.git/objects', ":").GIT_ALTERNATE_OBJECT_DIRECTORIES, '"/work/a\\"b:c/.git/objects"');
  console.log("ok - the merge in memory reads the repository's objects as one alternate, quoted when its path has the separator");
}

void (async () => {
  // Real git: a repository in a folder whose name has the alternates separator (":" here, ";" on
  // Windows). Unquoted, git split the path, found no objects, exited 1 with nothing on stdout, and
  // every merge read as clean.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "linyra-mergecheck-"));
  const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env: { ...gitEnv(home), GIT_AUTHOR_NAME: "dana", GIT_AUTHOR_EMAIL: "dana@example.com", GIT_COMMITTER_NAME: "dana", GIT_COMMITTER_EMAIL: "dana@example.com" }, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  try {
    const api = path.join(home, `proj${path.delimiter}2`, "acme-api");
    makeRepo(api, [{ time: 1000, author: "dana", message: "feat: base", files: { "limit.go": "1\n2\n3\n", "other.go": "x\n" } }], home);
    git(api, ["switch", "-q", "-c", "release-1.4"]);
    fs.writeFileSync(path.join(api, "limit.go"), "1\nrelease\n3\n");
    git(api, ["commit", "-qam", "feat: rate limit per client"]);
    git(api, ["switch", "-q", "-c", "docs", "main"]);
    fs.writeFileSync(path.join(api, "other.go"), "docs\n");
    git(api, ["commit", "-qam", "docs: other"]);
    git(api, ["switch", "-q", "main"]);
    fs.writeFileSync(path.join(api, "limit.go"), "1\nmain\n3\n");
    git(api, ["commit", "-qam", "fix: limit on main"]);
    const objects = (await objectsDir(api))!;
    const count = () => fs.readdirSync(objects).length;
    const before = count();
    const signal = new AbortController().signal;
    const sha = (ref: string) => git(api, ["rev-parse", ref]);
    assert.strictEqual(await conflictCount(runGit, api, sha("release-1.4"), sha("main"), signal), 1, "limit.go conflicts");
    assert.strictEqual(await conflictCount(runGit, api, sha("docs"), sha("main"), signal), 0, "merges cleanly");
    // A commit the repository does not have: git exits 1 with nothing on stdout. Not told, not clean.
    assert.strictEqual(await conflictCount(runGit, api, "0123456789abcdef0123456789abcdef01234567", sha("main"), signal), null);
    assert.strictEqual(count(), before, "nothing written to the repository");
    console.log("ok - real git: the merge check in a folder whose name has the alternates separator, and an error is no clean merge");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

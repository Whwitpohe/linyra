import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { gitEnv, makeRepo } from "./fixtures";
import { isStashRef, parseStashes, stashCommands, stashLabel, stashListArgs, stashStopped } from "./stashModel";

const sha = "a".repeat(40);
{
  const entry = (...fields: string[]) => fields.join("\0");
  const list = parseStashes([entry("stash@{0}", sha, "100", "On main: half-done retry"), entry("stash@{1}", sha, "90", "WIP on main: abc1234 feat: base"), "garbage", ""].join("\n"));
  assert.deepStrictEqual(list.map((s) => [s.ref, stashLabel(s)]), [["stash@{0}", "half-done retry"], ["stash@{1}", "abc1234 feat: base"]]);
  assert.ok(isStashRef("stash@{12}") && !isStashRef("stash@{-1}") && !isStashRef("--all") && !isStashRef("main"));
  assert.throws(() => stashCommands.drop("--all"), "nothing but stash@{n} reaches git");
  assert.deepStrictEqual(stashCommands.push(" wip ", true), ["stash", "push", "--include-untracked", "-m", "wip"]);
  assert.match(stashStopped("CONFLICT (content): Merge conflict in a.txt")!, /conflict/);
  assert.strictEqual(stashStopped("fatal: something else"), undefined);
  console.log("ok - stash entries parse, label without git's prefix, and only stash@{n} reaches git");
}

{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "linyra-stash-"));
  try {
    const root = path.join(home, "acme-api");
    makeRepo(root, [{ time: 1000, author: "dana", message: "feat: base", files: { "a.txt": "one\n" } }], home);
    const env = { ...gitEnv(home), GIT_AUTHOR_NAME: "dana", GIT_AUTHOR_EMAIL: "dana@example.com", GIT_COMMITTER_NAME: "dana", GIT_COMMITTER_EMAIL: "dana@example.com" };
    const git = (args: string[]) => execFileSync("git", args, { cwd: root, env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    fs.writeFileSync(path.join(root, "a.txt"), "two\n");
    fs.writeFileSync(path.join(root, "new.txt"), "new\n");
    git(stashCommands.push("half-done", true));
    assert.ok(!fs.existsSync(path.join(root, "new.txt")) && fs.readFileSync(path.join(root, "a.txt"), "utf8") === "one\n", "the work tree is clean again");
    const [s] = parseStashes(git(stashListArgs()));
    assert.strictEqual(stashLabel(s), "half-done");
    assert.match(git(stashCommands.files(s.sha)), /a\.txt/, "the stash's changes against its base");
    git(stashCommands.apply(s.ref));
    assert.strictEqual(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "two\n");
    assert.strictEqual(parseStashes(git(stashListArgs())).length, 1, "apply keeps the stash");
    git(["checkout", "--", "a.txt"]); fs.rmSync(path.join(root, "new.txt"));
    git(stashCommands.pop(s.ref));
    assert.ok(fs.existsSync(path.join(root, "new.txt")), "untracked files come back too");
    assert.strictEqual(parseStashes(git(stashListArgs())).length, 0, "pop removes it");
    git(stashCommands.push("again", false));
    git(stashCommands.drop("stash@{0}"));
    assert.strictEqual(git(stashListArgs()), "");
    console.log("ok - real git: push (with untracked), list, files, apply, pop and drop");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

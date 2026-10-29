import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { gitEnv, makeRepo } from "./fixtures";
import { readWorktrees } from "./repoHead";
import { folderName, hasLocalChanges, worktreeCommands, worktreeLabel } from "./worktreeModel";

{
  assert.strictEqual(folderName("D:\\work\\acme-web-hotfix\\"), "acme-web-hotfix");
  assert.strictEqual(folderName("/work/acme-web"), "acme-web");
  assert.strictEqual(worktreeLabel({ path: "/work/acme-web-hotfix", branch: "hotfix", main: false, current: false }), "acme-web-hotfix · hotfix");
  assert.strictEqual(worktreeLabel({ path: "/work/x", branch: null, detached: "1a2b3c4", main: false, current: false }), "x · 1a2b3c4");
  assert.deepStrictEqual(worktreeCommands.remove("/work/x", true), ["worktree", "remove", "--force", "--", "/work/x"]);
  console.log("ok - a worktree's label and git's remove");
}

void (async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "linyra-worktrees-"));
  const ID = { GIT_AUTHOR_NAME: "dana", GIT_AUTHOR_EMAIL: "dana@example.com", GIT_COMMITTER_NAME: "dana", GIT_COMMITTER_EMAIL: "dana@example.com" };
  const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env: { ...gitEnv(home), ...ID, LC_ALL: "C" }, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  const fails = (cwd: string, args: string[]) => {
    try { git(cwd, args); return ""; } catch (e) { return String((e as { stderr?: unknown }).stderr ?? e); }
  };
  const same = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  try {
    const repo = path.join(home, "acme-web");
    makeRepo(repo, [{ time: 1000, author: "dana", message: "feat: base", files: { "a.txt": "1\n" } }], home);
    const main = git(repo, ["branch", "--show-current"]);
    assert.deepStrictEqual(await readWorktrees(repo), [], "no linked worktree: no group");

    const hotfix = path.join(home, "acme-web-hotfix"), spike = path.join(home, "acme-web-spike");
    git(repo, ["worktree", "add", "-q", "-b", "hotfix", hotfix]);
    git(repo, ["worktree", "add", "-q", "--detach", spike]);
    git(repo, ["worktree", "lock", spike]);
    const list = await readWorktrees(repo);
    assert.strictEqual(list.length, 3);
    assert.ok(same(list[0].path, repo) && list[0].main && list[0].current && list[0].branch === main);
    const h = list.find((w) => same(w.path, hotfix))!;
    assert.deepStrictEqual({ branch: h.branch, main: h.main, current: h.current, locked: h.locked, missing: h.missing }, { branch: "hotfix", main: false, current: false, locked: undefined, missing: undefined });
    const s = list.find((w) => same(w.path, spike))!;
    assert.ok(s.branch === null && s.detached && s.locked, "detached and locked");

    // Seen from the linked worktree: the same list, that one current.
    const fromHotfix = await readWorktrees(hotfix);
    assert.deepStrictEqual(fromHotfix.map((w) => w.current), list.map((w) => same(w.path, hotfix)));

    // A worktree with local changes is refused without --force.
    fs.writeFileSync(path.join(hotfix, "a.txt"), "changed\n");
    assert.ok(hasLocalChanges(fails(repo, worktreeCommands.remove(hotfix, false))));
    git(repo, worktreeCommands.remove(hotfix, true));
    assert.ok(!fs.existsSync(hotfix));
    assert.strictEqual(git(repo, ["branch", "--list", "hotfix"]), "hotfix", "its branch stays");

    // A folder deleted by hand: listed as missing, and prune forgets it.
    git(repo, ["worktree", "unlock", spike]);
    fs.rmSync(spike, { recursive: true, force: true });
    assert.strictEqual((await readWorktrees(repo)).find((w) => same(w.path, spike))?.missing, true);
    git(repo, worktreeCommands.prune());
    assert.deepStrictEqual(await readWorktrees(repo), [], "none left");
    console.log("ok - real git: worktrees read from the git dir (main, linked, detached, locked, gone), removed and pruned");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });

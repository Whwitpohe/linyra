import * as assert from "assert";
import { execFile, execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { gitEnv, makeRepo } from "./fixtures";
import { checkoutBlock, smartCheckout } from "./smartCheckout";

{
  assert.strictEqual(checkoutBlock("error: Your local changes to the following files would be overwritten by checkout:\n\ta.txt\nPlease commit your changes or stash them before you switch branches.\nAborting"), "changes");
  assert.strictEqual(checkoutBlock("error: The following untracked working tree files would be overwritten by checkout:\n\tnew.txt\nPlease move or remove them before you switch branches."), "untracked");
  assert.strictEqual(checkoutBlock("fatal: invalid reference: nope"), undefined);
  console.log("ok - git's refusals that a Smart Checkout answers");
}

void (async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "linyra-smart-"));
  const ID = { GIT_AUTHOR_NAME: "dana", GIT_AUTHOR_EMAIL: "dana@example.com", GIT_COMMITTER_NAME: "dana", GIT_COMMITTER_EMAIL: "dana@example.com" };
  const env = { ...gitEnv(home), ...ID, LC_ALL: "C" };
  const sync = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  const git = (cwd: string) => (args: string[]) => new Promise<string>((resolve, reject) =>
    execFile("git", args, { cwd, env, encoding: "utf8" }, (e, stdout, stderr) => (e ? reject(Object.assign(e, { stderr })) : resolve(stdout))));
  const refused = async (cwd: string, args: string[]) => {
    try { await git(cwd)(args); } catch (e) { return checkoutBlock(String((e as { stderr?: unknown }).stderr)); }
    throw new Error("expected the checkout to be refused");
  };
  try {
    const repo = path.join(home, "acme-web");
    makeRepo(repo, [{ time: 1000, author: "dana", message: "feat: base", files: { "a.txt": "1\n2\n3\n4\n5\n", "b.txt": "b\n" } }], home);
    const main = sync(repo, ["branch", "--show-current"]);
    sync(repo, ["switch", "-q", "-c", "feature/login"]);
    fs.writeFileSync(path.join(repo, "a.txt"), "one\n2\n3\n4\n5\n");
    fs.writeFileSync(path.join(repo, "new.txt"), "theirs\n");
    sync(repo, ["add", "."]); sync(repo, ["commit", "-qm", "feat: feature"]);
    sync(repo, ["switch", "-q", main]);

    // Local edits far from the branch's: back cleanly, and what was staged stays staged.
    fs.writeFileSync(path.join(repo, "a.txt"), "1\n2\n3\n4\nfive\n");
    fs.writeFileSync(path.join(repo, "b.txt"), "b staged\n");
    sync(repo, ["add", "b.txt"]);
    const block = await refused(repo, ["switch", "feature/login"]);
    assert.strictEqual(block, "changes");
    let r = await smartCheckout(git(repo), block!, "Linyra: Smart Checkout of feature/login", () => git(repo)(["switch", "feature/login"]));
    assert.deepStrictEqual(r, { reapplied: true });
    assert.strictEqual(sync(repo, ["branch", "--show-current"]), "feature/login");
    assert.strictEqual(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "one\n2\n3\n4\nfive\n", "both edits");
    assert.strictEqual(sync(repo, ["diff", "--cached", "--name-only"]), "b.txt", "still staged");
    assert.strictEqual(sync(repo, ["stash", "list"]), "", "the stash is dropped");

    // A checkout that fails anyway puts the changes back where they were.
    await assert.rejects(smartCheckout(git(repo), "changes", "Linyra: Smart Checkout of nope", () => git(repo)(["switch", "nope"])));
    assert.strictEqual(sync(repo, ["branch", "--show-current"]), "feature/login");
    assert.strictEqual(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "one\n2\n3\n4\nfive\n");
    assert.strictEqual(sync(repo, ["stash", "list"]), "");

    // The same line on both sides: checked out, the conflict left to resolve, the stash kept.
    sync(repo, ["reset", "-q", "--hard"]);
    sync(repo, ["switch", "-q", main]);
    fs.writeFileSync(path.join(repo, "a.txt"), "uno\n2\n3\n4\n5\n");
    r = await smartCheckout(git(repo), "changes", "Linyra: Smart Checkout of feature/login", () => git(repo)(["switch", "feature/login"]));
    assert.deepStrictEqual(r, { reapplied: false, conflicts: ["a.txt"] });
    assert.strictEqual(sync(repo, ["branch", "--show-current"]), "feature/login");
    assert.match(sync(repo, ["stash", "list"]), /Linyra: Smart Checkout of feature\/login/);
    assert.match(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), /<<<<<<<[\s\S]*=======/);
    sync(repo, ["reset", "-q", "--hard"]); sync(repo, ["stash", "drop", "-q"]);

    // An untracked file in the branch's way: stashed with the others, kept when it cannot come back.
    sync(repo, ["switch", "-q", main]);
    fs.writeFileSync(path.join(repo, "new.txt"), "mine\n");
    const untracked = await refused(repo, ["switch", "feature/login"]);
    assert.strictEqual(untracked, "untracked");
    r = await smartCheckout(git(repo), untracked!, "Linyra: Smart Checkout of feature/login", () => git(repo)(["switch", "feature/login"]));
    assert.strictEqual(sync(repo, ["branch", "--show-current"]), "feature/login");
    assert.strictEqual(r.reapplied, false, "the branch's own new.txt is there");
    assert.match(r.reason ?? "", /already exists|could not restore/i);
    assert.strictEqual(fs.readFileSync(path.join(repo, "new.txt"), "utf8"), "theirs\n");
    assert.match(sync(repo, ["stash", "list"]), /Smart Checkout/, "mine is kept in the stash");
    console.log("ok - real git: Smart Checkout puts changes back (staged stays staged), or leaves the conflict and keeps the stash");

    // The changes went away before the stash (nothing to save): an older stash of the user's is never
    // applied or dropped in their place.
    sync(repo, ["reset", "-q", "--hard"]); sync(repo, ["clean", "-fdq"]);
    sync(repo, ["stash", "clear"]);
    sync(repo, ["switch", "-q", main]);
    fs.writeFileSync(path.join(repo, "b.txt"), "someone's old work\n");
    sync(repo, ["stash", "push", "-q", "-m", "older work"]);
    r = await smartCheckout(git(repo), "changes", "Linyra: Smart Checkout of feature/login", () => git(repo)(["switch", "feature/login"]));
    assert.deepStrictEqual(r, { reapplied: true });
    assert.strictEqual(sync(repo, ["branch", "--show-current"]), "feature/login");
    assert.match(sync(repo, ["stash", "list"]), /older work/, "the older stash is untouched");
    assert.strictEqual(fs.readFileSync(path.join(repo, "b.txt"), "utf8"), "b\n", "and not applied");
    console.log("ok - real git: nothing to stash leaves an older stash alone");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });

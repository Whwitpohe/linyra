import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { gitEnv, makeRepo } from "./fixtures";
import { atomicUnsupported, behindOf, parseUpstream, releasePushArgs, releaseTagArgs, releaseTagPushArgs, tagMessage, upstreamArgs } from "./releaseModel";

{
  assert.deepStrictEqual(releaseTagArgs("v1.4.0", "Release v1.4.0", "main"), ["tag", "-a", "-m", "Release v1.4.0", "--", "v1.4.0", "refs/heads/main"]);
  assert.throws(() => releaseTagArgs("v1..4", "m", "main"), /not a valid name/);
  assert.deepStrictEqual(parseUpstream("origin\0refs/heads/main\n"), { remote: "origin", ref: "refs/heads/main" });
  assert.strictEqual(parseUpstream("\0\n"), undefined, "no upstream");
  assert.deepStrictEqual(releasePushArgs("origin", "main", "refs/heads/main", "v1.4.0"), ["push", "--quiet", "--atomic", "--", "origin", "refs/heads/main:refs/heads/main", "refs/tags/v1.4.0"]);
  assert.deepStrictEqual(releasePushArgs("origin", "main", "refs/heads/master"), ["push", "--quiet", "--", "origin", "refs/heads/main:refs/heads/master"], "one ref: nothing to make atomic");
  assert.deepStrictEqual(releaseTagPushArgs("origin", "v1.4.0"), ["push", "--quiet", "--", "origin", "refs/tags/v1.4.0"]);
  assert.ok(atomicUnsupported("fatal: the receiving end does not support --atomic push") && !atomicUnsupported("! [rejected] main -> main (fetch first)"));
  assert.deepStrictEqual([behindOf("[ahead 1, behind 2]"), behindOf("[behind 3]"), behindOf("[ahead 1]"), behindOf("[gone]"), behindOf("")], [2, 3, 0, 0, 0]);
  assert.strictEqual(tagMessage("v1.4.0", [{ sha: "a".repeat(40), subject: "feat: upload retry" }]), "Release v1.4.0\n\n- feat: upload retry (aaaaaaa)");
  assert.strictEqual(tagMessage("v1.4.0", []), "Release v1.4.0");
  console.log("ok - Release…'s tag on ▶, its message, and the push of ▶ with the tag, atomic");
}

{
  // Real git: ▶ (main) not checked out gets the tag on its tip, and goes to its upstream with it.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "linyra-release-"));
  const ID = { GIT_AUTHOR_NAME: "dana", GIT_AUTHOR_EMAIL: "dana@example.com", GIT_COMMITTER_NAME: "dana", GIT_COMMITTER_EMAIL: "dana@example.com" };
  const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env: { ...gitEnv(home), ...ID, LC_ALL: "C" }, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  try {
    const seed = path.join(home, "seed");
    makeRepo(seed, [{ time: 1000, author: "dana", message: "feat: base", files: { "a.txt": "1\n" } }], home);
    git(seed, ["branch", "-M", "main"]);
    const origin = path.join(home, "origin.git");
    git(home, ["clone", "-q", "--bare", seed, origin]);
    const web = path.join(home, "acme-web");
    git(home, ["clone", "-q", origin, web]);
    git(web, ["switch", "-q", "-c", "develop"]);
    fs.writeFileSync(path.join(web, "b.txt"), "2\n");
    git(web, ["add", "b.txt"]); git(web, ["commit", "-qm", "feat: release me"]);
    git(web, ["update-ref", "refs/heads/main", "HEAD"]); // ▶ moved forward without a checkout, as Merge ◀ into ▶ does
    const up = parseUpstream(git(web, upstreamArgs("main")))!;
    assert.deepStrictEqual(up, { remote: "origin", ref: "refs/heads/main" });
    git(web, releaseTagArgs("v1.4.0", tagMessage("v1.4.0", [{ sha: git(web, ["rev-parse", "HEAD"]), subject: "feat: release me" }]), "main"));
    git(web, releasePushArgs(up.remote, "main", up.ref, "v1.4.0"));
    assert.strictEqual(git(origin, ["log", "-1", "--format=%s", "main"]), "feat: release me");
    assert.strictEqual(git(origin, ["rev-parse", "v1.4.0^{commit}"]), git(origin, ["rev-parse", "main"]));
    assert.match(git(origin, ["tag", "-l", "-n9", "v1.4.0"]), /Release v1\.4\.0[\s\S]*feat: release me/);
    assert.strictEqual(git(web, ["branch", "--show-current"]), "develop", "nothing checked out");
    console.log("ok - real git: the tag on ▶'s tip, pushed with ▶ to its upstream");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

{
  // Real git: ▶ behind its upstream (rin pushed meanwhile). The push of ▶ with the tag is refused
  // as one: the tag does not land on the remote without ▶. A remote that takes no atomic push says
  // so, and ▶ then the tag go one after the other.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "linyra-release-"));
  const ID = { GIT_AUTHOR_NAME: "dana", GIT_AUTHOR_EMAIL: "dana@example.com", GIT_COMMITTER_NAME: "dana", GIT_COMMITTER_EMAIL: "dana@example.com" };
  const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env: { ...gitEnv(home), ...ID, LC_ALL: "C" }, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  const refused = (cwd: string, args: string[]) => {
    try { git(cwd, args); } catch (e) { return String((e as { stderr?: unknown }).stderr ?? e); }
    return "";
  };
  try {
    const seed = path.join(home, "seed");
    makeRepo(seed, [{ time: 1000, author: "dana", message: "feat: base", files: { "a.txt": "1\n" } }], home);
    const origin = path.join(home, "origin.git");
    git(home, ["clone", "-q", "--bare", seed, origin]);
    const web = path.join(home, "acme-web"), other = path.join(home, "other");
    git(home, ["clone", "-q", origin, web]);
    git(home, ["clone", "-q", origin, other]);
    fs.writeFileSync(path.join(other, "b.txt"), "rin\n");
    git(other, ["add", "b.txt"]); git(other, ["commit", "-qm", "fix: from rin"]); git(other, ["push", "-q", "origin", "main"]);
    fs.writeFileSync(path.join(web, "c.txt"), "dana\n");
    git(web, ["add", "c.txt"]); git(web, ["commit", "-qm", "feat: release me"]);
    git(web, ["fetch", "-q"]);
    assert.strictEqual(behindOf(git(web, ["for-each-ref", "--format=%(upstream:track)", "refs/heads/main"])), 1, "▶ is behind its upstream");
    git(web, releaseTagArgs("v1.4.0", "Release v1.4.0", "main"));
    assert.match(refused(web, releasePushArgs("origin", "main", "refs/heads/main", "v1.4.0")), /rejected/);
    assert.strictEqual(git(origin, ["tag", "-l"]), "", "▶ refused: the tag is not on the remote either");
    git(web, ["pull", "-q", "--no-rebase", "--no-edit"]);
    git(origin, ["config", "receive.advertiseAtomic", "false"]);
    assert.ok(atomicUnsupported(refused(web, releasePushArgs("origin", "main", "refs/heads/main", "v1.4.0"))), "no atomic push there: said so");
    assert.strictEqual(git(origin, ["tag", "-l"]), "", "and nothing pushed");
    git(web, releasePushArgs("origin", "main", "refs/heads/main"));
    git(web, releaseTagPushArgs("origin", "v1.4.0"));
    assert.strictEqual(git(origin, ["rev-parse", "v1.4.0^{commit}"]), git(origin, ["rev-parse", "main~1"]), "▶, then the tag");
    console.log("ok - real git: a ▶ the remote refuses keeps the release tag off it; without atomic push, ▶ then the tag");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

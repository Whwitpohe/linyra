import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseShow, showArgs } from "./commitDetail";
import { DEFAULT_FILTER, historyArgs, historyPathsArgs, logArgs, parseHistoryPaths, type FilterState } from "./filterModel";
import { commitAt, gitEnv, makeRepo } from "./fixtures";
import { errorLine, GitError, GitRunner, runGit } from "./git";
import { parseHistory, parseLog } from "./gitLog";
import { aheadBehindArgs, parseAheadBehind } from "./upstream";
import { parseNumstat, splitStatus, stagedNumstatArgs, statusArgs, unstagedNumstatArgs, workFiles } from "./workingTree";
import { isAbortError } from "./pool";
import { fetchPage } from "./logQuery";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "polylog-git-test-"));
Object.assign(process.env, gitEnv(home)); // runGit inherits process.env
const ALL: FilterState = { ...DEFAULT_FILTER, date: "all" };
const git = (dir: string, args: string[]) => execFileSync("git", args, { cwd: dir, env: gitEnv(home), stdio: "pipe" }).toString().trim();

const api = path.join(home, "acme-api");
makeRepo(api, [
  { time: 1000, author: "dana", message: "feat: scaffold api", files: { "upload.go": "package upload\n", "logo.png": "\x00\x01\x02", "sp ace é.txt": "a\n" } },
  { time: 2000, author: "rin", message: "fix(api) guard nil response" },
  { time: 2000, author: "dana", message: "[ACME-7] add retry" },
  { time: 3000, author: "rin", message: "café: rename", files: { "sp ace é.txt": null, "renamed.txt": "a\n" } },
], home);

const log = async (f: FilterState, o: { now?: number; cursor?: { skip: number } } = {}) =>
  parseLog(await runGit(api, logArgs(f, { pageSize: 50, now: o.now ?? 10_000, cursor: o.cursor })), api);

{
  // git's real message is the fatal:/error: line; hint: lines come first (git pull --ff-only, 2.43).
  const diverged = "hint: Diverging branches can't be fast-forwarded, you need to either:\nhint:\nhint:   git merge --no-ff\nfatal: Not possible to fast-forward, aborting.\n";
  assert.strictEqual(errorLine(diverged), "Not possible to fast-forward, aborting.");
  assert.strictEqual(errorLine("warning: x\nerror: cannot lock ref 'refs/heads/main'\n"), "cannot lock ref 'refs/heads/main'");
  assert.strictEqual(errorLine("\nsomething odd happened\n"), "something odd happened", "no fatal/error line: the first real line");
  assert.strictEqual(errorLine("hint: only hints\n"), "hint: only hints");
  console.log("ok - a git failure is reported by its fatal:/error: line, not its first hint");
}
(async () => {
  {
    const cs = await log(ALL);
    assert.deepStrictEqual(cs.map((c) => [c.time, c.subject]), [
      [3000, "café: rename"], [2000, "[ACME-7] add retry"], [2000, "fix(api) guard nil response"], [1000, "feat: scaffold api"],
    ]);
    assert.deepStrictEqual(cs[3].parents, []);
    console.log("ok - runGit + parseLog read a real repository, newest first");
  }
  {
    const cs = await log(ALL, { cursor: { skip: 1 } });
    assert.deepStrictEqual(cs.map((c) => c.subject), ["[ACME-7] add retry", "fix(api) guard nil response", "feat: scaffold api"]);
    console.log("ok - --skip resumes at a walk position");
  }
  {
    const cs = await log({ ...ALL, date: "24h" }, { now: 2500 + 86_400 });
    assert.deepStrictEqual(cs.map((c) => c.subject), ["café: rename"]);
    console.log("ok - --since in ISO form limits by committer date");
  }
  {
    assert.deepStrictEqual((await log({ ...ALL, text: "FIX(API)" })).map((c) => c.subject), ["fix(api) guard nil response"]);
    assert.deepStrictEqual((await log({ ...ALL, text: "[acme-7]" })).map((c) => c.subject), ["[ACME-7] add retry"]);
    assert.deepStrictEqual(await log({ ...ALL, text: "." }), [], "a literal dot matches nothing here; as a regex it would match all");
    console.log("ok - search is literal and case-insensitive against real git");
    assert.deepStrictEqual((await log({ ...ALL, author: "RIN" })).map((c) => c.subject), ["café: rename", "fix(api) guard nil response"]);
    assert.deepStrictEqual((await log({ ...ALL, author: "dana@example.com", text: "retry" })).map((c) => c.subject), ["[ACME-7] add retry"]);
    assert.deepStrictEqual(await log({ ...ALL, author: "rin", text: "retry" }), [], "author AND search, never OR");
    console.log("ok - --author matches name or email and combines with --grep as AND");
    const paths = parseHistoryPaths(await runGit(api, historyPathsArgs("renamed.txt")), "renamed.txt");
    assert.deepStrictEqual(paths, ["renamed.txt", "sp ace é.txt"]);
    const hist = parseHistory(await runGit(api, historyArgs(ALL, { pageSize: 50, now: 10_000, paths })), api, "renamed.txt");
    assert.deepStrictEqual(hist.map((c) => [c.subject, c.file?.path, c.file?.status]), [
      ["café: rename", "renamed.txt", "R"],
      ["feat: scaffold api", "sp ace é.txt", "A"],
    ], "history follows the rename back to the file's first name");
    console.log("ok - real git: file history follows a rename");
    // Paging across the rename, and a filter that excludes the rename commit itself (review findings).
    const page2 = parseHistory(await runGit(api, historyArgs(ALL, { pageSize: 1, now: 10_000, cursor: { skip: 1 }, paths })), api, "renamed.txt");
    assert.deepStrictEqual(page2.map((c) => c.subject), ["feat: scaffold api"], "page 2 continues before the rename");
    const byDana = parseHistory(await runGit(api, historyArgs({ ...ALL, author: "dana" }, { pageSize: 50, now: 10_000, paths })), api, "renamed.txt");
    assert.deepStrictEqual(byDana.map((c) => c.subject), ["feat: scaffold api"], "dana's pre-rename commit survives a filter that drops rin's rename");
    console.log("ok - real git: history pages across a rename and filters never cut it");
    git(api, ["branch", "release-1.4", "HEAD~2"]);
    assert.deepStrictEqual((await runGit(api, ["rev-parse", "--verify", "--quiet", "release-1.4^{commit}"])).trim().length, 40);
    await assert.rejects(runGit(api, ["rev-parse", "--verify", "--quiet", "origin/nope^{commit}"]), GitError);
    const onBranch = parseLog(await runGit(api, logArgs(ALL, { pageSize: 50, now: 10_000, ref: "release-1.4" })), api);
    assert.deepStrictEqual(onBranch.map((c) => c.subject), ["fix(api) guard nil response", "feat: scaffold api"]);
    console.log("ok - real git: a branch's history, and rev-parse tells a missing branch by exit code");
    const docsRepo = path.join(home, "acme-docs");
    makeRepo(docsRepo, [{ time: 500, author: "dana", message: "docs: add x", files: { "docs/x.md": "x\n" } }], home);
    git(docsRepo, ["branch", "docs"]);
    const docs = parseLog(await runGit(docsRepo, logArgs(ALL, { pageSize: 50, now: 10_000, ref: "docs" })), docsRepo);
    assert.strictEqual(docs[0].subject, "docs: add x", "a branch named like a folder is not ambiguous");
    console.log("ok - real git: a branch named like a top-level folder works");
    const base = git(docsRepo, ["rev-parse", "HEAD"]);
    const tree = git(docsRepo, ["rev-parse", "HEAD^{tree}"]);
    git(docsRepo, ["config", "user.name", "dana"]);
    git(docsRepo, ["config", "user.email", "dana@example.com"]);
    const makeTip = (message: string, ref: string) => {
      const sha = git(docsRepo, ["commit-tree", tree, "-p", base, "-m", message]);
      git(docsRepo, ["update-ref", ref, sha]);
      return sha;
    };
    const local = makeTip("feat: local preview only", "refs/heads/preview");
    const remote = makeTip("feat: remote release only", "refs/remotes/origin/release");
    const tagOnly = makeTip("chore: tag without a branch", "refs/tags/archive-only");
    const stashOnly = makeTip("WIP: unpublished work", "refs/stash");
    const defaultRows = parseLog(await runGit(docsRepo, logArgs(ALL, { pageSize: 20, now: Date.now() / 1000 })), docsRepo);
    assert.deepStrictEqual(new Set(defaultRows.map((c) => c.sha)), new Set([base, local, remote]), "all branches includes unmerged local/remote tips, excluding stash and tag-only history");
    assert.ok(!defaultRows.some((c) => c.sha === tagOnly || c.sha === stashOnly));
    const selected = parseLog(await runGit(docsRepo, logArgs({ ...ALL, branches: ["preview", "origin/release"] }, { pageSize: 20, now: Date.now() / 1000 })), docsRepo);
    assert.deepStrictEqual(new Set(selected.map((c) => c.sha)), new Set([base, local, remote]));
    assert.strictEqual(selected.filter((c) => c.sha === base).length, 1, "shared ancestors appear only once");
    const repo = { id: docsRepo, root: docsRepo, name: "acme-docs" };
    let prev = null as Awaited<ReturnType<typeof fetchPage>>["state"] | null;
    const paged: string[] = [];
    let listings = 0;
    for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
      const page = await fetchPage({ repos: [repo], filter: { ...ALL, branches: ["preview", "origin/release", "missing"] },
        pageSize: 1, concurrency: 2, now: Date.now() / 1000, prev, signal: new AbortController().signal,
        run: (root, args, signal) => { if (args[0] === "for-each-ref") listings++; return runGit(root, args, signal); } });
      paged.push(...page.rows.map((c) => c.sha));
      prev = page.state;
      if (page.done) break;
    }
    assert.deepStrictEqual(new Set(paged), new Set([base, local, remote]));
    assert.strictEqual(paged.length, 3, "paging loses no tips and repeats no ancestors");
    assert.strictEqual(listings, 1, "multiple selected names resolve with one ref listing per query");
    console.log("ok - real git: all branches, union selection, no stash/tag leakage and duplicate-free pagination");
  }
  {
    git(api, ["config", "i18n.logOutputEncoding", "ISO-8859-1"]);
    git(api, ["config", "log.showSignature", "true"]);
    assert.strictEqual((await log(ALL))[0].subject, "café: rename");
    git(api, ["config", "--unset", "i18n.logOutputEncoding"]);
    git(api, ["config", "--unset", "log.showSignature"]);
    console.log("ok - user git config cannot change the output encoding or add signature lines");
  }
  {
    const [renameSha, , , rootSha] = (await log(ALL)).map((c) => c.sha);
    const root = parseShow(await runGit(api, showArgs(rootSha))).files;
    assert.deepStrictEqual(root.find((f) => f.path === "logo.png"), { path: "logo.png", added: null, deleted: null, status: "A" });
    assert.deepStrictEqual(root.find((f) => f.path === "sp ace é.txt"), { path: "sp ace é.txt", added: 1, deleted: 0, status: "A" });
    assert.strictEqual(parseShow(await runGit(api, showArgs(renameSha))).message, "café: rename");
    assert.deepStrictEqual(parseShow(await runGit(api, showArgs(renameSha))).files, [{ path: "renamed.txt", oldPath: "sp ace é.txt", added: 0, deleted: 0, status: "R" }]);
    console.log("ok - numstat on real commits: binary, unicode path, rename");
  }
  {
    const web = path.join(home, "acme-web");
    makeRepo(web, [{ time: 100, author: "dana", message: "base", files: { "a.txt": "a\n" } }], home);
    git(web, ["checkout", "-q", "-b", "side"]);
    commitAt(web, home, { time: 200, author: "rin", message: "side work", files: { "side.txt": "s\n" } });
    git(web, ["checkout", "-q", "main"]);
    commitAt(web, home, { time: 300, author: "dana", message: "main work", files: { "main.txt": "m\n" } });
    execFileSync("git", ["merge", "-q", "--no-ff", "side", "-m", "merge side"], {
      cwd: web, stdio: "pipe",
      env: { ...gitEnv(home), GIT_AUTHOR_NAME: "dana", GIT_AUTHOR_EMAIL: "dana@example.com", GIT_COMMITTER_NAME: "dana", GIT_COMMITTER_EMAIL: "dana@example.com", GIT_AUTHOR_DATE: "@400 +0000", GIT_COMMITTER_DATE: "@400 +0000" },
    });
    const merge = parseLog(await runGit(web, logArgs(ALL, { pageSize: 1, now: 0 })), web)[0];
    assert.strictEqual(merge.parents.length, 2);
    assert.deepStrictEqual(parseShow(await runGit(web, showArgs(merge.sha))).files, [{ path: "side.txt", added: 1, deleted: 0, status: "A" }]);
    console.log("ok - a merge commit lists files against its first parent");
  }
  {
    const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), "polylog-not-a-repo-"));
    await assert.rejects(runGit(notRepo, ["log"]), (e: unknown) =>
      e instanceof GitError && /not a git repository/i.test(e.message) && !e.message.startsWith("fatal:"));
    const sha = (await log(ALL))[0].sha;
    await assert.rejects(runGit(api, ["show", `${sha}:missing.txt`]), GitError);
    console.log("ok - git failures reject with a readable GitError");
  }
  {
    const ctl = new AbortController();
    const pending = runGit(api, ["log"], ctl.signal);
    ctl.abort();
    await assert.rejects(pending, (e: unknown) => isAbortError(e));
    console.log("ok - aborting kills the process and rejects with AbortError");
  }
  {
    const web = path.join(home, "acme-web");
    makeRepo(web, [
      { time: 1000, author: "dana", message: "feat: checkout", files: { "src/checkout/Pay.tsx": "x\n" } },
      { time: 2000, author: "rin", message: "feat: cart", files: { "src/cart.ts": "y\n" } },
      { time: 3000, author: "dana", message: "docs: readme", files: { "README.md": "z\n" } },
    ], home);
    const subjects = async (p: string) => parseLog(await runGit(web, logArgs({ ...ALL, path: p }, { pageSize: 50, now: 10_000 })), web).map((c) => c.subject);
    assert.deepStrictEqual(await subjects("src/checkout"), ["feat: checkout"], "a folder matches what is inside it");
    assert.deepStrictEqual(await subjects("src"), ["feat: cart", "feat: checkout"], "and everything below it");
    assert.deepStrictEqual(await subjects("src/check"), [], "a partial name is not a prefix match: pathspecs match whole path components");
    assert.deepStrictEqual(await subjects("**/*.tsx"), ["feat: checkout"], "a glob with ** crosses folders");
    assert.deepStrictEqual(await subjects("*.md"), ["docs: readme"]);
    assert.deepStrictEqual(await subjects("*.tsx"), ["feat: checkout"], "a slash-free glob matches in any folder");
    assert.deepStrictEqual(await subjects("src/*.ts"), ["feat: cart"], "a glob with a folder stays anchored to it");
    console.log("ok - real git: a path filter matches files, folders and globs as the design says");
  }
  {
    const wt = path.join(home, "acme-libs");
    makeRepo(wt, [
      { time: 1000, author: "rin", message: "init", files: { "a.ts": "1\n2\n", "b.ts": "b\n", "gone.ts": "x\n", "old.md": "same\n", "keep.ts": "k\n" } },
    ], home);
    fs.writeFileSync(path.join(wt, "a.ts"), "1\n2\n3\n"); // edited, not staged
    fs.writeFileSync(path.join(wt, "b.ts"), "B\n");
    git(wt, ["add", "b.ts"]); // edited and staged
    fs.writeFileSync(path.join(wt, "new.ts"), "n\n");
    git(wt, ["add", "new.ts"]); // new, staged
    fs.rmSync(path.join(wt, "gone.ts")); // deleted
    git(wt, ["mv", "old.md", "new.md"]); // renamed
    fs.writeFileSync(path.join(wt, "to do é.txt"), "t\n"); // untracked, space and accent
    const head = git(wt, ["rev-parse", "HEAD"]);
    const only = splitStatus(await runGit(wt, statusArgs([":(literal)a.ts"])));
    assert.deepStrictEqual([...only.staged, ...only.changes].map((e) => e.path), ["a.ts"], "the Path filter narrows it");
    console.log("ok - real git: uncommitted changes, staged or not, new, deleted, renamed and untracked");
    const split = splitStatus(await runGit(wt, statusArgs([])));
    assert.deepStrictEqual(split.staged.map((e) => e.path).sort(), ["b.ts", "new.md", "new.ts"], "staged: the edit added, the new file, the rename");
    assert.deepStrictEqual(split.changes.map((e) => e.path).sort(), ["a.ts", "gone.ts", "to do é.txt"], "not staged: the edit, the deletion, the untracked file");
    const staged = new Map(workFiles(split.staged, parseNumstat(await runGit(wt, stagedNumstatArgs(head, [])))).map((f) => [f.path, f]));
    assert.deepStrictEqual([staged.get("b.ts")!.added, staged.get("new.ts")!.added, staged.get("new.md")!.oldPath], [1, 1, "old.md"], "git diff --cached counts the staged side");
    const changes = new Map(workFiles(split.changes, parseNumstat(await runGit(wt, unstagedNumstatArgs([])))).map((f) => [f.path, f]));
    assert.deepStrictEqual([changes.get("a.ts")!.added, changes.get("gone.ts")!.status, changes.get("to do é.txt")!.added], [1, "D", 0], "git diff counts the unstaged side; untracked 0");
    console.log("ok - real git: Staged and Changes from status, counts from their own diffs");
  }
  {
    // Ahead/behind against a real upstream: one commit to pull, two not pushed; none without one.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "polylog-upstream-"));
    const cwd = path.join(home, "repo");
    fs.mkdirSync(cwd);
    // An isolated HOME: the developer's own git config (signing, hooks) stays out.
    const who = { GIT_AUTHOR_NAME: "dana", GIT_AUTHOR_EMAIL: "dana@example.com", GIT_COMMITTER_NAME: "dana", GIT_COMMITTER_EMAIL: "dana@example.com" };
    const g = (args: string[]) => execFileSync("git", args, { cwd, env: { ...gitEnv(home), ...who } }).toString().trim();
    g(["init", "-q", "-b", "main"]);
    g(["commit", "-q", "--allow-empty", "-m", "base"]);
    await assert.rejects(runGit(cwd, aheadBehindArgs()), "no upstream: git fails, and nothing is shown");
    g(["branch", "up"]);
    g(["checkout", "-q", "up"]);
    g(["commit", "-q", "--allow-empty", "-m", "theirs"]);
    g(["checkout", "-q", "main"]);
    g(["commit", "-q", "--allow-empty", "-m", "mine 1"]);
    g(["commit", "-q", "--allow-empty", "-m", "mine 2"]);
    g(["branch", "-q", "--set-upstream-to=up"]);
    assert.deepStrictEqual(parseAheadBehind(await runGit(cwd, aheadBehindArgs())), { ahead: 2, behind: 1 });
    fs.rmSync(home, { recursive: true, force: true });
    console.log("ok - real git: commits ahead of and behind the upstream");
  }
  if (process.platform !== "win32") {
    // Fetch All's timeout: aborting kills git's whole process tree (ssh, remote helpers), not
    // only git. A shell alias stands in for a helper that keeps running.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "polylog-tree-"));
    const marker = `polylog-tree-${process.pid}-${Date.now()}`;
    const ctl = new AbortController();
    const run = new GitRunner(() => ["git"]).run(cwd, ["-c", `alias.hang=!sh -c 'sleep 30; : ${marker}'`, "hang"], ctl.signal, { tree: true });
    await new Promise((r) => setTimeout(r, 300));
    ctl.abort();
    await assert.rejects(run, (e: unknown) => isAbortError(e));
    await new Promise((r) => setTimeout(r, 300));
    const left = (() => { try { return execFileSync("pgrep", ["-f", marker]).toString().trim(); } catch { return ""; } })();
    assert.strictEqual(left, "", "no helper process is left behind");
    console.log("ok - aborting a tree run kills git's children too");
  }
  {
    // Aborted just after git exited but before its output closed, a run must still settle: a
    // promise left pending hangs whatever awaits it (a reload, Load More's in-progress flag).
    // A shell alias leaves a child holding stdout open, so "close" comes 400 ms after "exit".
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "polylog-abort-"));
    const ctl = new AbortController();
    const run = runGit(cwd, ["-c", "alias.lag=!(sleep 0.4 &)", "lag"], ctl.signal).then(() => "resolved", (e) => (isAbortError(e) ? "aborted" : `rejected: ${e}`));
    setTimeout(() => ctl.abort(), 150);
    const r = await Promise.race([run, new Promise((ok) => setTimeout(() => ok("pending"), 3000))]);
    assert.strictEqual(r, "aborted", "an abort after git exited still settles the run, as aborted");
    console.log("ok - an aborted git run always settles, however late the abort");
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

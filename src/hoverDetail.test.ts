import * as assert from "assert";
import { parseDecorations } from "./commitReferences";
import { EXPLAIN_COMMAND, HoverDetails } from "./hoverDetail";
import type { RunGit } from "./logQuery";
import type { HostMessage } from "./protocol";
import type { Commit, Repo } from "./types";

const repo: Repo = { id: "/ws/acme-web", name: "acme-web", root: "/ws/acme-web" };
const head = "a".repeat(40), old = "b".repeat(40);
const commits: Commit[] = [
  { repoId: repo.id, sha: head, time: 1, author: "dana", email: "dana@example.com", subject: "feat: retry", parents: [old], refs: parseDecorations("HEAD -> refs/heads/develop, refs/remotes/origin/develop") },
  { repoId: repo.id, sha: old, time: 0, author: "rin", email: "rin@example.com", subject: "fix: guard", parents: [] },
];
const SHOW = "feat: retry\n\nWhy.\x1e\n:100644 100644 aaaaaaa bbbbbbb M\0src/a.ts\0\n3\t1\tsrc/a.ts\0";
const HEADS = "refs/heads/develop\0\0origin\nrefs/remotes/origin/HEAD\0refs/remotes/origin/main\0\n";

function setup(opts: { commands?: string[]; show?: (signal?: AbortSignal) => Promise<string> } = {}) {
  const calls: string[] = [];
  const posts: Extract<HostMessage, { type: "hoverDetail" }>[] = [];
  const executed: [string, unknown][] = [];
  const signals: AbortSignal[] = [];
  const run: RunGit = async (_root, args, signal) => {
    calls.push(args[0]);
    if (signal) signals.push(signal);
    if (args[0] === "show") return opts.show ? opts.show(signal) : SHOW;
    if (args[0] === "for-each-ref") return HEADS;
    if (args[0] === "rev-list") return "2\t0\n";
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  const details = new HoverDetails({
    run, post: (m) => posts.push(m),
    commit: (repoId, sha) => { const commit = commits.find((c) => c.repoId === repoId && c.sha === sha); return commit ? { repo, commit } : undefined; },
    commands: {
      getCommands: async () => opts.commands ?? [],
      executeCommand: async (command, arg) => { executed.push([command, arg]); },
    },
  });
  return { details, calls, posts, executed, signals };
}

async function main(): Promise<void> {
  {
    const { details, calls, posts } = setup();
    await details.show(repo.id, old);
    assert.deepStrictEqual(calls, ["show"], "a row that is not HEAD costs one git show");
    assert.strictEqual(posts.length, 1);
    assert.deepStrictEqual(posts[0], { type: "hoverDetail", repoId: repo.id, sha: old, explain: false,
      detail: { message: "feat: retry\n\nWhy.", kinds: { added: 0, modified: 1, deleted: 0, renamed: 0 }, files: 1, added: 3, deleted: 1 } });
    await details.show(repo.id, old);
    assert.deepStrictEqual(calls, ["show", "show"], "nothing is kept between hovers");
    await details.show(repo.id, "c".repeat(40));
    await details.show("/ws/elsewhere", old);
    await details.show(repo.id, "--output=x");
    assert.strictEqual(calls.length, 2, "only a listed commit is read");
    console.log("ok - one git show per hover, none for a commit the Log does not list");
  }

  {
    const { details, calls, posts } = setup({ commands: [EXPLAIN_COMMAND] });
    await details.show(repo.id, head);
    assert.deepStrictEqual(calls.sort(), ["for-each-ref", "rev-list", "show"], "the HEAD row adds its merge target: two reads");
    assert.strictEqual(posts[0].explain, true, "Explain is offered once the command exists");
    assert.deepStrictEqual(posts[1], { type: "hoverDetail", repoId: repo.id, sha: head, target: { name: "origin/main", branch: "develop", ahead: 2, behind: 0 } });
    calls.length = 0;
    await details.show(repo.id, head);
    assert.deepStrictEqual(calls, ["show"], "the merge target is kept while HEAD stays");
    details.refsChanged(repo.id);
    calls.length = 0;
    await details.show(repo.id, head);
    assert.deepStrictEqual(calls.sort(), ["for-each-ref", "rev-list", "show"], "a ref change reads it again");
    console.log("ok - the HEAD row's merge target: two reads, kept in memory until HEAD or a ref moves");
  }

  {
    let release: (v: string) => void = () => undefined;
    const { details, posts, signals } = setup({ show: (signal) => new Promise((resolve, reject) => {
      release = resolve;
      signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }) });
    const shown = details.show(repo.id, old);
    await new Promise((r) => setTimeout(r, 0));
    details.end();
    assert.ok(signals[0].aborted, "closing the card kills its git show");
    release(SHOW);
    await shown;
    assert.deepStrictEqual(posts, [], "a killed read posts nothing");
    // A new hover kills the one before it.
    const first = details.show(repo.id, old);
    await new Promise((r) => setTimeout(r, 0));
    const second = details.show(repo.id, old);
    assert.ok(signals[1].aborted);
    await new Promise((r) => setTimeout(r, 0));
    release(SHOW);
    await Promise.all([first, second]);
    assert.strictEqual(posts.length, 1);
    console.log("ok - the card's read is killed when it closes or another opens");
  }

  {
    const { details, posts } = setup({ show: async () => { throw Object.assign(new Error("fatal: bad object"), { stderr: "fatal: bad object" }); } });
    await details.show(repo.id, old);
    assert.deepStrictEqual(posts, [{ type: "hoverDetail", repoId: repo.id, sha: old, error: "fatal: bad object", explain: false }]);
    console.log("ok - a failed git show says why, in the card");
  }

  {
    const compared: string[][] = [];
    const { details, executed } = setup({ commands: [EXPLAIN_COMMAND] });
    details.compare = async (...args) => { compared.push(args); };
    await details.action("copySha", repo.id, old);
    await details.action("openOnRemote", repo.id, old);
    await details.action("explain", repo.id, old);
    await details.action("compare", repo.id, head);
    assert.deepStrictEqual(compared, [], "Compare needs the merge target the card showed");
    await details.show(repo.id, head);
    await details.action("compare", repo.id, head);
    assert.deepStrictEqual(compared, [[repo.id, "origin/main", "develop"]], "Compare: the merge target ◀, the branch ▶");
    await details.action("rm -rf", repo.id, old);
    await details.action("copySha", repo.id, "c".repeat(40));
    assert.deepStrictEqual(executed, [["linyra.commitCopySha", { repoId: repo.id, sha: old }], ["linyra.commitOpenOnRemote", { repoId: repo.id, sha: old }], [EXPLAIN_COMMAND, { repoId: repo.id, sha: old }]]);
    const none = setup();
    await none.details.action("explain", repo.id, old);
    assert.deepStrictEqual(none.executed, [], "no Explain command, nothing run");
    console.log("ok - the footer's links run the commit row's commands on the card's commit");
  }
}
void main().catch((e) => { console.error(e); process.exitCode = 1; });

import assert from "node:assert/strict";
import { ChangeStatsReader, statsKey, type StatsBatch } from "./changeStatsReader";

const a = "a".repeat(40), b = "b".repeat(40), c = "c".repeat(40);
const roots: Record<string, string> = { "/w/acme-web": "/w/acme-web", "/w/acme-api": "/w/acme-api" };

(async () => {
  const runs: { cwd: string; input?: string }[] = [];
  const posts: StatsBatch[] = [];
  const reader = new ChangeStatsReader({
    run: async (cwd, _args, _signal, opts) => {
      runs.push({ cwd, input: opts?.input });
      return opts!.input!.trim().split("\n").map((sha, i) => `\x1e${sha}\n\n ${i + 1} files changed, ${10 * (i + 1)} insertions(+), ${i} deletions(-)\n`).join("");
    },
    rootOf: (id) => roots[id],
    maxConcurrency: () => 4,
    post: (batch) => posts.push(batch),
  });
  await reader.want([{ repoId: "/w/acme-web", sha: a }, { repoId: "/w/acme-web", sha: b }, { repoId: "/w/acme-api", sha: c }, { repoId: "/w/elsewhere", sha: c }]);
  assert.equal(runs.length, 2, "one git process per repository");
  assert.equal(runs.find((r) => r.cwd === "/w/acme-web")!.input, `${a}\n${b}\n`);
  assert.deepEqual(Object.assign({}, ...posts), { [statsKey("/w/acme-web", a)]: [1, 10, 0], [statsKey("/w/acme-web", b)]: [2, 20, 1], [statsKey("/w/acme-api", c)]: [1, 10, 0] });
  console.log("ok - Changes column: one git process per repository on screen; unknown repositories are not asked");

  runs.length = 0; posts.length = 0;
  await reader.want([{ repoId: "/w/acme-web", sha: b }, { repoId: "/w/acme-api", sha: c }]);
  assert.equal(runs.length, 0, "read once, answered from memory after");
  assert.deepEqual(posts, [{ [statsKey("/w/acme-web", b)]: [2, 20, 1], [statsKey("/w/acme-api", c)]: [1, 10, 0] }]);
  console.log("ok - Changes column: a commit's stats are read once a session");
})();

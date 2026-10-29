// Dev-only mock data. Neutral names only (CLAUDE.md constraint 3).
import type { Commit, Repo } from "../../src/types";
import { commitKey } from "../../src/types";

/** 2026-09-23T12:00:00Z — fixed so screenshots are reproducible. */
export const NOW = 1790164800;

const SUBJECTS = [
  "feat: add retry to uploader",
  "fix: guard nil response",
  "chore: bump deps",
  "docs: explain origin/release-1.4 branching",
  "refactor: split request builder",
  "test: cover empty pages",
  "feat(web): keyboard shortcuts for the commit table",
  "fix(api): handle 429 from upstream with backoff and jitter so one burst does not cascade across every client",
  "perf: cache parsed config",
  'revert: "feat: add retry to uploader"',
  "fix: unicode in filenames — café.txt ✓",
  "build: package release-1.4 (ACME-7)",
];
const AUTHORS = ["dana", "rin"] as const;
const BASE = ["acme-web", "acme-api", "acme-libs"];

export function mockRepos(scenario: string): Repo[] {
  if (scenario === "norepos") return [];
  // "longnames": long repo names that share a prefix, as big workspaces tend to have.
  const LONG = ["acme-web", "acme-mobile-shipper-ops", "acme-mobile-shipper-app", "acme-payments-gateway-worker", "acme-api"];
  const names = scenario === "many"
    ? [...BASE, ...Array.from({ length: 65 }, (_, i) => `acme-svc-${String(i + 1).padStart(2, "0")}`)]
    : scenario === "adjacent" ? ["acme-api", "acme-assets", "acme-docs", "acme-infra", "acme-libs", "acme-mobile", "acme-web", "acme-worker"]
    : scenario === "longnames" ? LONG : BASE;
  return names.map((name) => ({ id: `/work/${name}`, root: `/work/${name}`, name }));
}

function sha(n: number): string {
  let x = (n * 2654435761) >>> 0;
  let s = "";
  while (s.length < 40) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    s += x.toString(16).padStart(8, "0");
  }
  return s.slice(0, 40);
}

export function mockCommits(repos: Repo[], scenario: string): Commit[] {
  if (scenario === "empty") return [];
  if (scenario === "adjacent") {
    // The baseline palette repeats for api/web and libs/worker. Keep those bands
    // adjacent, with enough commits to exercise folded as well as expanded rows.
    return [0, 6, 4, 7, 1, 2, 3, 5, 0, 6].flatMap((repo, group) => Array.from({ length: 4 }, (_, i): Commit => ({
      repoId: repos[repo].id, sha: sha(group * 10 + i), parents: i < 3 ? [sha(group * 10 + i + 1)] : [],
      time: NOW - (group * 4 + i) * 120, author: "dana", email: "dana@example.com", subject: SUBJECTS[group % SUBJECTS.length],
    })));
  }
  if (scenario === "topology") {
    const rows: [number, number, number, string, number[]][] = [
      [0, 100, 0, "Merge release-1.4 into main", [101, 102]],
      [1, 200, 100, "api: newer independent change", []],
      [2, 300, 150, "libs: another independent change", []],
      [0, 101, 200, "main: target branch change", [104]],
      [0, 102, 800, "incoming: second release fix", [103]],
      [0, 103, 900, "incoming: first release fix", [104]],
      [0, 104, 1000, "root", []],
    ];
    return rows.map(([r, id, age, subject, parents]) => ({ repoId: repos[r].id, sha: sha(id), parents: parents.map(sha), time: NOW - age,
      author: "dana", email: "dana@example.com", subject }));
  }
  if (scenario === "graph") {
    const rows: [number, number, number[]][] = [
      [0, 1, [2, 4]], [0, 2, [3]], [0, 3, [5]], [1, 11, [12, 13]],
      [0, 4, [5]], [0, 5, [6]], [0, 6, [7]], [0, 7, []],
      [1, 12, [14]], [1, 13, [14]], [1, 14, [15]], [1, 15, []],
      [2, 21, [22]], [2, 22, [23]], [2, 23, [24]], [2, 24, [25]],
    ];
    return rows.map(([repo, id, parents], i) => ({ repoId: repos[repo].id, sha: sha(id), parents: parents.map(sha),
      time: NOW - i * 120, author: AUTHORS[i % 2], email: `${AUTHORS[i % 2]}@example.com`, subject: i === 0 ? "Merge release-1.4 into main" : SUBJECTS[i % SUBJECTS.length],
      refs: i === 0 ? [{ kind: "head", name: "HEAD" }, { kind: "local", name: "main" }, { kind: "remote", name: "origin/main" }]
        : i === 3 ? [{ kind: "local", name: "release-1.4" }, { kind: "remote", name: "origin/release-1.4" }]
        : i === 4 ? [{ kind: "local", name: "fix/preview" }] : [] }));
  }
  // "long": three repositories, deep history (few lanes: the graph draws author discs while scrolling).
  const perRepo = scenario === "many" ? 240 : scenario === "long" ? 1000 : 40;
  const out: Commit[] = [];
  repos.forEach((r, ri) => {
    for (let i = 0; i < perRepo; i++) {
      const n = ri * 10_000 + i;
      const author = AUTHORS[n % 2];
      out.push({
        repoId: r.id, sha: sha(n), time: NOW - (i * 3 + ri) * 3700 - (n % 7) * 60,
        author, email: `${author}@example.com`, subject: SUBJECTS[n % SUBJECTS.length],
        parents: i === perRepo - 1 ? [] : [sha(n + 1)],
        refs: i === 0 ? [{ kind: "local", name: "main" }, { kind: "remote", name: "origin/main" }] : [],
      });
    }
  });
  return out.sort((a, b) => b.time - a.time || (a.sha < b.sha ? -1 : 1));
}

/** A fixture-only Git walk: ready children first, then prefer the incoming parents. */
export function mockTopoWalk(commits: readonly Commit[]): Commit[] {
  const left = new Map(commits.map((c) => [commitKey(c), c]));
  const children = new Map(commits.map((c) => [commitKey(c), 0]));
  for (const c of commits) for (const sha of c.parents) {
    const key = commitKey({ repoId: c.repoId, sha });
    if (children.has(key)) children.set(key, children.get(key)! + 1);
  }
  const preferred: string[] = [], result: Commit[] = [];
  while (left.size) {
    let next: Commit | undefined;
    while (preferred.length && !next) {
      const key = preferred.pop()!;
      if (children.get(key) === 0) next = left.get(key);
    }
    next ??= [...left.values()].filter((c) => children.get(commitKey(c)) === 0).sort((a, b) => b.time - a.time)[0];
    if (!next) throw new Error("cyclic mock commit graph");
    left.delete(commitKey(next)); result.push(next);
    for (const sha of next.parents) {
      const key = commitKey({ repoId: next.repoId, sha });
      if (!children.has(key)) continue;
      children.set(key, children.get(key)! - 1); preferred.push(key);
    }
  }
  return result;
}

// Dev-only Insights data: commits, files and health for the neutral fixture repositories
// (CLAUDE.md constraint 3). Deterministic, so screenshots reproduce.
import type { BubbleCommit } from "../../../src/insights/protocol";
import type { InsightsRepo } from "../../../src/insights/protocol";
import type { HealthFacts } from "../../../src/insights/health";

/** 2026-09-23T12:00:00Z, as the Log's harness. */
export const INSIGHTS_NOW = 1790164800;

export const INSIGHTS_REPOS: InsightsRepo[] = [
  { id: "/work/acme-web", name: "acme-web", accent: 1 },
  { id: "/work/acme-api", name: "acme-api", accent: 3 },
  { id: "/work/acme-libs", name: "acme-libs", accent: 4 },
];

const PEOPLE = [["dana", "dana@example.com"], ["rin", "rin@example.com"], ["noor", "noor@example.com"], ["sam", "sam@example.com"], ["kit", "kit@example.com"], ["lee", "lee@example.com"]] as const;
const SUBJECTS = ["feat: add retry to uploader", "fix: guard nil response", "chore: bump deps", "docs: explain origin/release-1.4 branching", "refactor: split request builder",
  "test: cover empty pages", "perf: cache parsed config", "fix(api): handle 429 from upstream with backoff", "build: package release-1.4", "style: format the client"];

function random(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    return x / 4294967296;
  };
}

function sha(n: number): string {
  let x = (n * 2654435761) >>> 0, s = "";
  while (s.length < 40) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    s += x.toString(16).padStart(8, "0");
  }
  return s.slice(0, 40);
}

/**
 * What Health reads per repository: acme-web big and neglected (no commit-graph, many loose
 * objects, many files, nothing set), acme-api tuned, acme-libs small.
 */
export function mockHealth(): Record<string, HealthFacts> {
  const objects = (loose: number, packs: number, packKiB: number) => ({ loose, looseKiB: loose * 4, inPack: 180_000, packs, packKiB, prunePackable: 0, garbage: 0 });
  return {
    "/work/acme-web": { root: "/work/acme-web", commitGraph: false, objects: objects(8_412, 61, 412_000), tracked: 128_400, config: new Map() },
    "/work/acme-api": { root: "/work/acme-api", commitGraph: true, objects: objects(220, 3, 96_000), tracked: 54_200,
      config: new Map([["core.untrackedcache", ["true"]], ["core.fsmonitor", ["true"]], ["maintenance.repo", ["/work/acme-api"]]]) },
    "/work/acme-libs": { root: "/work/acme-libs", commitGraph: true, objects: objects(35, 1, 4_200), tracked: 2_310, config: new Map() },
  };
}

/** Tracked files and their sizes: a web app, a Go service and a package workspace. */
export function mockFiles(scale = 1): Record<string, { path: string; size: number }[]> {
  const next = random(11);
  const many = (dir: string, names: string[], ext: string, base: number, n = names.length) =>
    Array.from({ length: n * scale }, (_, i) => ({ path: `${dir}/${names[i % names.length]}${i >= names.length ? `-${Math.floor(i / names.length)}` : ""}.${ext}`, size: Math.floor(base * (0.3 + next() * 1.4)) }));
  return {
    "/work/acme-web": [
      ...many("src/components", ["Button", "Dialog", "Table", "Toolbar", "Sidebar", "Upload", "Avatar", "Menu"], "tsx", 4200),
      ...many("src/api", ["client", "retry", "auth", "upload"], "ts", 3100),
      ...many("src/styles", ["theme", "layout", "table"], "css", 2600),
      ...many("public/images", ["logo", "hero", "empty-state", "avatar-default"], "png", 48_000),
      { path: "package-lock.json", size: 410_000 }, { path: "package.json", size: 2100 }, { path: "README.md", size: 5400 }, { path: "tsconfig.json", size: 700 },
    ],
    "/work/acme-api": [
      ...many("cmd/server", ["main", "flags"], "go", 3800),
      ...many("internal/upload", ["upload", "retry", "chunk", "store", "upload_test", "retry_test"], "go", 6100),
      ...many("internal/auth", ["token", "session", "middleware"], "go", 4400),
      ...many("docs", ["api", "deploy", "release-1.4"], "md", 7000),
      { path: "go.sum", size: 86_000 }, { path: "go.mod", size: 1400 }, { path: "Makefile", size: 2200 },
    ],
    "/work/acme-libs": [
      ...many("packages/core/src", ["index", "events", "format", "parse", "cache"], "ts", 5200),
      ...many("packages/ui/src", ["Chip", "Pill", "Tooltip", "Popover"], "tsx", 3900),
      ...many("packages/ui/assets", ["icons", "sprites"], "svg", 31_000),
      { path: "CHANGELOG.md", size: 24_000 }, { path: "pnpm-lock.yaml", size: 240_000 },
    ],
  };
}

/** How many commits touched each file in the range: a few hot files, a long tail touched once. */
export function mockTouches(files: Record<string, { path: string; size: number }[]>, weeks: number): Record<string, { path: string; value: number }[]> {
  const next = random(23);
  const hot = new Set(["src/api/client.ts", "src/components/Table.tsx", "internal/upload/upload.go", "internal/upload/retry.go", "packages/core/src/parse.ts", "CHANGELOG.md", "package.json", "go.mod"]);
  return Object.fromEntries(Object.entries(files).map(([repo, list]) => [repo, list.flatMap((f) => {
    const touched = hot.has(f.path) ? Math.ceil(weeks * (1.5 + next() * 2)) : next() < 0.45 ? Math.ceil(next() * weeks * 0.4) : 0;
    return touched > 0 ? [{ path: f.path, value: touched }] : [];
  })]));
}

/** About `perDay` commits a day over the last `days` days, mostly dana and rin, the odd huge one. */
export function mockBubbles(days: number, perDay: number, authors: number = PEOPLE.length): BubbleCommit[] {
  const next = random(7);
  const out: BubbleCommit[] = [];
  const total = Math.round(days * perDay);
  for (let i = 0; i < total; i++) {
    const who = PEOPLE[Math.min(authors - 1, Math.floor(Math.pow(next(), 1.8) * authors))];
    const repo = INSIGHTS_REPOS[Math.floor(next() * INSIGHTS_REPOS.length)];
    const lines = Math.floor(Math.pow(next(), 3) * 400) + (i % 97 === 0 ? 20_000 : 0);
    const added = Math.round(lines * (0.3 + next() * 0.7));
    out.push({ repoId: repo.id, sha: sha(i + 1), time: INSIGHTS_NOW - Math.floor(next() * days * 86_400), author: who[0], email: who[1],
      subject: SUBJECTS[i % SUBJECTS.length], added, deleted: lines - added, files: 1 + Math.floor(next() * 9) });
  }
  return out.sort((a, b) => b.time - a.time);
}

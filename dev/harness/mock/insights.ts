// Dev-only Insights data: commits, files and health for the neutral fixture repositories
// (CLAUDE.md constraint 3). Deterministic, so screenshots reproduce.
import type { BubbleCommit } from "../../../src/insights/protocol";
import type { InsightsRepo } from "../../../src/insights/protocol";

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

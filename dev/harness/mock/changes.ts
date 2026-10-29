// Dev-only: the host's answer to the Changes column's wantStats. Each commit's stats come from its
// id, so every load draws the same column: small, large, deletion-only and empty commits.
// ?stats=off: no answer (the cells stay pending).
import type { HostMessage, WebviewMessage } from "../../../src/protocol";

const ANSWER_MS = 60;

function statsOf(sha: string): [number, number, number] {
  const n = parseInt(sha.slice(0, 8), 16) || 0;
  const kind = n % 7;
  if (kind === 0) return [0, 0, 0];
  if (kind === 1) return [1 + (n % 3), 0, 3 + (n % 40)];
  if (kind === 2) return [20 + (n % 140), 900 + (n % 2400), 300 + (n % 900)];
  return [1 + (n % 9), 1 + (n % 220), n % 90];
}

export function answerStats(m: Extract<WebviewMessage, { type: "wantStats" }>, send: (m: HostMessage, delay?: number) => void): void {
  if (new URLSearchParams(location.search).get("stats") === "off") return;
  const byKey: Record<string, [number, number, number]> = {};
  for (const { repoId, sha } of m.commits) byKey[`${repoId}\0${sha}`] = statsOf(sha);
  send({ type: "stats", byKey }, ANSWER_MS);
}

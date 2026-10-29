// Dev-only: the host's side of the commit hover card (src/hoverDetail.ts), and branch decorations
// for the default rows so the Log shows every kind of pill. Neutral names only (CLAUDE.md constraint 3).
import type { CommitReference } from "../../../src/commitReferences";
import type { HostMessage, WebviewMessage } from "../../../src/protocol";
import type { Commit } from "../../../src/types";

const params = new URLSearchParams(location.search);
/** ?hoverDelay=ms: how long the mock git show takes (a slow repository). */
const DELAY = Number(params.get("hoverDelay") ?? 150);
/** ?explain=off: Linyra's AI features are not there, so the card has no Explain link. */
const EXPLAIN = params.get("explain") !== "off";

const decorations: Record<string, Record<number, CommitReference[]>> = {
  "acme-web": {
    0: [{ kind: "head", name: "HEAD" }, { kind: "local", name: "develop", current: true }, { kind: "remote", name: "origin/develop" }, { kind: "tag", name: "v1.4.0" }],
    2: [{ kind: "local", name: "master" }, { kind: "remote", name: "origin/master" }, { kind: "remote", name: "origin/release-1.4" }, { kind: "tag", name: "v1.3.1" }, { kind: "tag", name: "v1.3.0" }],
  },
  "acme-api": { 0: [{ kind: "head", name: "HEAD" }, { kind: "local", name: "develop", current: true }, { kind: "remote", name: "origin/develop" }], 3: [{ kind: "remote", name: "origin/master" }] },
  "acme-libs": { 0: [{ kind: "head", name: "HEAD" }, { kind: "tag", name: "v2.0.0-rc.1" }], 1: [{ kind: "local", name: "develop" }, { kind: "remote", name: "origin/develop" }] },
};

/** The default rows' references: a checked-out branch with its remote, tags, a remote-only branch, a detached HEAD. */
export function mockRefs(commits: Commit[], scenario: string): Commit[] {
  if (scenario !== "default") return commits;
  const seen = new Map<string, number>();
  return commits.map((c) => {
    const name = c.repoId.split("/").pop()!;
    const n = seen.get(c.repoId) ?? 0;
    seen.set(c.repoId, n + 1);
    const refs = decorations[name]?.[n];
    return refs ? { ...c, refs } : n === 0 ? { ...c, refs: [] } : c;
  });
}

let pending: ReturnType<typeof setTimeout>[] = [];
const reply = (m: HostMessage, delay: number) => pending.push(setTimeout(() => window.postMessage(m, "*"), delay));

/** Answers the hover card's messages; false for every other message. */
export function hoverReply(m: WebviewMessage, all: readonly Commit[]): boolean {
  if (m.type === "hoverEnd") {
    // The host kills its git show: nothing it was reading arrives.
    pending.forEach(clearTimeout);
    pending = [];
    return true;
  }
  if (m.type === "hoverAction") { console.info("[harness] hoverAction", m.action); return true; }
  if (m.type !== "hover") return false;
  const c = all.find((x) => x.repoId === m.repoId && x.sha === m.sha);
  if (!c) return true;
  const key = { repoId: c.repoId, sha: c.sha };
  const merge = c.parents.length > 1;
  reply({ type: "hoverDetail", ...key, explain: EXPLAIN, detail: {
    message: `${c.subject}\n\n${merge ? "Brings in the release fixes." : "Keep the upload preview in step with the saved configuration,\nso a retry sends what the user saw."}\n\nCo-Authored-By: rin <rin@example.com>`,
    kinds: { added: 1, modified: 3, deleted: 1, renamed: 0 }, files: 5, added: 42, deleted: 7,
  } }, DELAY);
  if (c.refs?.some((r) => r.kind === "local" && r.current)) {
    reply({ type: "hoverDetail", ...key, target: { name: "origin/main", branch: c.refs.find((r) => r.current)!.name, ahead: 2, behind: 0 } }, DELAY + 40);
  }
  return true;
}

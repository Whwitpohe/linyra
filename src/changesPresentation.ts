import type { ChangesState, CombinedState } from "./changesModel";
import type { CommitDetails } from "./changesProtocol";
import { UNCOMMITTED, type Commit } from "./types";

function detail(c: Commit, repoName: string, message = c.subject): CommitDetails {
  const lines = message.replace(/\r\n/g, "\n").split("\n");
  return { repoId: c.repoId, repoName, sha: c.sha, title: lines.shift() || c.subject,
    body: lines.join("\n").replace(/^\n/, ""), author: c.author, email: c.email, time: c.time, parents: c.parents };
}

export function commitDetails(state: ChangesState | null, combined: CombinedState | null): CommitDetails[] {
  if (combined) return combined.repos.flatMap((r) => r.commits.map((c) => ({ ...detail(c, r.repoName), accent: r.accent })));
  if (!state || state.commit.sha === UNCOMMITTED) return [];
  return [{ ...detail(state.commit, state.repoName, state.message || state.commit.subject), accent: state.repoAccent,
    refs: state.references?.refs, containingBranches: state.references?.containingBranches }];
}

/** Both panes remain reachable, even when the whole panel becomes very short. */
export function detailHeight(wanted: number, available: number): number {
  const total = Math.max(0, available - 6);
  const minimum = Math.min(96, total * 0.4);
  const maximum = Math.max(minimum, total - Math.min(96, total * 0.4));
  return Math.round(Math.min(maximum, Math.max(minimum, Number.isNaN(wanted) ? 240 : wanted)));
}

// Dev-only: the host's answers to the branch sheet (a pill's click). Neutral names only.
// ?sheet= picks a state for the local branch: diverged (default), ahead, behind, clean, unpublished,
// gone, merged, unknown (conflicts not known), worktree (checked out in another worktree).
import type { BranchSheetData } from "../../../src/branchSheetModel";
import type { HostMessage, WebviewMessage } from "../../../src/protocol";

const NOW = 1790164800;

export function branchSheetReply(m: WebviewMessage, send: (m: HostMessage) => void, params: URLSearchParams): boolean {
  if (m.type !== "branchSheet") return false;
  if (m.action !== "open") return true;
  const name = m.ref.replace(/^refs\/(heads|remotes|tags)\//, "");
  const kind = m.ref.startsWith("refs/remotes/") ? "remote" : m.ref.startsWith("refs/tags/") ? "tag" : "local";
  const repoName = m.repoId.split("/").pop() ?? m.repoId;
  const state = params.get("sheet") ?? "diverged";
  const base: BranchSheetData = {
    repoId: m.repoId, repoName, ref: m.ref, name, kind, current: kind === "local" && state !== "worktree" && state !== "merged",
    tip: { sha: "a42a50e9c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6", subject: "feat(web): keyboard shortcuts for the commit table", author: "dana", time: NOW - 2 * 86400 },
    ai: params.get("ai") !== "off",
  };
  const local = (): BranchSheetData => {
    const upstream = { name: "origin/" + name, ahead: 0, behind: 0, gone: false };
    const target = { name: "origin/main", ahead: 4, behind: 0, conflicts: undefined as number | null | undefined };
    switch (state) {
      case "diverged": Object.assign(upstream, { ahead: 2, behind: 1 }); Object.assign(target, { behind: 3, conflicts: 2 }); break;
      case "ahead": upstream.ahead = 3; break;
      case "behind": upstream.behind = 3; Object.assign(target, { behind: 5, conflicts: 0 }); break;
      case "unknown": Object.assign(target, { behind: 5, conflicts: null }); break;
      case "unpublished": return { ...base, upstream: { name: null, ahead: 0, behind: 0, gone: false }, target };
      case "gone": upstream.gone = true; break;
      case "merged": target.ahead = 0; break;
      case "worktree": return { ...base, worktree: "/work/acme-web-hotfix", upstream, target };
    }
    return { ...base, upstream, target: target.conflicts === undefined ? { name: target.name, ahead: target.ahead, behind: target.behind } : target };
  };
  // Answered a moment later, as git would be: the sheet shows its header first.
  setTimeout(() => send({ type: "branchSheet", repoId: m.repoId, ref: m.ref, data: kind === "local" ? local() : base }), 60);
  return true;
}

// The Log's Uncommitted rows as plain data: each row's branch pill and the header's totals tooltip.
// Pure: no DOM, no vscode.
import type { KindCounts } from "../changeKinds";
import { localize } from "../i18n";
import { syncLabel } from "../upstream";
import type { BranchStatus } from "../workingTree";
import { countsLabel } from "./ui/counts";
import type { PillSegment } from "./ui/pill";

/**
 * The branch pill of a row, as GitLens draws its WIP row: "⎇ develop ↑1 ↓2"; "⎇ develop | ☁" in
 * step with its upstream; "⎇ develop unpublished" without one (or with a gone one); a detached
 * HEAD by its commit.
 */
export function workPill(b: BranchStatus, head: string | null): PillSegment[] {
  if (b.name === null) {
    const sha = head?.slice(0, 7) ?? "HEAD";
    return [{ kind: "detached", label: sha, title: localize("HEAD detached at {0}", sha) }];
  }
  const local: PillSegment = { kind: "local", label: b.name, current: true };
  if (b.upstream === null) return [{ ...local, unpublished: true, title: localize("{0} · no upstream", b.name) }];
  if (b.gone) return [{ ...local, unpublished: true, title: localize("{0} · its upstream {1} is gone", b.name, b.upstream) }];
  if (b.uncounted) return [{ ...local, title: localize("{0} · differs from {1}", b.name, b.upstream) }];
  const sync = syncLabel(b);
  if (sync) return [{ ...local, ahead: b.ahead, behind: b.behind, title: `${b.name} · ${b.upstream} · ${sync.title}` }];
  // In step: the cloud alone says so (its label is empty; the title names the upstream).
  return [{ ...local, title: b.name }, { kind: "remote", label: "", title: localize("up to date with {0}", b.upstream) }];
}

/** The header totals' tooltip: the files by kind, then how many repositories and lines. */
export function totalsTitle(kinds: KindCounts, t: { repos: number; added: number; deleted: number }): string {
  const repos = localize("{0} {1}", t.repos, localize(t.repos === 1 ? "repository" : "repositories"));
  return `${countsLabel(kinds)}\n${repos} · ${localize("{0} lines added, {1} deleted", t.added, t.deleted)}`;
}

export type MeterKind = keyof KindCounts;

/** A row's change meter, kept beside its counts: each kind's share of the files, empty kinds left out. */
export function meterParts(c: KindCounts): { kind: MeterKind; share: number }[] {
  const kinds = ["added", "modified", "renamed", "deleted"] as const;
  const total = kinds.reduce((n, k) => n + c[k], 0);
  if (total === 0) return [];
  return kinds.filter((k) => c[k] > 0).map((kind) => ({ kind, share: c[kind] / total }));
}

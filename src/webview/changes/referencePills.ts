// The commit details' references as branch pills. Pure: no DOM.
import type { CommitReference } from "../../commitReferences";
import type { PillSegment } from "../ui/pill";

/**
 * A local branch and the remote branches of the same name share one pill ("main | origin"), tags
 * are pills of their own, and HEAD is one only when no local branch points here (detached).
 * Remote branches without a local one come last, as the old detail listed them.
 */
export function referencePills(refs: readonly CommitReference[]): PillSegment[][] {
  const locals = refs.filter((r) => r.kind === "local");
  const remotes = refs.filter((r) => r.kind === "remote");
  const paired = new Set<CommitReference>();
  const pills: PillSegment[][] = [];
  if (refs.some((r) => r.kind === "head") && locals.length === 0) pills.push([{ kind: "detached", label: "HEAD" }]);
  for (const local of locals) {
    const mates = remotes.filter((r) => !paired.has(r) && r.name.endsWith(`/${local.name}`));
    for (const r of mates) paired.add(r);
    pills.push([{ kind: "local", label: local.name },
      ...mates.map((r): PillSegment => ({ kind: "remote", label: r.name.slice(0, -local.name.length - 1), title: r.name }))]);
  }
  for (const tag of refs.filter((r) => r.kind === "tag")) pills.push([{ kind: "tag", label: tag.name }]);
  for (const r of remotes) if (!paired.has(r)) pills.push([{ kind: "remote", label: r.name }]);
  return pills;
}

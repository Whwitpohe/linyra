// The commit details' references as branch pills. Pure: no DOM.
import { refGroups, type CommitReference } from "../../commitReferences";
import { localize } from "../../i18n";
import type { PillSegment } from "../ui/pill";

/**
 * The Log's pills (refGroups: the checked-out branch first, a branch and its same-name remotes in
 * one pill, a detached HEAD alone), with HEAD named on the checked-out branch's pill: the details
 * have the room the Log row does not, and say where HEAD is in words.
 */
export function referencePills(refs: readonly CommitReference[]): PillSegment[][] {
  return refGroups(refs).map((pill) => pill.some((s) => s.current) ? [{ kind: "head", label: "HEAD", title: localize("HEAD (checked out)") }, ...pill] : pill);
}

export interface Containing {
  heading: string;
  /** The branches that contain the commit but do not point at it: the pills above already name those. */
  pills: PillSegment[][];
}

const key = (r: CommitReference): string => `${r.kind}\0${r.name}`;

/**
 * "In N branches", without repeating the pills above: the branches pointing at the commit are
 * there, so the list holds the rest, and the heading says whether there are any.
 */
export function containingBranches(refs: readonly CommitReference[], containing: readonly CommitReference[]): Containing {
  const here = new Set(refs.map(key));
  const others = containing.filter((r) => !here.has(key(r)));
  // A detached HEAD drawn above is no branch: a commit only it holds is in none.
  const above = containing.some((r) => r.kind !== "head" && here.has(key(r)));
  const n = others.length;
  const heading = n === 0 ? (above ? localize("In no other branch.") : localize("Not in any branch."))
    : above ? (n === 1 ? localize("Also in 1 other branch:") : localize("Also in {0} other branches:", n))
    : n === 1 ? localize("In 1 branch:") : localize("In {0} branches:", n);
  return { heading, pills: referencePills(others) };
}

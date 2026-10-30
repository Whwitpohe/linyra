import "./refPills.css";
import { branchGroupKey, branchKey } from "../branchModel";
import { refGroups, refPillContext, withUpstream, type CommitReference, type RefSegment } from "../commitReferences";
import { localize } from "../i18n";
import { h } from "./dom";
import { repoTreeKey } from "./repoTreeModel";
import { renderPill } from "./ui/pill";

/** Each repository's distance from its upstream (the host's sync message: only those ahead or behind). */
export type Upstream = Readonly<Record<string, { ahead: number; behind: number }>>;

/** A commit's branch pills as the Log row and the hover card draw them: the checked-out branch with its upstream state. */
export function commitPills(repoId: string, refs: readonly CommitReference[] | undefined, upstream: Upstream | undefined): RefSegment[][] {
  return refs?.length ? refGroups(refs).map((pill) => withUpstream(pill, upstream?.[repoId])) : [];
}

/** What a part names and what its click and right-click do: its tooltip. */
export function partTitle(s: RefSegment): string {
  const name = s.title ?? s.label;
  const what = s.kind === "tag" ? localize("Tag {0}", name) : s.kind === "remote" ? localize("Remote branch {0}", name)
    : s.current ? localize("Branch {0}, checked out", name) : localize("Branch {0}", name);
  const state = s.kind === "local" && s.current
    ? [s.unpublished ? localize("unpublished") : "", s.ahead ? localize("{0} ahead", s.ahead) : "", s.behind ? localize("{0} behind", s.behind) : ""].filter(Boolean) : [];
  return `${[what, ...state].join(" · ")}\n${localize("Click for its details, right-click for its actions.")}`;
}

/**
 * One pill. Each part is its own target, as GitLens's are: a click shows that branch (the
 * branch sheet, data-repo and data-ref), a right-click opens that branch's menu (webviewSection
 * refPill), the pointer deepens that part alone. The pill keeps its first part's as well, for
 * markPills and the menu between parts. A detached HEAD has none of these.
 */
export function pillElement(repoId: string, pill: readonly RefSegment[], className = ""): HTMLElement {
  const context = refPillContext(repoId, pill);
  const el = renderPill(pill, context ? { ...context } : undefined, className);
  if (!context) return el;
  el.dataset.repo = repoId;
  el.dataset.ref = context.ref;
  const parts = el.querySelectorAll<HTMLElement>(".pill-part");
  pill.forEach((s, i) => {
    const own = refPillContext(repoId, [s]), part = parts[i];
    if (!own || !part) return;
    part.dataset.repo = repoId;
    part.dataset.ref = own.ref;
    part.dataset.vscodeContext = JSON.stringify({ preventDefaultContextMenuItems: true, ...own });
    part.title = partTitle(s);
  });
  return el;
}

/** A Log row's references: whole pills, and "+N" for those that do not fit (CommitList.fitReferences). */
export function rowRefs(repoId: string, pills: readonly RefSegment[][]): HTMLElement | null {
  if (pills.length === 0) return null;
  const names = pills.map((p) => p.map((s) => s.title ?? s.label).join(" · ")).join(", ");
  return h("span", { class: "row-refs" }, [
    ...pills.map((p) => pillElement(repoId, p, "row-ref")),
    h("span", { class: "row-ref-more", "aria-label": `${localize("Commit references")}: ${names}` }, [`+${pills.length}`]),
  ]);
}

/** The Repo List rows that show a branch: those to open, and the branch row's own key (RepoPane.reveal). */
export function revealTarget(repoId: string, ref: string): { key: string; expand: string[] } {
  const kind = ref.startsWith("refs/tags/") ? "tag" : ref.startsWith("refs/remotes/") ? "remote" : "local";
  const expand = [repoTreeKey(repoId), branchGroupKey(kind, repoId)];
  // A remote branch sits under its remote's row, named by the ref's first part (as the Repo List groups them).
  if (kind === "remote") expand.push(`${branchGroupKey("remote", repoId)}\0${ref.slice("refs/remotes/".length).split("/")[0]}`);
  return { key: branchKey(repoId, ref), expand };
}

import { localize } from "./i18n";
import type { RunGit } from "./logQuery";
import type { PillSegment } from "./webview/ui/pill";

export interface CommitReference {
  kind: "head" | "local" | "remote" | "tag";
  name: string;
  /** A local branch only: the one HEAD points to (checked out). Without it, a HEAD beside branches is detached. */
  current?: true;
}

export interface CommitReferences {
  refs: CommitReference[];
  containingBranches: string[];
}

/** --decorate=full makes namespaces explicit; a space cannot occur inside a ref name. */
export function parseDecorations(value: string): CommitReference[] {
  const refs: CommitReference[] = [];
  for (const part of value.split(", ")) {
    // "HEAD -> refs/heads/x": x is checked out. A bare "HEAD" is detached, wherever branches point.
    const attached = part.startsWith("HEAD -> ");
    if (part === "HEAD" || attached) refs.push({ kind: "head", name: "HEAD" });
    const ref = part.replace(/^HEAD -> /, "").replace(/^tag: /, "");
    const match = /^refs\/(heads|remotes|tags)\/(.+)$/.exec(ref);
    if (!match) continue;
    const kind = match[1] === "heads" ? "local" : match[1] === "remotes" ? "remote" : "tag";
    refs.push(attached && kind === "local" ? { kind, name: match[2], current: true } : { kind, name: match[2] });
  }
  return refs;
}

/** One part of a branch pill, with the full ref name a right-click acts on ("refs/heads/develop"; "HEAD" when detached). */
export interface RefSegment extends PillSegment {
  ref: string;
}

/** "origin" for origin/develop beside develop; undefined for another branch (origin/feature/develop) or a remote name with a slash. */
function remoteOf(remoteRef: string, local: string): string | undefined {
  if (!remoteRef.endsWith(`/${local}`)) return undefined;
  const remote = remoteRef.slice(0, -local.length - 1);
  return remote && !remote.includes("/") ? remote : undefined;
}

/**
 * A commit's references as branch pills, in the JetBrains Log's order: the checked-out branch
 * first, the other local branches, the remote branches no local one shares, then tags. A local
 * branch and the remotes whose branch of that name points here too share one pill
 * ("develop | origin"); a remote's symbolic HEAD (origin/HEAD) is no branch; HEAD is a pill of its
 * own only when detached. `headBranch`: the checked-out branch, when the caller knows it (null:
 * detached); otherwise the references say which (parseDecorations marks it).
 */
export function refGroups(refs: readonly CommitReference[], headBranch?: string | null): RefSegment[][] {
  const locals = refs.filter((r) => r.kind === "local");
  const current = headBranch !== undefined ? headBranch : locals.find((r) => r.current)?.name ?? null;
  const remotes = refs.filter((r) => r.kind === "remote" && !r.name.endsWith("/HEAD"));
  const shared = new Set<CommitReference>();
  const pills: RefSegment[][] = [];
  if (refs.some((r) => r.kind === "head") && !locals.some((r) => r.name === current)) {
    pills.push([{ kind: "detached", label: "HEAD", title: localize("HEAD is detached"), ref: "HEAD" }]);
  }
  for (const local of [...locals].sort((a, b) => Number(b.name === current) - Number(a.name === current))) {
    const pill: RefSegment[] = [{ kind: "local", label: local.name, ref: `refs/heads/${local.name}`, ...(local.name === current ? { current: true } : {}) }];
    for (const r of remotes) {
      const remote = shared.has(r) ? undefined : remoteOf(r.name, local.name);
      if (remote === undefined) continue;
      shared.add(r);
      pill.push({ kind: "remote", label: remote, title: r.name, ref: `refs/remotes/${r.name}` });
    }
    pills.push(pill);
  }
  for (const r of remotes) if (!shared.has(r)) pills.push([{ kind: "remote", label: r.name, ref: `refs/remotes/${r.name}` }]);
  for (const r of refs) if (r.kind === "tag") pills.push([{ kind: "tag", label: r.name, ref: `refs/tags/${r.name}` }]);
  return pills;
}

/** The checked-out branch's pill with its distance from its upstream (the Log's sync message). */
export function withUpstream(pill: readonly RefSegment[], ab: { ahead: number; behind: number } | undefined): RefSegment[] {
  return ab ? pill.map((s) => (s.kind === "local" && s.current ? { ...s, ahead: ab.ahead, behind: ab.behind } : s)) : [...pill];
}

export interface RefPillContext {
  webviewSection: "refPill";
  repoId: string;
  /** The full ref name, as the Repo List's branch commands take it. */
  ref: string;
  kind: "local" | "remote" | "tag";
  current: boolean;
}

/** A pill's right-click (package.json webview/context): the branch commands the Repo List has. None for a detached HEAD. */
export function refPillContext(repoId: string, pill: readonly RefSegment[]): RefPillContext | undefined {
  const s = pill[0];
  if (!s || (s.kind !== "local" && s.kind !== "remote" && s.kind !== "tag")) return undefined;
  return { webviewSection: "refPill", repoId, ref: s.ref, kind: s.kind, current: s.current === true };
}

export const referenceArgs = (sha: string): string[] => ["for-each-ref", `--contains=${sha}`,
  "--format=%(refname)%00%(objectname)%00%(*objectname)%00%(symref)%00%(HEAD)", "refs/heads", "refs/remotes", "refs/tags"];

/** Symbolic remote HEADs alias a branch; they must not add a duplicate to its count. */
export function parseReferences(output: string, sha: string, head: string, headContains: boolean): CommitReferences {
  const refs: CommitReference[] = head === sha ? [{ kind: "head", name: "HEAD" }] : [];
  const branches: { name: string; current: boolean }[] = [];
  for (const line of output.split("\n")) {
    const [ref, object, peeled, symbolic, current] = line.replace(/\r$/, "").split("\0");
    const m = /^refs\/(heads|remotes|tags)\/(.+)$/.exec(ref);
    if (!m || symbolic) continue;
    const kind = m[1] === "heads" ? "local" : m[1] === "remotes" ? "remote" : "tag";
    if (kind !== "tag") branches.push({ name: m[2], current: current === "*" });
    if (object === sha || peeled === sha) refs.push(kind === "local" && current === "*" ? { kind, name: m[2], current: true } : { kind, name: m[2] });
  }
  const containingBranches = branches.sort((a, b) => Number(b.current) - Number(a.current)).map((b) => b.name);
  if (headContains) containingBranches.unshift("HEAD");
  return { refs, containingBranches: [...new Set(containingBranches)] };
}

/** Read on selection; no history scan, persisted cache or working-tree mutation. */
export async function readReferences(run: RunGit, root: string, sha: string, signal: AbortSignal): Promise<CommitReferences> {
  const [output, head] = await Promise.all([
    run(root, referenceArgs(sha), signal),
    run(root, ["rev-parse", "--verify", "HEAD"], signal).then((s) => s.trim()),
  ]);
  const currentContains = output.split("\n").some((line) => line.trimEnd().endsWith("\0*"));
  const headContains = head === sha || currentContains || await run(root, ["merge-base", "--is-ancestor", sha, "HEAD"], signal).then(() => true, () => false);
  return parseReferences(output, sha, head, headContains);
}

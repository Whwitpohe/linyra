import type { RunGit } from "./logQuery";

export interface CommitReference {
  kind: "head" | "local" | "remote" | "tag";
  name: string;
}

export interface CommitReferences {
  refs: CommitReference[];
  containingBranches: string[];
}

/** --decorate=full makes namespaces explicit; a space cannot occur inside a ref name. */
export function parseDecorations(value: string): CommitReference[] {
  const refs: CommitReference[] = [];
  for (const part of value.split(", ")) {
    if (part === "HEAD" || part.startsWith("HEAD -> ")) refs.push({ kind: "head", name: "HEAD" });
    const ref = part.replace(/^HEAD -> /, "").replace(/^tag: /, "");
    const match = /^refs\/(heads|remotes|tags)\/(.+)$/.exec(ref);
    if (match) refs.push({ kind: match[1] === "heads" ? "local" : match[1] === "remotes" ? "remote" : "tag", name: match[2] });
  }
  return refs;
}

/** A local branch and its remote tips share one compact label, as in an IDE log. */
export function referenceLabels(refs: readonly CommitReference[]): { label: string; kinds: CommitReference["kind"][]; title: string }[] {
  const used = new Set<CommitReference>();
  const labels: { label: string; kinds: CommitReference["kind"][]; title: string }[] = [];
  for (const ref of refs) {
    if (used.has(ref) || (ref.kind === "head" && refs.some((r) => r.kind === "local"))) continue;
    if (ref.kind === "remote" && refs.some((r) => r.kind === "local" && ref.name.endsWith(`/${r.name}`))) continue;
    const remotes = ref.kind === "local" ? refs.filter((r) => r.kind === "remote" && r.name.endsWith(`/${ref.name}`)) : [];
    remotes.forEach((r) => used.add(r));
    const names = remotes.map((r) => r.name.slice(0, -ref.name.length - 1));
    labels.push({ label: names.length ? `${names.join(", ")} & ${ref.name}` : ref.name,
      kinds: [...remotes.map((r) => r.kind), ref.kind], title: [ref, ...remotes].map((r) => r.name).join(", ") });
  }
  return labels;
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
    if (object === sha || peeled === sha) refs.push({ kind, name: m[2] });
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

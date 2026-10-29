// Release…: Compare's ◀ released into ▶ across repositories (the notes, the merge, a tag on ▶, the
// push). git's commands and the tag's message. Pure: no vscode.
import { isValidRef } from "./filterModel";

const checked = (name: string) => {
  if (!isValidRef(name)) throw new Error(`not a valid name: ${name}`);
  return name;
};

/** The release tag, annotated, on ▶'s tip (merged into without a checkout, so not HEAD). */
export function releaseTagArgs(tag: string, message: string, into: string): string[] {
  return ["tag", "-a", "-m", message, "--", checked(tag), `refs/heads/${checked(into)}`];
}

/** ▶'s upstream: its remote and branch on it ("origin", "refs/heads/main"). */
export function upstreamArgs(into: string): string[] {
  return ["for-each-ref", "--format=%(upstream:remotename)%00%(upstream:remoteref)", `refs/heads/${checked(into)}`];
}

export function parseUpstream(out: string): { remote: string; ref: string } | undefined {
  const [remote = "", ref = ""] = out.trim().split("\0");
  return remote && ref.startsWith("refs/heads/") ? { remote, ref } : undefined;
}

/** ▶ to its upstream, and the tag with it, in one push. */
export function releasePushArgs(remote: string, into: string, upstreamRef: string, tag?: string): string[] {
  return ["push", "--quiet", "--", checked(remote), `refs/heads/${checked(into)}:${upstreamRef}`, ...(tag ? [`refs/tags/${checked(tag)}`] : [])];
}

/** The tag's message: "Release v1.4.0", then that repository's commits from the notes. */
export function tagMessage(tag: string, commits: readonly { sha: string; subject: string }[]): string {
  return [`Release ${tag}`, "", ...commits.map((c) => `- ${c.subject} (${c.sha.slice(0, 7)})`)].join("\n").trimEnd();
}

// Release…: Compare's ◀ released into ▶ across repositories (the notes, the merge, a tag on ▶, the
// push). git's commands and the tag's message. Pure: no vscode.
import { isValidRef } from "./filterModel";
import type { FormSpec } from "./formModel";
import { localize } from "./i18n";

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

/** One repository Release… can merge into: what the form shows on its row. */
export interface ReleaseRow {
  id: string;
  name: string;
  from: string;
  into: string;
  /** Commits only on ◀: what the merge brings. */
  commits: number;
  /** "checked out: git merge" / "not checked out: your working tree is not touched". */
  how: string;
  /** ▶ has no upstream there: it is merged (and tagged) but not pushed. */
  noUpstream?: boolean;
}

/**
 * Release…'s one form, before anything runs: the repositories (ticked; the ones it cannot merge
 * into named with why), a tag on ▶ (optional), push or not, and the notes it copies.
 */
export function releaseSpec(o: { from: string; into: string; rows: readonly ReleaseRow[]; left: readonly { name: string; reason: string }[]; notes: string; push: boolean }): FormSpec {
  const plural = (n: number) => localize(n === 1 ? "{0} commit" : "{0} commits", n);
  const noUpstream = o.rows.filter((r) => r.noUpstream).map((r) => r.name);
  return {
    id: "release",
    title: localize("Release {0} into {1}", o.from, o.into),
    intro: localize("Nothing runs until you press Release. Then {0} is merged into {1} in the ticked repositories, tagged and pushed as you choose here.", o.from, o.into),
    fields: [
      { kind: "list", id: "repos", label: localize("Repositories"), required: localize("Tick at least one repository."),
        items: [
          ...o.rows.map((r) => ({ id: r.id, label: r.name, value: true, description: `${r.from} → ${r.into} · ${plural(r.commits)}`, detail: r.how })),
          ...o.left.map((l, i) => ({ id: `left-${i}`, label: l.name, value: false, disabled: l.reason })),
        ] },
      { kind: "text", id: "tag", label: localize("Tag on {0} (optional)", o.into), placeholder: localize("for example v1.4.0"), rule: "optionalRef",
        hint: localize("Each repository's tag gets its own release notes as the message. Empty: no tag.") },
      { kind: "check", id: "push", label: localize("Push {0} and the tag to each repository's upstream", o.into), value: o.push,
        hint: noUpstream.length > 0 ? localize("{0} has no upstream there, so it stays local in: {1}", o.into, noUpstream.join(", ")) : undefined },
      { kind: "preview", id: "notes", label: localize("Release notes (copied when done)"), text: o.notes },
    ],
    submit: localize("Release"),
    cancel: localize("Cancel"),
  };
}

/** Release…'s one report: what was merged, tagged and pushed, and what went wrong where. */
export function releaseReport(o: { title: string; merged: readonly string[]; stopped: readonly string[]; tag: string; tagged: readonly string[]; pushed: readonly string[]; failures: readonly string[] }): { level: "info" | "warning"; text: string } {
  const parts = [localize("Merged: {0}.", o.merged.join(", ") || localize("none"))];
  if (o.tag) parts.push(localize("Tagged {0}: {1}.", o.tag, o.tagged.join(", ") || localize("none")));
  if (o.pushed.length > 0) parts.push(localize("Pushed: {0}.", o.pushed.join(", ")));
  if (o.stopped.length > 0) parts.push(localize("Stopped on conflicts, resolve or abort: {0}.", o.stopped.join(", ")));
  if (o.failures.length > 0) parts.push(localize("Not done: {0}.", o.failures.join("; ")));
  return { level: o.stopped.length > 0 || o.failures.length > 0 ? "warning" : "info", text: `${o.title} — ${parts.join(" ")}` };
}

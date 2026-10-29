import * as path from "path";
import * as vscode from "vscode";
import { parseShow } from "./commitDetail";
import { localize } from "./i18n";
import type { RunGit } from "./logQuery";
import { encodeRevision, SCHEME } from "./revisionUri";
import type { Repo } from "./types";
import type { Ask } from "./uncommittedActions";

/**
 * Compare with Working Tree, for a branch or a commit (the JetBrains Log's Compare with Local):
 * the files that differ between `sha` and the working tree; the one picked opens as a diff.
 * `label` names the revision in the picker and the diff's title.
 */
export async function compareWithWorkingTree(run: RunGit, ask: Pick<Ask, "pick">, repo: Repo, sha: string, label: string, signal: AbortSignal): Promise<void> {
  const files = parseShow(await run(repo.root, ["diff", "--raw", "--numstat", "-z", "-M", sha, "--"], signal)).files;
  if (files.length === 0) { void vscode.window.showInformationMessage(localize("The working tree matches {0}.", label)); return; }
  const index = await ask.pick(files.map((file) => ({ label: file.path, description: file.status })), localize("File to compare with {0}", label));
  if (index === undefined) return;
  const file = files[index];
  const before = vscode.Uri.from({ scheme: SCHEME, ...encodeRevision({ root: repo.root, ref: file.status === "A" ? null : sha, path: file.oldPath ?? file.path }) });
  const after = file.status === "D" ? vscode.Uri.from({ scheme: SCHEME, ...encodeRevision({ root: repo.root, ref: null, path: file.path }) }) : vscode.Uri.file(path.join(repo.root, ...file.path.split("/")));
  await vscode.commands.executeCommand("vscode.diff", before, after, localize("{0} ({1} ↔ Working Tree) — {2}", path.posix.basename(file.path), label, repo.name), { preview: true });
}

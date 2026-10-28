import * as path from "path";
import { promises as fs } from "fs";
import * as vscode from "vscode";
import { commitGraphPathArgs } from "./commitGraphModel";
import { localize } from "./i18n";
import type { RunGit } from "./logQuery";
import { runPool } from "./pool";
import type { Repo } from "./types";

const exists = (p: string) => fs.stat(p).then(() => true, () => false);

/**
 * Topological order was slow and some repositories have no commit-graph: offer to write one,
 * once per repository per session. Nothing is written unless the user presses the button —
 * Linyra changes a repository only when asked.
 */
export class CommitGraphHint {
  private readonly asked = new Set<string>();

  constructor(private readonly run: RunGit) {}

  async check(repos: readonly Repo[]): Promise<void> {
    const signal = new AbortController().signal;
    const fresh = repos.filter((r) => !this.asked.has(r.id));
    const settled = await runPool(fresh, 8, async (r) => {
      const [single, chain] = (await this.run(r.root, commitGraphPathArgs(), signal)).split(/\r?\n/).filter(Boolean).map((p) => path.resolve(r.root, p));
      return !(await exists(single)) && !(chain && (await exists(chain)));
    }, signal);
    const missing = fresh.filter((_, i) => settled[i].status === "fulfilled" && (settled[i] as PromiseFulfilledResult<boolean>).value);
    if (!missing.length) return;
    for (const r of missing) this.asked.add(r.id);
    const names = missing.slice(0, 3).map((r) => r.name).join(", ") + (missing.length > 3 ? localize(" and {0} more", missing.length - 3) : "");
    const write = localize("Write commit-graph");
    const pick = await vscode.window.showInformationMessage(
      localize("Topological order is slow in {0}: without a commit-graph, git walks the whole history for every page. Write one (git commit-graph write --reachable)?", names),
      write, localize("Not now"));
    if (pick !== write) return;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: localize("Writing commit-graph") }, () =>
      runPool(missing, 2, (r) => this.run(r.root, ["commit-graph", "write", "--reachable"], signal, { env: { GIT_OPTIONAL_LOCKS: "1" } }), signal));
  }
}

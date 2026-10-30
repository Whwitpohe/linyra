// The AI features' commands, registered once at activation (extension.ts passes what they use).
import * as vscode from "vscode";
import { AskAi, type AskDeps } from "./askCommand";
import { AiFeatures, type AiFeatureDeps } from "./commands";

export type AiCommandDeps = AiFeatureDeps & Omit<AskDeps, "features">;

export function registerAiFeatures(deps: AiCommandDeps): { features: AiFeatures; askAi: AskAi } {
  const features = new AiFeatures(deps);
  const askAi = new AskAi({ ...deps, features });
  const commands: [string, (arg?: unknown) => unknown][] = [
    ["linyra.ai.translateSearch", (text) => features.translateSearch(text)],
    ["linyra.ai.explainCommit", (arg) => features.explainCommit(arg)],
    ["linyra.ai.explainWip", (arg) => features.explainWip(arg)],
    ["linyra.ai.explainUnpushed", (arg) => features.explainUnpushed(arg)],
    ["linyra.ai.explainBranch", (arg) => features.explainBranch(arg)],
    ["linyra.ai.generateCommitMessage", () => deps.commitPanel.generate()],
    ["linyra.ai.releaseNotes", (arg) => features.releaseNotes(arg)],
    ["linyra.ai.compareReleaseNotes", () => features.compareReleaseNotes()],
    ["linyra.ai.review", (arg) => features.review(arg)],
    ["linyra.ai.resolveConflicts", (arg) => features.resolveConflicts(arg)],
    ["linyra.ai.explainConflicts", (arg) => features.explainConflicts(arg)],
    ["linyra.ai.ask", (text) => askAi.run(text)],
  ];
  // Test seam for the integration suite only: Stash Changes…'s ✨ for a repository, as a box of its own calls it.
  if (process.env.LINYRA_ITEST === "1") {
    commands.push(["linyra._itest.stashWrite", async (arg) => {
      const { repoId, untracked } = arg as { repoId: string; untracked: boolean };
      const repo = deps.log.repoList.find((r) => r.id === repoId);
      const writer = features.stashWriter();
      if (!repo || !writer) return undefined;
      const streamed: string[] = [];
      const text = await writer.write(repo, untracked, new AbortController().signal, (t) => streamed.push(t));
      return { text, streamed };
    }]);
    commands.push(["linyra._itest.conflictReport", () => features.lastConflictReport]);
  }
  // As extension.ts's commands: started in a Linyra webview, their questions are asked there (Ask.from).
  for (const [id, run] of commands) deps.context.subscriptions.push(vscode.commands.registerCommand(id, (...args: unknown[]) => deps.ask.from(args[0], () => run(...args))));
  return { features, askAi };
}

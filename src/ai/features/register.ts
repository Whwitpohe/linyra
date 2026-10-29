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
  for (const [id, run] of commands) deps.context.subscriptions.push(vscode.commands.registerCommand(id, run));
  return { features, askAi };
}

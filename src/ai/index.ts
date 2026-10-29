// The one AI service, registered at activation (extension.ts). Features call aiService(); tests
// register a fake. Pure: no vscode import here.
import { AiError, type AiService } from "./types";

let current: AiService | undefined;

export function registerAi(service: AiService | undefined): void {
  current = service;
}

export function aiService(): AiService {
  if (!current) throw new AiError("Linyra AI is not available.", "notConfigured");
  return current;
}

export * from "./types";

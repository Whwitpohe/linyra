import * as vscode from "vscode";

/**
 * Integration runs keep what Linyra copies here instead of on the system clipboard, which any
 * other process on the machine can hold or clear while the suite runs.
 */
const testing = process.env.LINYRA_ITEST === "1";
let copied = "";

export async function copyText(text: string): Promise<void> {
  if (testing) copied = text;
  else await vscode.env.clipboard.writeText(text);
}

/** Test seam: what the last copy put on the clipboard. */
export function copiedText(): string {
  return copied;
}

/** Test seam: the clipboard's content before an action that must not change it. */
export function setCopiedText(text: string): void {
  copied = text;
}

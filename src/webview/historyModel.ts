// File History in the webview, the parts with no DOM in them: what each row says about its file.
import { decorationFor } from "../changesModel";
import { localize } from "../i18n";
import type { Commit } from "../types";

/** A row's change to the file: its status letter, its lines (null: binary), a rename's old name. */
export interface FileChangeView {
  status: NonNullable<NonNullable<Commit["file"]>["status"]>;
  lines: { added: number; deleted: number } | null | undefined;
  oldPath?: string;
}

/** undefined for a row with no change of its own (a merge: git shows no diff for it). */
export function fileChangeView(file: Commit["file"]): FileChangeView | undefined {
  if (!file?.status) return undefined;
  const lines = file.added === null || file.deleted === null ? null
    : file.added === undefined || file.deleted === undefined ? undefined : { added: file.added, deleted: file.deleted };
  return { status: file.status, lines, ...(file.oldPath ? { oldPath: file.oldPath } : {}) };
}

/** "Modified, 12 lines added, 3 deleted" / "Renamed, was src/old.ts": the change's accessible name and tooltip. */
export function fileChangeLabel(v: FileChangeView): string {
  const parts = [decorationFor(v.status)?.tooltip ?? v.status];
  if (v.lines === null) parts.push(localize("binary"));
  else if (v.lines) parts.push(localize("{0} lines added, {1} deleted", v.lines.added, v.lines.deleted));
  if (v.oldPath) parts.push(localize("was {0}", v.oldPath));
  return parts.join(", ");
}

/**
 * What the subject says about the file's name: " — src/old.ts" on a commit from when it had
 * another name, and "← older/path" on the commit that renamed (or copied) it.
 */
export function nameNotes(file: Commit["file"], currentPath: string): { was?: string; from?: string } {
  if (!file) return {};
  return {
    ...(file.path !== currentPath ? { was: ` — ${file.path}` } : {}),
    ...(file.oldPath && (file.status === "R" || file.status === "C") ? { from: `← ${file.oldPath}` } : {}),
  };
}

/** The chip's path, split so the file name stays when the folder is cut: "src/webview/" + "client.ts". */
export function chipPath(path: string): { dir: string; base: string } {
  const i = path.lastIndexOf("/");
  return i < 0 ? { dir: "", base: path } : { dir: path.slice(0, i + 1), base: path.slice(i + 1) };
}

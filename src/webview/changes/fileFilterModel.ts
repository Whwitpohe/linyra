import type { ChangeRow } from "../../changesProtocol";
import { localize } from "../../i18n";
import { filterTree, type Filtered, type FilterOptions } from "../ui/fileTreeModel";

/** A file's + − counts, when it has them (not binary, new, unchanged or a combined diff). */
export const changeLines = (node: ChangeRow): { added: number; deleted: number } | undefined =>
  node.kind === "file" && !node.combined && !node.unchanged && !node.untracked && node.added !== null && node.added !== undefined
    ? { added: node.added, deleted: node.deleted ?? 0 } : undefined;

/** The muted words before a file's counts: "staged", or what it is instead of counts (new, binary, a combined diff's note). */
export const changeNote = (node: ChangeRow): string | undefined =>
  changeLines(node) ? (node.staged ? localize("staged") : undefined) : node.description || undefined;

/**
 * How the Changes view's filter reads its rows: a file by its name, path, old path and note; a folder or
 * repository by its name (every file under it then shows). A folder shown with only some of its
 * files counts those, and keeps only its base menu: its bulk actions would reach the hidden ones.
 */
export const changesFilter: FilterOptions<ChangeRow> = {
  isBranch: (node) => node.kind !== "file",
  isFile: (node) => node.kind === "file",
  text: (node) => (node.kind === "file" ? [node.label, node.path, node.oldPath, changeNote(node)] : [node.label]),
  remake: (node, children, files) => ({ ...node, children, contextValue: node.contextValue.split(".")[0], description: node.kind === "folder" ? String(files) : node.description }),
};

/** A view-only projection: rows keep their host ids, diff ownership and original paths. */
export function filterFiles(roots: ChangeRow[], query: string): Filtered<ChangeRow> {
  return filterTree(roots, query, changesFilter);
}

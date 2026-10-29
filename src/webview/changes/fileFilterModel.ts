import type { ChangeRow } from "../../changesProtocol";
import { filterTree, type Filtered, type FilterOptions } from "../ui/fileTreeModel";

/**
 * How the Changes view's filter reads its rows: a file by its name, path and old path; a folder or
 * repository by its name (every file under it then shows). A folder shown with only some of its
 * files counts those, and keeps only its base menu: its bulk actions would reach the hidden ones.
 */
export const changesFilter: FilterOptions<ChangeRow> = {
  isBranch: (node) => node.kind !== "file",
  isFile: (node) => node.kind === "file",
  text: (node) => (node.kind === "file" ? [node.label, node.path, node.oldPath] : [node.label]),
  remake: (node, children, files) => ({ ...node, children, contextValue: node.contextValue.split(".")[0], description: node.kind === "folder" ? String(files) : node.description }),
};

/** A view-only projection: rows keep their host ids, diff ownership and original paths. */
export function filterFiles(roots: ChangeRow[], query: string): Filtered<ChangeRow> {
  return filterTree(roots, query, changesFilter);
}

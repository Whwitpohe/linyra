import type { ChangeRow } from "../../changesProtocol";

export interface FilteredFiles { roots: ChangeRow[]; matched: number; total: number }

/** A view-only projection: rows keep their host ids, diff ownership and original paths. */
export function filterFiles(roots: ChangeRow[], query: string): FilteredFiles {
  const term = query.trim().replace(/\\/g, "/").toLowerCase();
  let total = 0;
  let matched = 0;
  const walk = (nodes: ChangeRow[], parent: string): { nodes: ChangeRow[]; count: number } => {
    let count = 0;
    const visible: ChangeRow[] = [];
    for (const node of nodes) {
      const path = node.path ?? (parent ? `${parent}/${node.label}` : node.label);
      if (node.kind !== "file") {
        const children = walk(node.children ?? [], path);
        count += children.count;
        if (!term || children.count) visible.push(term ? { ...node, children: children.nodes, contextValue: node.contextValue.split(".")[0],
          description: node.kind === "folder" ? String(children.count) : node.description } : node);
        continue;
      }
      total++;
      if (term && ![node.label, path, node.oldPath ?? ""].some((text) => text.replace(/\\/g, "/").toLowerCase().includes(term))) continue;
      count++;
      matched++;
      visible.push(node);
    }
    return { nodes: visible, count };
  };
  const result = walk(roots, "");
  return { roots: term ? result.nodes : roots, matched, total };
}

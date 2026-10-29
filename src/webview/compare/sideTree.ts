import type { CompareSidePage, CompareTreeRow, ReposWebview } from "../../compareProtocol";
import { localize } from "../../i18n";
import { byId } from "../dom";
import { FileTree, type RowParts } from "../ui/fileTree";

/** Rows that open onto others: a folder, a commit (its files), a repository (All repositories). */
const isBranch = (node: CompareTreeRow) => node.kind === "folder" || node.kind === "commit" || node.kind === "repo";

function context(side: "left" | "right", node: CompareTreeRow): string {
  return JSON.stringify({ webviewSection: "compareSideRow", compareSide: side, compareNodeId: node.id, viewItem: node.contextValue, preventDefaultContextMenuItems: true });
}

/** A row's parts, as the Changes view draws them: a file's old name and note muted, + and − in their colors, the letter last. */
function parts(side: "left" | "right", node: CompareTreeRow): RowParts {
  const common = { label: node.label, title: node.tooltip, context: context(side, node) };
  if (node.kind === "file") {
    return { ...common, icon: "file", status: node.status, untracked: node.untracked === true, letter: true, oldPath: node.oldPath, note: node.note,
      lines: node.lines, same: node.same, conflict: node.conflict };
  }
  if (node.kind === "more") return { ...common, icon: "none", link: true, description: node.description };
  return { ...common, icon: node.kind, description: node.description };
}

/**
 * One side of Compare, drawn in the page: a tree of folders and files, or of commits, under each
 * repository in All repositories (the shared tree, ui/fileTree.ts). Ctrl/Shift-click selects several
 * (Cherry-Pick takes them all); the filter box keeps the rows whose own text has it, every row
 * under those, and their parents.
 */
export class CompareTree {
  private readonly tree: FileTree<CompareTreeRow>;
  private page: CompareSidePage | undefined;
  private key = "";
  /** Commits whose files were asked for: each read is a git process, asked once. */
  private readonly requested = new Set<string>();

  constructor(private readonly side: "left" | "right", private readonly post: (message: ReposWebview) => void) {
    const filter = byId<HTMLInputElement>(`compare-${side}-filter`);
    this.tree = new FileTree<CompareTreeRow>({
      root: byId(`compare-${side}-tree`), idPrefix: `compare-${side}-row`,
      isBranch, isFile: (node) => node.kind === "file",
      parts: (node) => parts(side, node),
      // A file by its name, path, old path and note (conflict, binary…); a commit by its subject, author and hash.
      filterText: (node) => (node.kind === "file" ? [node.label, node.path ?? node.tooltip, node.oldPath, node.note] : node.kind === "commit" ? [node.label, node.description] : [node.label]),
      remake: (node, children, files) => ({ ...node, children, description: node.kind === "folder" || node.kind === "repo" ? String(files) : node.description }),
      isUnread: (node) => node.kind === "commit" && !node.loaded,
      // A commit opens onto its files only when asked: each is read on its own.
      startsClosed: (node) => node.kind === "commit",
      open: (node) => this.post({ type: "sideOpen", side, id: node.id }),
      opened: (node) => this.requested.delete(node.id),
      wantChildren: (node) => {
        if (this.requested.has(node.id)) return;
        this.requested.add(node.id);
        this.post({ type: "sideExpand", side, id: node.id });
      },
      selectionChanged: (ids) => this.post({ type: "sideSelect", side, ids }),
      toggleButton: byId<HTMLButtonElement>(`compare-${side}-tree-toggle`),
      // Expand All: the host reads every commit's files at once.
      expandedAll: () => {
        const walk = (nodes: readonly CompareTreeRow[]) => nodes.forEach((node) => { if (node.kind === "commit" && !node.loaded) this.requested.add(node.id); walk(node.children ?? []); });
        walk(this.page?.rows ?? []);
        this.post({ type: "sideExpandAll", side });
      },
      refreshed: ({ searching, rows }) => {
        const empty = byId(`compare-${side}-empty`);
        empty.hidden = !searching || rows > 0 || !!this.page?.message;
        const commits = (this.page?.rows ?? []).some((node) => node.kind === "commit");
        empty.textContent = localize(commits ? "No commits match “{0}”." : "No files match “{0}”.", filter.value.trim());
      },
    });
    this.tree.bindFilter(filter);
  }

  receive(page: CompareSidePage): void {
    if (page.key !== this.key) {
      this.key = page.key;
      this.requested.clear();
      this.tree.reset();
    }
    this.page = page;
    byId(`compare-${this.side}-description`).textContent = page.description;
    const notice = byId(`compare-${this.side}-message`);
    notice.hidden = !page.message;
    notice.textContent = page.message ?? "";
    const loaded = (nodes: readonly CompareTreeRow[]) => nodes.forEach((node) => { if (node.loaded) this.requested.delete(node.id); loaded(node.children ?? []); });
    loaded(page.rows);
    this.tree.setRoots(page.rows);
  }

  focus(): void { this.tree.focus(); }
}

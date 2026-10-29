// File History in the Log (plan 3.D): the header chip, the Repo List's mark on the file's
// repository, each row's change to the file, and the uncommitted row above the commits.
import "./history.css";
import { localize } from "../i18n";
import type { HistoryWork } from "../protocol";
import type { Commit } from "../types";
import { byId, clear, h } from "./dom";
import { chipPath, fileChangeLabel, fileChangeView, nameNotes } from "./historyModel";
import { renderLines } from "./ui/counts";

/** The file File History shows, as the host's init names it. */
export interface HistoryTarget {
  repoId: string;
  repoName: string;
  path: string;
}

/** A row's change to its file: "M +12 −3" (the letter in its Source Control color). Empty on a merge. */
export function historyChangeCell(file: Commit["file"], role = "gridcell"): HTMLElement {
  const cell = h("span", { class: "history-change", role });
  const v = fileChangeView(file);
  if (!v) return cell;
  const label = fileChangeLabel(v);
  cell.setAttribute("aria-label", label);
  cell.title = label;
  cell.append(h("span", { class: `history-status status-${v.status}`, "aria-hidden": "true" }, [v.status]));
  if (v.lines === null) cell.append(h("span", { class: "history-binary", "aria-hidden": "true" }, [localize("binary")]));
  else if (v.lines) {
    const lines = renderLines(v.lines.added, v.lines.deleted);
    lines.setAttribute("aria-hidden", "true");
    cell.append(lines);
  }
  return cell;
}

/** What follows a row's subject: the file's name then (" — src/old.ts") and a rename's old name ("← src/old.ts"). */
export function historySubjectNotes(file: Commit["file"], currentPath: string): HTMLElement[] {
  const notes = nameNotes(file, currentPath);
  return [
    notes.was ? h("span", { class: "was-path" }, [notes.was]) : null,
    notes.from ? h("span", { class: "history-from" }, [" ", notes.from]) : null,
  ].filter((x): x is HTMLElement => x !== null);
}

/**
 * The chip in place of the Commits | Uncommitted switch, [⟲ src/client.ts · acme-web ×], and the
 * file's repository marked in the Repo List (the pane stays inert: the history is of one file).
 */
export class HistoryChip {
  private readonly chip = byId("history-chip");
  private readonly path = byId("history-path");
  private readonly repo = byId("history-repo");
  private readonly rows = byId("repo-rows");
  private key = "";
  private repoId: string | undefined;

  constructor(onClose: () => void) {
    byId("history-close").addEventListener("click", onClose);
    // The Repo List redraws its rows on its own (sync counts, branches): mark the repository again.
    new MutationObserver(() => this.markRepo()).observe(this.rows, { childList: true });
  }

  update(target: HistoryTarget | null, accent: number): void {
    const key = JSON.stringify([target, accent]);
    if (key === this.key) return;
    this.key = key;
    this.chip.hidden = !target;
    this.repoId = target?.repoId;
    clear(this.path);
    if (target) {
      const { dir, base } = chipPath(target.path);
      this.path.append(h("span", { class: "history-dir" }, [dir]), h("span", { class: "history-base" }, [base]));
      this.path.title = target.path;
      this.chip.setAttribute("aria-label", localize("File history: {0} in {1}", target.path, target.repoName));
    }
    this.repo.textContent = target?.repoName ?? "";
    this.repo.className = `history-repo accent-${accent}`;
    this.markRepo();
  }

  private markRepo(): void {
    for (const row of this.rows.querySelectorAll<HTMLElement>(".repo-row[data-vscode-context]")) {
      let id: unknown;
      try {
        id = (JSON.parse(row.dataset.vscodeContext ?? "{}") as { repoId?: unknown }).repoId;
      } catch {
        id = undefined;
      }
      const on = this.repoId !== undefined && id === this.repoId;
      if (row.classList.contains("history-repo-row") !== on) row.classList.toggle("history-repo-row", on);
    }
  }
}

const SVG = "http://www.w3.org/2000/svg";
/** The first lane's centre in the commit graph (graph.ts): the dashed node sits on it. */
const LANE0 = 6;

function svg(tag: string, attrs: Record<string, string | number>): SVGElement {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/**
 * The row above the commits when the file has uncommitted changes (from the uncommitted store:
 * no git process): a dashed node, "Uncommitted changes", the change. Enter or a click opens the
 * file from the last commit to the working tree.
 */
export class HistoryWorkRow {
  private key = "";

  constructor(private readonly root: HTMLElement, onOpen: () => void) {
    root.addEventListener("click", onOpen);
    root.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      onOpen();
    });
  }

  /** The row's height, read once it is first shown (it follows the font, not the data). */
  private height = 0;

  /** graphWidth: the commit list's graph column (its --graph-width), so the columns line up. */
  update(work: HistoryWork | null, accent: number, graphWidth: string): void {
    const key = JSON.stringify([work, accent, graphWidth]);
    if (key === this.key) return;
    this.key = key;
    this.root.hidden = !work;
    clear(this.root);
    if (!work) return;
    if (graphWidth) this.root.style.setProperty("--graph-width", graphWidth);
    this.height ||= this.root.clientHeight;
    const height = this.height;
    const v = fileChangeView(work);
    const stage = work.partlyStaged ? localize("partly staged") : work.staged ? localize("staged") : "";
    this.root.setAttribute("aria-label", [localize("Uncommitted changes"), stage, v ? fileChangeLabel(v) : ""].filter(Boolean).join(", "));
    this.root.title = localize("Open the changes since the last commit");
    const width = parseFloat(graphWidth) || 28;
    const rowHeight = height || 24;
    const graph = svg("svg", { class: "history-work-graph", width, height: rowHeight, viewBox: `0 0 ${width} ${rowHeight}`, "aria-hidden": "true" });
    graph.append(
      svg("path", { class: `history-work-edge accent-${accent}`, d: `M ${LANE0} ${rowHeight / 2 + 4} V ${rowHeight}` }),
      svg("circle", { class: `history-work-node accent-${accent}`, cx: LANE0, cy: rowHeight / 2, r: 4 }),
    );
    this.root.append(
      h("span", { class: `repo-band band-start band-end history-work-band accent-${accent}`, "aria-hidden": "true" }),
      graph,
      h("span", { class: "history-work-subject" }, [
        h("span", { class: "subject" }, [localize("Uncommitted changes")]),
        stage ? h("span", { class: "history-work-tag" }, [stage]) : null,
        ...historySubjectNotes({ path: work.path, oldPath: work.oldPath, status: work.status }, work.path),
      ]),
      historyChangeCell(work, "presentation"),
      h("span", { class: "hash" }),
      h("span", { class: "author" }),
      h("span", { class: "date" }),
    );
  }
}

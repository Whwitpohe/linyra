import type { FilterState } from "../filterModel";
import { localize } from "../i18n";
import { byId } from "./dom";

/**
 * The footer's note on the Log's order. The order itself is chosen in the Graph column's menu
 * (columnHeader.ts): by commit date, or by branch structure (git's topological order).
 */
export function showOrder(sort: FilterState["sort"]): void {
  const note = byId("order-note");
  note.textContent = localize(sort === "topo" ? "Incoming commits below their merge" : "Newest first by commit date");
  note.title = localize(sort === "topo" ? "Connected branch history stays together; incoming commits follow their merge, with children before parents. Separate parts are ordered by their newest commit." : "Commits in different repositories share no history, so they are merged by committer date. A rebase or a skewed clock can place a commit out of order.");
}

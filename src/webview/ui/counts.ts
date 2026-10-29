import "./counts.css";
import type { KindCounts } from "../../changeKinds";
import { localize } from "../../i18n";
import { codiconElement } from "../codicons";
import { h } from "../dom";

/** "3 new, 2 modified, 1 deleted": the counts' accessible name (and tooltip). */
export function countsLabel(c: KindCounts): string {
  const parts: string[] = [];
  if (c.added) parts.push(localize("{0} new", c.added));
  if (c.modified) parts.push(localize("{0} modified", c.modified));
  if (c.deleted) parts.push(localize("{0} deleted", c.deleted));
  if (c.renamed) parts.push(localize("{0} renamed", c.renamed));
  return parts.join(", ");
}

/**
 * Files by kind, as GitLens draws working changes: "+3 ✎2 −1 →1", each in its Source Control
 * color. Kinds with no file are left out; no file at all gives an empty element.
 */
export function renderCounts(c: KindCounts, className = ""): HTMLElement {
  const label = countsLabel(c);
  const el = h("span", { class: `counts${className ? ` ${className}` : ""}`, role: "img", "aria-label": label || undefined, title: label || undefined });
  if (c.added) el.append(h("span", { class: "count count-added" }, ["+", String(c.added)]));
  if (c.modified) el.append(h("span", { class: "count count-modified" }, [codiconElement("edit", "count-icon"), String(c.modified)]));
  if (c.deleted) el.append(h("span", { class: "count count-deleted" }, ["−", String(c.deleted)]));
  if (c.renamed) el.append(h("span", { class: "count count-renamed" }, [codiconElement("arrow-right", "count-icon"), String(c.renamed)]));
  return el;
}

/** "+12 −3": lines added and deleted, in the add and delete colors. */
export function renderLines(added: number, deleted: number, className = ""): HTMLElement {
  return h("span", { class: `line-counts${className ? ` ${className}` : ""}`, "aria-label": localize("{0} lines added, {1} deleted", added, deleted) }, [
    h("span", { class: `count-added${added === 0 ? " zero" : ""}` }, [`+${added}`]),
    h("span", { class: `count-deleted${deleted === 0 ? " zero" : ""}` }, [`−${deleted}`]),
  ]);
}

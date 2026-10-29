import "./fileStatus.css";
import { localize } from "../../i18n";
import { h } from "../dom";

/** What a status letter means, for its tooltip. */
const NAMES: Record<string, string> = { A: "Added", M: "Modified", D: "Deleted", R: "Renamed", C: "Copied", T: "Type changed", U: "Untracked" };

/**
 * A changed file's status letter at its row's end, as Source Control's badge: M, A, D, R, C, T, or
 * U for a file git does not track yet. One renderer for every list of changed files.
 */
export function renderStatus(status: string | undefined, untracked = false, className = ""): HTMLElement {
  const letter = untracked ? "U" : status ?? "";
  const name = NAMES[letter] ? localize(NAMES[letter]) : "";
  // The letter is seen; its meaning ("Deleted") is what a screen reader says.
  return h("span", { class: `file-status${letter ? ` file-status-${letter}` : ""}${className ? ` ${className}` : ""}`, title: name || undefined }, [
    h("span", { "aria-hidden": "true" }, [letter]),
    name ? h("span", { class: "file-status-name" }, [`, ${name}`]) : null,
  ]);
}

/** The file name's class: struck through when the file is deleted. */
export function nameClass(base: string, status: string | undefined): string {
  return status === "D" ? `${base} deleted-name` : base;
}

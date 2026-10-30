import "./rowActions.css";
import { localize } from "../i18n";
import type { WebviewMessage } from "../protocol";
import { codiconElement, type Codicon } from "./codicons";
import { h } from "./dom";

type RowAction = Extract<WebviewMessage, { type: "rowAction" }>["action"];

/** The row's own menu context (list.ts renderRow): which commit, and whether it is the checked-out one. */
interface RowContext { webviewSection?: string; repoId?: string; sha?: string; head?: boolean }

const ICONS: Record<RowAction | "more", Codicon> = { undo: "discard", reword: "edit", more: "ellipsis" };
/** The menu's own names for the same commands (package.nls.json). */
const label = (a: RowAction | "more"): string =>
  a === "undo" ? localize("Undo Commit…") : a === "reword" ? localize("Edit Commit Message…") : localize("More Actions…");

/**
 * The buttons a Log row shows at its end while the pointer is on it, as VS Code's lists show their
 * inline actions: Undo Commit and Edit Commit Message on the checked-out commit (its menu offers
 * them there alone), and ⋯ for the row's whole menu. One toolbar, moved into the row under the
 * pointer: no row carries buttons of its own, so scrolling builds nothing more. The keyboard has
 * the same commands on the row's menu (the menu key, Shift+F10).
 */
export class RowActions {
  readonly el = h("span", { class: "row-actions", role: "toolbar", "aria-label": localize("Commit actions") });
  private row: HTMLElement | undefined;
  private kind = "";

  constructor(body: HTMLElement, private readonly post: (m: WebviewMessage) => void) {
    // pointerover: also when the rows move under a still pointer (a scroll); pointermove: a row rebuilt under it.
    const follow = (e: PointerEvent) => this.at((e.target as Element).closest<HTMLElement>(".row[data-index]") ?? undefined);
    body.addEventListener("pointerover", follow);
    body.addEventListener("pointermove", follow);
    body.addEventListener("pointerleave", () => this.at(undefined));
    this.el.addEventListener("click", (e) => this.click(e));
  }

  /** The row under the pointer (undefined: none): the toolbar moves into it, rebuilt only when the buttons differ. */
  private at(row: HTMLElement | undefined): void {
    if (row === this.row && this.el.parentElement === row) return;
    this.row = row;
    if (!row) { this.el.remove(); return; }
    const c = this.context();
    const actions: (RowAction | "more")[] = c?.webviewSection === "commit" && c.head ? ["undo", "reword", "more"] : ["more"];
    const kind = actions.join();
    if (kind !== this.kind) {
      this.kind = kind;
      this.el.replaceChildren(...actions.map((a) => h("button", { class: "row-action", type: "button", "data-row-action": a,
        title: label(a), "aria-label": label(a) }, [codiconElement(ICONS[a])])));
    }
    row.append(this.el);
  }

  private context(): RowContext | undefined {
    try { return JSON.parse(this.row?.dataset.vscodeContext ?? "null") as RowContext; } catch { return undefined; }
  }

  private click(e: MouseEvent): void {
    const button = (e.target as Element).closest<HTMLElement>("[data-row-action]");
    const action = button?.dataset.rowAction as RowAction | "more" | undefined;
    const c = this.context();
    if (!button || !action || !c?.repoId || !c.sha) return;
    // The click goes on to the list, which selects the row: the action is about that commit.
    if (action !== "more") { this.post({ type: "rowAction", action, repoId: c.repoId, sha: c.sha }); return; }
    // ⋯: the row's own menu, under the button. VS Code opens a webview's menu on a contextmenu
    // event, with the data-vscode-context of the element and its ancestors: the row's.
    const box = button.getBoundingClientRect();
    button.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: box.left, clientY: box.bottom }));
  }
}

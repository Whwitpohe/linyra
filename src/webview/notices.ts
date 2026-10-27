import { localize } from "../i18n";
import type { RepoFailure } from "../types";
import { clear, h } from "./dom";

/** Partial failure: results still show; the failed repos are named with their reason. */
export class NoticeBar {
  private last: readonly RepoFailure[] | undefined;

  constructor(private readonly root: HTMLElement, private readonly onDismiss: () => void) {}

  render(failures: readonly RepoFailure[]): void {
    if (failures === this.last || (failures.length === 0 && this.last?.length === 0)) return;
    this.last = failures;
    clear(this.root);
    if (failures.length === 0) return;
    const n = failures.length;
    const dismiss = h("button", { class: "link", type: "button" }, [localize("Dismiss")]);
    dismiss.addEventListener("click", this.onDismiss);
    this.root.append(h("div", { class: "notice", role: "status" }, [
      h("span", { class: "notice-text" }, [
        n === 1 ? localize("1 repository could not be read and is left out: ") : localize("{0} repositories could not be read and are left out: ", n),
        failures.map((f) => `${f.name} (${f.reason})`).join("; "),
      ]),
      dismiss,
    ]));
  }
}

import { localize } from "../i18n";
import { DEFAULT_FILTER, hashQuery, normalizePath, selectedBranches, type DatePreset, type FilterState } from "../filterModel";
import type { AuthorName, BranchName } from "../protocol";
import { byId } from "./dom";
import { AuthorFilter } from "./authorFilter";
import { BranchFilter } from "./branchFilter";
import { SortFilter } from "./sortFilter";

/**
 * The filter bar. It only reports intent: every change goes to the host, which
 * turns it into git flags. (Repositories are picked in the RepoPane.)
 */
export class FilterBar {
  private filter: FilterState | undefined;
  private readonly search = byId<HTMLInputElement>("search");
  private readonly meButton = byId<HTMLButtonElement>("me");
  private readonly path = byId<HTMLInputElement>("path");
  private readonly date = byId<HTMLSelectElement>("date");
  private readonly customRange = byId("custom-range");
  private readonly from = byId<HTMLInputElement>("from");
  private readonly to = byId<HTMLInputElement>("to");

  private readonly authorFilter: AuthorFilter;
  private readonly branchFilter: BranchFilter;
  private readonly sortFilter: SortFilter;

  constructor(private readonly onChange: (f: FilterState) => void, onRefresh: () => void, onWantSuggestions: (kind: "authors" | "branches") => void) {
    byId("filters").addEventListener("submit", (e) => e.preventDefault());
    this.search.addEventListener("input", () => this.emit({ text: this.search.value }));
    this.authorFilter = new AuthorFilter((authors, mine) => this.emit({ author: "", authors: authors.length ? authors : undefined, mine }), () => onWantSuggestions("authors"));
    this.branchFilter = new BranchFilter((branches) => this.emit({ branch: "", branches: branches.length ? branches : undefined }), () => onWantSuggestions("branches"));
    this.sortFilter = new SortFilter((sort) => this.emit({ sort }));
    this.meButton.addEventListener("click", () => this.emit({ mine: !this.current().mine }));
    // A path filters as you type (debounced by the host); an unsafe one is marked, not sent.
    this.path.addEventListener("input", () => {
      const raw = this.path.value;
      const p = normalizePath(raw);
      if (raw.trim() !== "" && p === undefined) {
        this.path.setAttribute("aria-invalid", "true");
        this.path.title = localize("Relative to each repository: no leading / or :, and no ..");
        return;
      }
      this.path.removeAttribute("aria-invalid");
      this.path.title = "";
      if (p !== this.current().path) this.emit({ path: p });
    });
    this.date.addEventListener("change", () => {
      const date = this.date.value as DatePreset;
      this.onChange({ ...this.current(), date,
        from: date === "custom" ? this.from.value || undefined : undefined,
        to: date === "custom" ? this.to.value || undefined : undefined });
    });
    for (const input of [this.from, this.to]) {
      input.addEventListener("change", () => this.emit({ from: this.from.value || undefined, to: this.to.value || undefined }));
    }
    byId("refresh").addEventListener("click", onRefresh);
  }

  update(filter: FilterState): void {
    this.filter = filter;
    if (this.search.value !== filter.text) this.search.value = filter.text;
    this.authorFilter.update(filter);
    // Keep what is being typed (it may still be invalid); follow the filter otherwise.
    if (document.activeElement !== this.path && normalizePath(this.path.value) !== filter.path) {
      this.path.value = filter.path ?? "";
      this.path.removeAttribute("aria-invalid");
    }
    this.meButton.setAttribute("aria-pressed", String(filter.mine));
    this.branchFilter.update(selectedBranches(filter));
    this.sortFilter.update(filter.sort);
    this.date.value = filter.date;
    this.customRange.hidden = filter.date !== "custom";
    this.from.value = filter.from ?? "";
    this.to.value = filter.to ?? "";
    const hash = hashQuery(filter.text);
    byId("hash-search-note").hidden = !hash;
    byId("order-note").hidden = !!hash;
    for (const id of ["author", "me", "path", "branch", "date", "from", "to", "sort"]) {
      (byId(id) as HTMLInputElement | HTMLButtonElement | HTMLSelectElement).disabled = !!hash;
    }
    document.querySelectorAll<HTMLButtonElement>(".picker-chip-remove").forEach((button) => { button.disabled = !!hash; });
    this.search.title = localize("Paste a commit hash (7 or more characters), or use sha: with at least 4 characters.");
  }

  /** Suggestions for the Branch box: names shared by the most repositories first. */
  setBranches(items: readonly BranchName[]): void {
    this.branchFilter.setItems(items);
  }

  /** Suggestions for the Author box: people who committed recently, most commits first. */
  setAuthors(items: readonly AuthorName[]): void {
    this.authorFilter.setItems(items);
  }

  /** Shown once the host knows at least one repository's user.email. */
  setMe(hasMe: boolean): void {
    this.meButton.hidden = !hasMe;
    this.meButton.title = localize("Only my commits (each repository's user.email)");
  }

  private current(): FilterState {
    return this.filter ?? DEFAULT_FILTER;
  }

  private emit(patch: Partial<FilterState>): void {
    this.onChange({ ...this.current(), ...patch });
  }
}

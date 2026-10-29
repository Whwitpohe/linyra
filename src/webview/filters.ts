import { localize } from "../i18n";
import { DEFAULT_FILTER, hashQuery, normalizePath, selectedBranches, type DatePreset, type FilterState } from "../filterModel";
import type { AuthorName, BranchName } from "../protocol";
import { byId } from "./dom";
import { AuthorFilter } from "./authorFilter";
import { BranchFilter } from "./branchFilter";
import { SearchBox, type SearchBoxHost, type ValueKind } from "./searchBox";
import { SortFilter } from "./sortFilter";

/**
 * The filter bar. It only reports intent: every change goes to the host, which
 * turns it into git flags. (Repositories are picked in the RepoPane.)
 */
export class FilterBar {
  private filter: FilterState | undefined;
  private readonly meButton = byId<HTMLButtonElement>("me");
  private readonly path = byId<HTMLInputElement>("path");
  private readonly date = byId<HTMLSelectElement>("date");
  private readonly customRange = byId("custom-range");
  private readonly from = byId<HTMLInputElement>("from");
  private readonly to = byId<HTMLInputElement>("to");

  private readonly searchBox: SearchBox;
  private readonly authorFilter: AuthorFilter;
  private readonly branchFilter: BranchFilter;
  private readonly sortFilter: SortFilter;

  constructor(
    private readonly onChange: (f: FilterState, now?: boolean) => void,
    onRefresh: () => void,
    onWantSuggestions: (kind: ValueKind) => void,
    search: Omit<SearchBoxHost, "change" | "want">,
  ) {
    byId("filters").addEventListener("submit", (e) => e.preventDefault());
    this.searchBox = new SearchBox({ ...search, change: (patch, now) => this.onChange({ ...this.current(), ...patch }, now), want: onWantSuggestions });
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
    this.searchBox.update(filter);
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
    for (const id of ["match-case", "whole-word", "use-regex", "match-all", "author", "me", "path", "branch", "date", "from", "to", "sort"]) {
      (byId(id) as HTMLInputElement | HTMLButtonElement | HTMLSelectElement).disabled = !!hash;
    }
    document.querySelectorAll<HTMLButtonElement>(".picker-chip-remove").forEach((button) => { button.disabled = !!hash; });
  }

  /** Suggestions for the Branch box and ref:: names shared by the most repositories first. */
  setBranches(items: readonly BranchName[]): void {
    this.branchFilter.setItems(items);
    this.searchBox.setBranches(items);
  }

  /** Suggestions for the Author box, author: and committer:: people who committed recently, most commits first. */
  setAuthors(items: readonly AuthorName[]): void {
    this.authorFilter.setItems(items);
    this.searchBox.setAuthors(items);
  }

  /** Tags for ref:. */
  setTags(items: readonly BranchName[]): void {
    this.searchBox.setTags(items);
  }

  /** The repositories' names, for repo:. */
  setRepos(names: readonly string[]): void {
    this.searchBox.setRepos(names);
  }

  setAiAvailable(available: boolean): void {
    this.searchBox.setAiAvailable(available);
  }

  aiResult(m: { text: string; query?: string; error?: string }): void {
    this.searchBox.aiResult(m);
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

import type { RunGit } from "./logQuery";
import { runPool } from "./pool";
import type { AuthorName, BranchName, HostMessage } from "./protocol";
import { authorSuggestions, branchSuggestions } from "./repos";
import type { Repo } from "./types";

export type SuggestionKind = "authors" | "branches" | "tags";

/** What the Author and Branch boxes' suggestions need from the Log. */
export interface SuggestionHost {
  repos(): readonly Repo[];
  maxConcurrency(): number;
  run: RunGit;
  post(message: Extract<HostMessage, { type: "suggestions" }>): void;
  /** Stops background reads when Linyra stops. */
  signal(): AbortSignal;
}

/**
 * The Author and Branch boxes' suggestions: read when a box is first focused (at startup they
 * would cost two git processes per repository for boxes rarely opened), once per set of
 * repositories, and again when branches move.
 */
export class Suggestions {
  /** Recent authors across the workspace. */
  authors: AuthorName[] = [];
  /** Branch names across the workspace, most shared first. */
  branches: BranchName[] = [];
  /** Tag names across the workspace (the search box's ref:), most shared first. */
  tags: BranchName[] = [];
  /** Kinds a box has asked for this session. */
  private readonly wanted = new Set<SuggestionKind>();
  /** The repo set each kind was last read for. */
  private readonly readFor = new Map<SuggestionKind, string>();

  constructor(private readonly host: SuggestionHost) {}

  async load(kind: SuggestionKind): Promise<void> {
    this.wanted.add(kind);
    const repos = this.host.repos();
    if (repos.length === 0) return; // nothing to read yet; asked again once repos arrive
    const key = repos.map((r) => r.id).join("\0");
    if (this.readFor.get(kind) === key) return;
    this.readFor.set(kind, key);
    await (kind === "authors" ? this.loadAuthors() : kind === "branches" ? this.loadBranches() : this.loadTags());
  }

  /** The repositories changed: a box focused before they were known asked for nothing useful. */
  reposChanged(): void {
    this.readFor.clear();
    for (const kind of this.wanted) void this.load(kind);
  }

  /** Branches moved (a fetch, a checkout, a new branch): read the Branch box's names again if it was used. */
  branchesChanged(): void {
    for (const kind of ["branches", "tags"] as const) {
      this.readFor.delete(kind);
      if (this.wanted.has(kind)) void this.load(kind);
    }
  }

  /** A re-created webview lost what it had: send it again (only then). */
  replay(): void {
    if (this.branches.length > 0 || this.authors.length > 0 || this.tags.length > 0) this.host.post({ type: "suggestions", branches: this.branches, authors: this.authors, tags: this.tags });
  }

  /** People who committed recently, for the Author box: 300 commits per repo. */
  private async loadAuthors(): Promise<void> {
    const repos = [...this.host.repos()];
    const settled = await runPool(repos, this.host.maxConcurrency(),
      (r, signal) => this.host.run(r.root, ["log", "--no-merges", "--max-count=300", "--format=%aN%x1f%aE"], signal), this.host.signal());
    this.authors = authorSuggestions(settled.map((s) => (s.status === "fulfilled" ? s.value : "")));
    this.host.post({ type: "suggestions", authors: this.authors });
  }

  /** Branch names across repositories (local and remote-tracking), most shared first. */
  private async loadBranches(): Promise<void> {
    const repos = [...this.host.repos()];
    const settled = await runPool(repos, this.host.maxConcurrency(),
      (r, signal) => this.host.run(r.root, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"], signal), this.host.signal());
    const lists = settled.map((s) => s.status === "fulfilled"
      ? s.value.split("\n").map((l) => l.trim().replace(/^refs\/(heads|remotes)\//, "")).filter(Boolean)
      : []);
    this.branches = branchSuggestions(lists);
    this.host.post({ type: "suggestions", branches: this.branches });
  }

  /** Tag names across repositories, for the search box's ref: (read only once it is typed). */
  private async loadTags(): Promise<void> {
    const repos = [...this.host.repos()];
    const settled = await runPool(repos, this.host.maxConcurrency(),
      (r, signal) => this.host.run(r.root, ["for-each-ref", "--format=%(refname:lstrip=2)", "refs/tags"], signal), this.host.signal());
    this.tags = branchSuggestions(settled.map((s) => (s.status === "fulfilled" ? s.value.split("\n").map((l) => l.trim()).filter(Boolean) : [])));
    this.host.post({ type: "suggestions", tags: this.tags });
  }
}

// Ask AI's tool table: what the model may ask Linyra to do, each a wrapper of an existing Linyra
// command. Read tools run at once (they read, or change only what the Log shows); write tools
// are planned (read-only), gathered, and run only after one confirmation that lists what runs in
// which repository. Pure: the schemas, input checks, plans and the confirmation's text.
import type { Branches } from "../../branchModel";
import { isValidRef } from "../../filterModel";
import { localize } from "../../i18n";
import { checkoutStep } from "../../multiRepoModel";
import type { AiTool } from "../types";

export type ToolKind = "read" | "write";
export interface ToolDef { kind: ToolKind; tool: AiTool }

const obj = (properties: Record<string, unknown>, required: string[] = []): AiTool["parameters"] => ({ type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false });
const text = (description: string) => ({ type: "string", description });
const repoList = { type: "array", items: { type: "string" }, description: "Repository names as list_repositories gives them. Leave out for every ticked repository." };

const def = (kind: ToolKind, name: string, description: string, parameters: AiTool["parameters"]): ToolDef => ({ kind, tool: { name, description, parameters } });

/** Every tool, read ones first. Names are the model's; each says which Linyra command it runs. */
export const TOOLS: readonly ToolDef[] = [
  def("read", "list_repositories", "List the workspace's repositories: name, whether ticked in the Repo List (the Log shows ticked ones), current branch, commits ahead/behind its upstream, uncommitted files.", obj({})),
  def("read", "list_branches", "List local and remote branch names of repositories (for checkout, merge or compare).", obj({ repos: repoList })),
  def("read", "search_log", "Search the Log: puts the query into its search box (operators: message:, author:, author:@me, committer:, commit:, file:, change:, type:merge, after:, before:, ref:, repo:) and returns the first matching commits.", obj({ query: text("The search text, in the search box's syntax.") }, ["query"])),
  def("read", "show_repositories", "Tick only these repositories in the Repo List, so the Log shows them; an empty list ticks every repository.", obj({ repos: { type: "array", items: { type: "string" }, description: "Repository names; [] for all." } }, ["repos"])),
  def("read", "select_commit", "Select a commit in the Log and show its changed files.", obj({ repo: text("Repository name."), sha: text("Commit hash, full or at least 7 characters.") }, ["repo", "sha"])),
  def("read", "show_commit", "Read a commit's full message and changed files (with +/- counts).", obj({ repo: text("Repository name."), sha: text("Commit hash.") }, ["repo", "sha"])),
  def("read", "open_file_history", "Open a file's history in the Log.", obj({ repo: text("Repository name."), path: text("Path relative to the repository root.") }, ["repo", "path"])),
  def("read", "compare_branches", "Open Compare Branches with these two sides (each repository uses the first name it has).", obj({ left: text("Left side (◀), e.g. a feature branch."), right: text("Right side (▶), e.g. main.") }, ["left", "right"])),
  def("read", "explain_commits", "Open an AI explanation of one or several commits.", obj({ commits: { type: "array", items: { type: "object", properties: { repo: { type: "string" }, sha: { type: "string" } }, required: ["repo", "sha"], additionalProperties: false } } }, ["commits"])),
  def("read", "explain_uncommitted", "Open an AI explanation of the uncommitted changes.", obj({ repos: repoList })),
  def("read", "review_changes", "Open an AI review of uncommitted changes, a commit, or a branch against the current branch.", obj({ target: { type: "string", enum: ["uncommitted", "commit", "branch"] }, repo: text("Repository name (commit, branch)."), sha: text("Commit hash (commit)."), branch: text("Branch name (branch).") }, ["target"])),
  def("read", "generate_commit_message", "Write an AI commit message for the files checked in the Commit side bar into its message box (nothing is committed).", obj({})),
  def("write", "fetch_all", "Fetch every repository from its default remote (Fetch All).", obj({})),
  def("write", "pull", "Pull repositories that are behind their upstream (fast-forward, or through VS Code's Git).", obj({ repos: repoList })),
  def("write", "push", "Open Push… for repositories with commits to push; the user picks what is pushed there.", obj({ repos: repoList })),
  def("write", "checkout_branch", "Check out a branch in every given repository that has it (a remote one is tracked).", obj({ branch: text("Branch name without the remote, e.g. release-1.4."), repos: repoList }, ["branch"])),
  def("write", "create_branch", "Create and check out a new branch from each repository's current commit.", obj({ branch: text("New branch name."), repos: repoList }, ["branch"])),
  def("write", "merge_branch", "Merge a branch into the current branch of every given repository that has it.", obj({ branch: text("Branch to merge (local name, or the remote branch name)."), repos: repoList }, ["branch"])),
  def("write", "stash_changes", "Stash a repository's uncommitted changes under a message.", obj({ repo: text("Repository name."), message: text("Stash message."), include_untracked: { type: "boolean", description: "Also stash new files git does not track yet." } }, ["repo", "message"])),
];

export const toolDef = (name: string): ToolDef | undefined => TOOLS.find((t) => t.tool.name === name);
export const MAX_TOOL_CALLS = 8;

export interface RepoName { id: string; name: string }

/** Names the model gave, as repositories: case does not matter; unknown names are reported. Absent or empty: the default set. */
export function resolveRepos(names: unknown, all: readonly RepoName[], fallback: readonly RepoName[]): { repos: RepoName[]; unknown: string[] } {
  const list = Array.isArray(names) ? names.filter((n): n is string => typeof n === "string" && n.trim() !== "") : [];
  if (list.length === 0) return { repos: [...fallback], unknown: [] };
  const repos: RepoName[] = [], unknown: string[] = [];
  for (const n of list) {
    const r = all.find((x) => x.name === n) ?? all.find((x) => x.name.toLowerCase() === n.trim().toLowerCase());
    if (r) { if (!repos.includes(r)) repos.push(r); } else unknown.push(n);
  }
  return { repos, unknown };
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The input's string field, or an error the model reads (it then corrects the call). */
export function field(input: unknown, key: string): string | { error: string } {
  const v = isObject(input) ? input[key] : undefined;
  return typeof v === "string" && v.trim() !== "" ? v.trim() : { error: `Missing "${key}".` };
}

/** A branch name from the model: a name git accepts, without "refs/heads/". */
export function branchName(input: unknown): string | { error: string } {
  const b = field(input, "branch");
  if (typeof b !== "string") return b;
  const name = b.replace(/^refs\/heads\//, "");
  return isValidRef(name) ? name : { error: `"${b}" is not a valid branch name.` };
}

/** One repository's part of a write: what runs there. */
export interface PlanRow { repo: string; action: string }

/** A write the model asked for, as the confirmation lists it; nothing has run yet. */
export interface WritePlan {
  tool: string;
  title: string;
  rows: PlanRow[];
  skipped: { repo: string; why: string }[];
}

export type AcrossKind = "checkout" | "create" | "merge";

/**
 * Checkout, New Branch or Merge across repositories, as Branches Across Repositories would do it
 * for each: from each repository's own branch listing (undefined: it could not be read).
 */
export function planAcross(kind: AcrossKind, name: string, repos: readonly { repo: RepoName; data: Branches | undefined }[]): WritePlan {
  const title = kind === "checkout" ? localize("Check out {0}", name) : kind === "create" ? localize("New branch {0}", name) : localize("Merge {0}", name);
  const plan: WritePlan = { tool: kind === "checkout" ? "checkout_branch" : kind === "create" ? "create_branch" : "merge_branch", title, rows: [], skipped: [] };
  for (const { repo, data } of repos) {
    if (!data) { plan.skipped.push({ repo: repo.name, why: localize("its branches could not be read") }); continue; }
    if (kind === "checkout") {
      const step = checkoutStep(data, name);
      if (step === "current") plan.skipped.push({ repo: repo.name, why: localize("already on it") });
      else if (step === "missing") plan.skipped.push({ repo: repo.name, why: localize("no such branch") });
      else {
        const remote = data.branches.find((b) => b.kind === "remote" && b.remoteBranch === name);
        plan.rows.push({ repo: repo.name, action: step === "local" ? `git switch ${name}` : `git switch --track ${remote ? `${remote.remote}/${name}` : name}` });
      }
    } else if (kind === "create") {
      if (data.branches.some((b) => b.kind === "local" && b.name === name)) plan.skipped.push({ repo: repo.name, why: localize("the branch already exists") });
      else plan.rows.push({ repo: repo.name, action: `git switch -c ${name}` + localize(" (from {0})", data.current ?? "HEAD") });
    } else {
      if (!data.current) { plan.skipped.push({ repo: repo.name, why: localize("no branch checked out") }); continue; }
      if (data.current === name) { plan.skipped.push({ repo: repo.name, why: localize("it is the current branch") }); continue; }
      const local = data.branches.some((b) => b.kind === "local" && b.name === name);
      const remotes = data.branches.filter((b) => b.kind === "remote" && b.remoteBranch === name);
      const ref = local ? name : remotes.length === 1 ? remotes[0].name : undefined;
      if (ref) plan.rows.push({ repo: repo.name, action: `git merge ${ref}` + localize(" (into {0})", data.current) });
      else plan.skipped.push({ repo: repo.name, why: localize("no such branch") });
    }
  }
  return plan;
}

/** Pull: the repositories behind their upstream (as of the last fetch); the others are named as up to date or without one. */
export function planPull(repos: readonly RepoName[], sync: ReadonlyMap<string, { ahead: number; behind: number }>): WritePlan {
  const plan: WritePlan = { tool: "pull", title: localize("Pull"), rows: [], skipped: [] };
  for (const r of repos) {
    const s = sync.get(r.id);
    if (!s) plan.skipped.push({ repo: r.name, why: localize("no upstream branch") });
    else if (s.behind === 0) plan.skipped.push({ repo: r.name, why: localize("up to date") });
    else plan.rows.push({ repo: r.name, action: localize("pull {0} incoming commits", s.behind) });
  }
  return plan;
}

/** Push: Linyra's Push… dialog for these repositories, where the user picks what is pushed. */
export function planPush(repos: readonly RepoName[], sync: ReadonlyMap<string, { ahead: number; behind: number }>): WritePlan {
  const plan: WritePlan = { tool: "push", title: localize("Push…"), rows: [], skipped: [] };
  for (const r of repos) {
    const s = sync.get(r.id);
    if (s && s.ahead === 0) plan.skipped.push({ repo: r.name, why: localize("nothing to push") });
    else plan.rows.push({ repo: r.name, action: s ? localize("offer {0} commits in Push…", s.ahead) : localize("offer in Push… (no upstream yet)") });
  }
  return plan;
}

export function planFetch(repos: readonly RepoName[]): WritePlan {
  return { tool: "fetch_all", title: localize("Fetch All"), rows: repos.map((r) => ({ repo: r.name, action: "git fetch" })), skipped: [] };
}

export function planStash(repo: RepoName, message: string, untracked: boolean, files: number): WritePlan {
  if (files === 0) return { tool: "stash_changes", title: localize("Stash Changes"), rows: [], skipped: [{ repo: repo.name, why: localize("no uncommitted changes") }] };
  return { tool: "stash_changes", title: localize("Stash Changes"), skipped: [],
    rows: [{ repo: repo.name, action: `git stash push${untracked ? " --include-untracked" : ""} -m ${JSON.stringify(message)}` }] };
}

/** The one confirmation for every write of a turn: what runs, repository by repository; undefined when nothing would run. */
export function confirmation(plans: readonly WritePlan[]): { message: string; detail: string; button: string } | undefined {
  const runs = plans.filter((p) => p.rows.length > 0);
  if (runs.length === 0) return undefined;
  const repos = new Set(runs.flatMap((p) => p.rows.map((r) => r.repo)));
  const message = runs.length === 1
    ? localize("Run {0} in {1}?", runs[0].title, runs[0].rows.length === 1 ? runs[0].rows[0].repo : localize("{0} repositories", runs[0].rows.length))
    : localize("Run {0} actions in {1}?", runs.length, repos.size === 1 ? [...repos][0] : localize("{0} repositories", repos.size));
  const detail = plans.map((p, i) => [
    `${i + 1}. ${p.title}`,
    ...p.rows.map((r) => `   ${r.repo}: ${r.action}`),
    ...(p.skipped.length ? [`   ${localize("Left as they are: {0}", p.skipped.map((s) => `${s.repo} (${s.why})`).join(", "))}`] : []),
  ].join("\n")).join("\n\n");
  return { message, detail: `${detail}\n\n${localize("Asked by AI. Nothing runs until you choose Run.")}`, button: localize("Run") };
}

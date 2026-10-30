// Linyra: Ask AI…: the tool loop (askAi.ts) over Linyra's own commands. Read tools run as the
// model calls them; write tools come back as plans, shown in one modal confirmation, and run one
// after another through the commands a user would run (Fetch All, Pull, Push…, Branches Across
// Repositories, Stash Changes…). Nothing here writes to a repository itself.
import * as path from "path";
import * as vscode from "vscode";
import { branchArgs, parseBranches, type Branches } from "../../branchModel";
import { parseShow, showArgs } from "../../commitDetail";
import type { CommitPanel } from "../../commitPanel";
import type { CompareRepos } from "../../compareRepos";
import { isValidRef } from "../../filterModel";
import { localize } from "../../i18n";
import type { LogView } from "../../logView";
import type { MultiRepo } from "../../multiRepo";
import { runPool } from "../../pool";
import type { Repo } from "../../types";
import type { Ask } from "../../uncommittedActions";
import type { UncommittedStore } from "../../uncommittedStore";
import { runAsk, type AskHost, type AskResult } from "./askAi";
import type { AiFeatures } from "./commands";
import { branchName, confirmation, field, planAcross, planFetch, planPull, planPush, planStash, resolveRepos, type AcrossKind, type RepoName, type WritePlan } from "./tools";

const MAX_LISTED = 30;
const MAX_BRANCHES = 40;
/** A short answer is a notification; a longer one opens in the editor area. */
const SHORT_ANSWER = 280;
const HEX = /^[0-9a-f]{7,64}$/i;

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isoDate = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export interface AskDeps {
  features: AiFeatures;
  log: Pick<LogView, "repoList" | "tickedRepos" | "countedRun" | "search" | "setRepoFilter" | "onMessage" | "fileHistory" | "upstream">;
  uncommitted: Pick<UncommittedStore, "works" | "get">;
  compareRepos: Pick<CompareRepos, "open" | "setPair">;
  multiRepo: Pick<MultiRepo, "push" | "across">;
  commitPanel: Pick<CommitPanel, "generate">;
  ask: Ask;
}

/** What the progress notification says while a tool runs. */
function callLabel(name: string): string {
  switch (name) {
    case "search_log": return localize("Searching the Log…");
    case "list_repositories": case "list_branches": case "show_commit": return localize("Reading the repositories…");
    case "select_commit": case "show_repositories": case "open_file_history": case "compare_branches": return localize("Updating the view…");
    default: return localize("Planning {0}…", name.replace(/_/g, " "));
  }
}

export class AskAi {
  constructor(private readonly deps: AskDeps) {}

  private get all(): RepoName[] {
    return this.deps.log.repoList.map((r) => ({ id: r.id, name: r.name }));
  }

  private get ticked(): RepoName[] {
    return this.deps.log.tickedRepos().map((r) => ({ id: r.id, name: r.name }));
  }

  private repoOf(r: RepoName): Repo {
    return this.deps.log.repoList.find((x) => x.id === r.id)!;
  }

  /**
   * linyra.ai.ask: a request in plain words, from a box (or the argument): under the Log's ✨
   * button when started there, at the top of the window from the Command Palette (Ask.input).
   */
  async run(text?: unknown): Promise<AskResult | undefined> {
    const question = typeof text === "string" && text.trim() ? text.trim() : (await this.deps.ask.input(
      localize("Ask about these repositories, or say what to do. Changes to a repository wait for your confirmation."),
      localize("For example: dana's commits in acme-api since Monday"), { title: localize("Ask AI") },
    ))?.trim();
    if (!question) return undefined;
    const ai = await this.deps.features.ready();
    if (!ai) return undefined;
    let result: AskResult;
    try {
      result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: localize("Linyra AI"), cancellable: true }, (progress, token) => {
        const ctl = new AbortController();
        token.onCancellationRequested(() => ctl.abort());
        progress.report({ message: localize("Thinking…") });
        return runAsk(ai, this.host(), question, { context: this.context(), language: vscode.env.language, signal: ctl.signal, onCall: (c) => progress.report({ message: callLabel(c.name) }) });
      });
    } catch (e) {
      this.deps.features.fail(e);
      return undefined;
    }
    let note = "";
    const c = confirmation(result.planned.map((p) => p.plan));
    if (c) {
      if (await this.deps.ask.warning(c.message, c.detail, c.button)) {
        for (const p of result.planned) {
          if (p.plan.rows.length === 0) continue;
          try {
            await p.run();
          } catch (e) {
            void vscode.window.showErrorMessage(localize("{0} failed: {1}", p.plan.title, messageOf(e)));
          }
        }
      } else {
        note = localize("Nothing was run.");
      }
    }
    const answer = [result.answer || (result.planned.length ? "" : localize("The model gave no answer.")), result.limited ? localize("(Stopped after {0} tool calls.)", result.calls.length) : "", note].filter(Boolean).join(" ");
    if (answer && answer.length <= SHORT_ANSWER && !answer.includes("\n")) void vscode.window.showInformationMessage(answer);
    else if (answer) await this.deps.features.present(ai, localize("Ask AI"), async (write) => write(`> ${question.replace(/\n/g, "\n> ")}\n\n${answer}\n`));
    return result;
  }

  /** The workspace in a few lines: names only. */
  private context(): string {
    const ticked = new Set(this.ticked.map((r) => r.id));
    const d = new Date();
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return [`Today: ${date}`, `Repositories (the Log shows the ticked ones): ${this.all.slice(0, 100).map((r) => `${r.name}${ticked.has(r.id) ? " (ticked)" : ""}`).join(", ") || "(none)"}`].join("\n");
  }

  private host(): AskHost {
    return { read: (name, input, signal) => this.read(name, input, signal), plan: (name, input, signal) => this.plan(name, input, signal) };
  }

  private oneRepo(input: unknown): Repo | { error: string } {
    const name = field(input, "repo");
    if (typeof name !== "string") return name;
    const { repos } = resolveRepos([name], this.all, []);
    return repos.length ? this.repoOf(repos[0]) : { error: `No repository named "${name}". list_repositories names them.` };
  }

  private async branchesOf(repos: readonly RepoName[], signal: AbortSignal): Promise<{ repo: RepoName; data: Branches | undefined }[]> {
    const settled = await runPool(repos, 8, async (r, s) => {
      const root = this.repoOf(r).root;
      const [refs, remotes] = await Promise.all([this.deps.log.countedRun(root, branchArgs(), s), this.deps.log.countedRun(root, ["remote"], s)]);
      return parseBranches(refs, remotes.split(/\r?\n/).filter(Boolean));
    }, signal);
    return repos.map((repo, i) => ({ repo, data: settled[i]?.status === "fulfilled" ? (settled[i] as PromiseFulfilledResult<Branches>).value : undefined }));
  }

  /** A hash the model gave, as the full one (git rev-parse in that repository). */
  private async fullSha(repo: Repo, sha: string, signal: AbortSignal): Promise<string | undefined> {
    if (!HEX.test(sha)) return undefined;
    return (await this.deps.log.countedRun(repo.root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${sha}^{commit}`], signal).catch(() => "")).trim() || undefined;
  }

  private async read(name: string, input: unknown, signal: AbortSignal): Promise<string> {
    const f = this.deps.features;
    switch (name) {
      case "list_repositories": {
        const ticked = new Set(this.ticked.map((r) => r.id));
        const sync = this.deps.log.upstream.byRepo();
        const works = new Map(this.deps.uncommitted.works().map((w) => [w.repoId, new Set([...w.staged, ...w.changes].map((x) => x.path)).size]));
        return this.deps.log.repoList.map((r) => {
          const s = sync.get(r.id);
          return [`${r.name}${ticked.has(r.id) ? " (ticked)" : ""}`, s ? `ahead ${s.ahead}, behind ${s.behind}` : "no upstream known", `${works.get(r.id) ?? 0} uncommitted files`].join("; ");
        }).join("\n") || "No repositories.";
      }
      case "list_branches": {
        const { repos, unknown } = resolveRepos(isObject(input) ? input.repos : undefined, this.all, this.ticked);
        const read = await this.branchesOf(repos, signal);
        const lines = read.map(({ repo, data }) => {
          if (!data) return `${repo.name}: branches could not be read`;
          const local = data.branches.filter((b) => b.kind === "local").map((b) => b.name);
          const remote = data.branches.filter((b) => b.kind === "remote").map((b) => b.name);
          const cap = (l: string[]) => l.slice(0, MAX_BRANCHES).join(", ") + (l.length > MAX_BRANCHES ? `, … (${l.length - MAX_BRANCHES} more)` : "");
          return `${repo.name}: current ${data.current ?? "(detached)"}; local: ${cap(local) || "-"}; remote: ${cap(remote) || "-"}`;
        });
        return [...lines, ...(unknown.length ? [`Unknown repositories: ${unknown.join(", ")}`] : [])].join("\n");
      }
      case "search_log": {
        const q = field(input, "query");
        if (typeof q !== "string") throw new Error(q.error);
        const rows = await this.deps.log.search(q.replace(/[\r\n]+/g, " "));
        const names = new Map(this.deps.log.repoList.map((r) => [r.id, r.name]));
        if (rows.length === 0) return "No commits match. The Log's search box now holds this query.";
        return [`${rows.length} commits on the Log's first page${rows.length > MAX_LISTED ? `; the first ${MAX_LISTED}` : ""}:`,
          ...rows.slice(0, MAX_LISTED).map((c) => `${names.get(c.repoId) ?? c.repoId} ${c.sha.slice(0, 10)} ${isoDate(c.time)} ${c.author}: ${c.subject}`)].join("\n");
      }
      case "show_repositories": {
        const list = isObject(input) && Array.isArray(input.repos) ? input.repos : [];
        if (list.length === 0) { await this.deps.log.setRepoFilter(null); return "Every repository is ticked."; }
        const { repos, unknown } = resolveRepos(list, this.all, []);
        if (repos.length === 0) throw new Error(`No repositories named ${unknown.join(", ")}.`);
        await this.deps.log.setRepoFilter(repos.map((r) => r.id));
        return `Ticked: ${repos.map((r) => r.name).join(", ")}${unknown.length ? `. Unknown: ${unknown.join(", ")}` : ""}.`;
      }
      case "select_commit": {
        const repo = this.oneRepo(input);
        if ("error" in repo) throw new Error(repo.error);
        const sha = field(input, "sha");
        if (typeof sha !== "string" || !HEX.test(sha)) throw new Error("Give the commit's hash.");
        const rows = await this.deps.log.search(sha.toLowerCase());
        const c = rows.find((r) => r.repoId === repo.id && r.sha.startsWith(sha.toLowerCase()));
        if (!c) return `No commit ${sha} in ${repo.name}.`;
        await this.deps.log.onMessage({ type: "select", repoId: repo.id, sha: c.sha });
        return `Selected ${c.sha.slice(0, 10)} in ${repo.name}: ${c.subject}`;
      }
      case "show_commit": {
        const repo = this.oneRepo(input);
        if ("error" in repo) throw new Error(repo.error);
        const sha = await this.fullSha(repo, String(isObject(input) ? input.sha ?? "" : ""), signal);
        if (!sha) throw new Error("No such commit.");
        const { message, files } = parseShow(await this.deps.log.countedRun(repo.root, showArgs(sha), signal));
        return [`${repo.name} ${sha}`, message, "", `${files.length} files:`, ...files.slice(0, 100).map((x) => `${x.status ?? "M"} ${x.path}${x.oldPath ? ` (from ${x.oldPath})` : ""} +${x.added ?? "bin"} -${x.deleted ?? "bin"}`)].join("\n");
      }
      case "open_file_history": {
        const repo = this.oneRepo(input);
        if ("error" in repo) throw new Error(repo.error);
        const p = field(input, "path");
        if (typeof p !== "string") throw new Error(p.error);
        const rel = p.replace(/\\/g, "/").replace(/^\.\//, "");
        if (path.posix.isAbsolute(rel) || /^[a-z]:/i.test(rel) || rel.split("/").includes("..")) throw new Error("Give a path inside the repository.");
        await this.deps.log.fileHistory(vscode.Uri.file(path.join(repo.root, ...rel.split("/"))));
        return `Showing the history of ${rel} in ${repo.name}.`;
      }
      case "compare_branches": {
        const left = field(input, "left"), right = field(input, "right");
        if (typeof left !== "string" || typeof right !== "string") throw new Error("Give both sides.");
        if (![...left.split(/\s+/), ...right.split(/\s+/)].every(isValidRef)) throw new Error("Give branch names git accepts.");
        await this.deps.compareRepos.setPair({ left, right });
        await this.deps.compareRepos.open();
        return `Compare Branches shows ${left} against ${right}.`;
      }
      case "explain_commits": {
        const list = isObject(input) && Array.isArray(input.commits) ? input.commits.slice(0, 20) : [];
        const targets: { repo: Repo; sha: string }[] = [];
        for (const item of list) {
          const repo = this.oneRepo(item);
          const sha = "error" in repo ? undefined : await this.fullSha(repo, String(isObject(item) ? item.sha ?? "" : ""), signal);
          if ("error" in repo || !sha) throw new Error(`Unknown commit ${JSON.stringify(item)}.`);
          targets.push({ repo, sha });
        }
        if (targets.length === 0) throw new Error("Give the commits.");
        return f.start(() => f.explainTargets(targets));
      }
      case "explain_uncommitted": {
        const { repos } = resolveRepos(isObject(input) ? input.repos : undefined, this.all, this.ticked);
        const ids = new Set(repos.map((r) => r.id));
        const works = f.targetWorks(undefined).filter((w) => ids.has(w.repoId));
        if (works.length === 0) return "No uncommitted changes there.";
        return f.start(() => f.explainWorks(works));
      }
      case "review_changes": {
        const target = isObject(input) ? input.target : undefined;
        if (target === "uncommitted") {
          const repo = isObject(input) && input.repo ? this.oneRepo(input) : undefined;
          if (repo && "error" in repo) throw new Error(repo.error);
          return f.start(() => f.review(repo ? { repoId: repo.id } : undefined));
        }
        const repo = this.oneRepo(input);
        if ("error" in repo) throw new Error(repo.error);
        if (target === "commit") {
          const sha = await this.fullSha(repo, String(isObject(input) ? input.sha ?? "" : ""), signal);
          if (!sha) throw new Error("No such commit.");
          return f.start(() => f.review({ repoId: repo.id, sha }));
        }
        if (target === "branch") {
          const b = branchName(input);
          if (typeof b !== "string") throw new Error(b.error);
          return f.start(() => f.review({ repoId: repo.id, ref: b }));
        }
        throw new Error('target is "uncommitted", "commit" or "branch".');
      }
      case "generate_commit_message":
        void this.deps.commitPanel.generate();
        return "Writing into the Commit side bar's message box; nothing is committed.";
    }
    throw new Error(`No tool named ${name}.`);
  }

  private async plan(name: string, input: unknown, signal: AbortSignal): Promise<{ plan: WritePlan; run: () => Promise<string> } | { error: string }> {
    const upstream = this.deps.log.upstream;
    const repos = (all: readonly RepoName[]) => resolveRepos(isObject(input) ? input.repos : undefined, all, this.ticked);
    switch (name) {
      case "fetch_all":
        return { plan: planFetch(this.all), run: async () => { await upstream.fetchAll(); return "fetched"; } };
      case "pull": {
        const { repos: list, unknown } = repos(this.all);
        if (unknown.length) return { error: `Unknown repositories: ${unknown.join(", ")}.` };
        const plan = planPull(list, upstream.byRepo());
        const behind = list.filter((r) => plan.rows.some((x) => x.repo === r.name)).map((r) => this.repoOf(r));
        return { plan, run: async () => { for (const r of behind) await upstream.pull(r); return "pulled"; } };
      }
      case "push": {
        const { repos: list, unknown } = repos(this.ticked);
        if (unknown.length) return { error: `Not ticked or unknown: ${unknown.join(", ")}. Push… works on ticked repositories.` };
        const plan = planPush(list, upstream.byRepo());
        const ids = new Set(list.filter((r) => plan.rows.some((x) => x.repo === r.name)).map((r) => r.id));
        return { plan, run: async () => { await this.deps.multiRepo.push(ids); return "push offered"; } };
      }
      case "checkout_branch": case "create_branch": case "merge_branch": {
        const kind: AcrossKind = name === "checkout_branch" ? "checkout" : name === "create_branch" ? "create" : "merge";
        const b = branchName(input);
        if (typeof b !== "string") return b;
        const { repos: list, unknown } = repos(this.ticked);
        if (unknown.length) return { error: `Not ticked or unknown: ${unknown.join(", ")}. Branch actions work on ticked repositories.` };
        const plan = planAcross(kind, b, await this.branchesOf(list, signal));
        const ids = new Set(list.filter((r) => plan.rows.some((x) => x.repo === r.name)).map((r) => r.id));
        return { plan, run: async () => { await this.deps.multiRepo.across(kind, b, ids); return "done"; } };
      }
      case "stash_changes": {
        const repo = this.oneRepo(input);
        if ("error" in repo) return repo;
        const message = field(input, "message");
        if (typeof message !== "string") return message;
        const untracked = isObject(input) && input.include_untracked === true;
        const work = this.deps.uncommitted.get(repo.id);
        const files = work ? new Set([...work.staged, ...work.changes.filter((x) => untracked || !x.untracked)].map((x) => x.path)).size : 0;
        const text = message.replace(/[\r\n]+/g, " ").slice(0, 200);
        return { plan: planStash(repo, text, untracked, files), run: async () => { await this.deps.features.stash(repo, text, untracked); return "stashed"; } };
      }
    }
    return { error: `No write tool named ${name}.` };
  }
}

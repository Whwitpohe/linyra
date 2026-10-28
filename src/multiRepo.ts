import * as vscode from "vscode";
import { branchArgs, parseBranches, type Branches } from "./branchModel";
import { isValidRef } from "./filterModel";
import { localize } from "./i18n";
import type { RunGit } from "./logQuery";
import { checkoutStep, multiCommands, parseOutgoing, pushPlan, sharedBranches, updateReason, type UpdateMethod } from "./multiRepoModel";
import { runPool } from "./pool";
import type { Repo } from "./types";
import type { Ask } from "./uncommittedView";
import { aheadBehindArgs, FETCH_ENV, parseAheadBehind } from "./upstream";

/** A write must finish once started: a merge killed halfway leaves the working tree mid-change. */
const WRITE_SIGNAL = new AbortController().signal;
/** Writes may take the index lock; git's words stay English for updateReason; never an editor or a prompt. */
const WRITE_ENV = { GIT_OPTIONAL_LOCKS: "1", LC_ALL: "C", GIT_EDITOR: "true", ...FETCH_ENV };
const PUSH_TIMEOUT_MS = 60_000;
/** Several repositories at once, but few: these write, and pushes are network-bound. */
const WRITE_CONCURRENCY = 4;

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface MultiRepoHost {
  /** The Log view: progress shows on its title. */
  viewId: string;
  /** The ticked repositories: every action here works across them. */
  repos(): readonly Repo[];
  run: RunGit;
  ask: Ask;
  /** Fetch All (with its own progress, timeouts and report). */
  fetchAll(): Promise<unknown>;
  /** These repositories changed: one Log reload, their uncommitted work, upstream distances and branches. */
  changed(repoIds: readonly string[]): Promise<void>;
}

/** What one action did across the repositories (also the integration suite's answer). */
export interface MultiResult { done: string[]; unchanged: string[]; skipped: { name: string; reason: string }[] }

/**
 * Work across every ticked repository at once, as the JetBrains IDEs do for a project with
 * several Git roots: a branch operation in all of them, one Push dialog for every repository with
 * commits to send, and Update Project (fetch, then merge or rebase each onto its upstream).
 */
export class MultiRepo {
  private running = false;
  private lastMethod: UpdateMethod = "merge";

  constructor(private readonly host: MultiRepoHost) {}

  /** ⋯ → Branches Across Repositories…: check out, create or merge one branch name in every ticked repository. */
  async branches(): Promise<MultiResult | undefined> {
    const i = await this.host.ask.pick([
      { label: localize("Check Out Branch…"), description: localize("in every ticked repository that has it") },
      { label: localize("New Branch…"), description: localize("from each repository's checked-out commit") },
      { label: localize("Merge into Current…"), description: localize("in every ticked repository that has it") },
    ], localize("Branches across {0} repositories", this.host.repos().length));
    if (i === undefined) return undefined;
    return this.exclusive(() => (i === 0 ? this.checkout() : i === 1 ? this.create() : this.merge()));
  }

  private async checkout(): Promise<MultiResult | undefined> {
    const all = await this.read();
    const name = await this.pickShared(all, localize("Branch to check out in every repository"));
    if (!name) return undefined;
    const steps = all.map((x) => ({ ...x, step: x.data ? checkoutStep(x.data, name) : "missing" as const }));
    const act = steps.filter((s) => s.step === "local" || s.step === "track");
    const missing = steps.filter((s) => s.step === "missing").map((s) => s.repo.name);
    if (!act.length) return this.report(localize("Check out {0}", name), { done: [], unchanged: steps.filter((s) => s.step === "current").map((s) => s.repo.name), skipped: missing.map((n) => ({ name: n, reason: localize("no such branch") })) });
    if (!(await this.host.ask.warning(localize("Check out {0} in {1} repositories?", name, act.length),
      missing.length ? localize("Not in {0}: those stay as they are.", missing.join(", ")) : localize("Each repository's working tree changes to that branch."), localize("Check Out")))) return undefined;
    const result = await this.each(localize("Checking out {0}", name), act.map((s) => s.repo), async (repo) => {
      const s = act.find((x) => x.repo.id === repo.id)!;
      const remote = s.data!.branches.find((b) => b.kind === "remote" && b.remoteBranch === name)?.remote;
      await this.git(repo, s.step === "local" || !remote ? multiCommands.checkout(name) : multiCommands.track(name, remote));
    });
    result.unchanged.push(...steps.filter((s) => s.step === "current").map((s) => s.repo.name));
    result.skipped.push(...missing.map((n) => ({ name: n, reason: localize("no such branch") })));
    return this.report(localize("Check out {0}", name), result);
  }

  private async create(): Promise<MultiResult | undefined> {
    const all = await this.read();
    const name = (await this.host.ask.input(localize("New branch in {0} repositories, from each one's checked-out commit", all.length), localize("Branch name"),
      { validate: (v) => (isValidRef(v.trim()) ? undefined : localize("Enter a valid branch name.")) }))?.trim();
    if (!name || !isValidRef(name)) return undefined;
    const taken = all.filter((x) => x.data?.branches.some((b) => b.kind === "local" && b.name === name));
    const act = all.filter((x) => x.data && !taken.includes(x));
    const result = await this.each(localize("Creating {0}", name), act.map((x) => x.repo), (repo) => this.git(repo, multiCommands.create(name)));
    result.skipped.push(...taken.map((x) => ({ name: x.repo.name, reason: localize("the branch already exists") })));
    return this.report(localize("New branch {0}", name), result);
  }

  private async merge(): Promise<MultiResult | undefined> {
    const all = await this.read();
    const name = await this.pickShared(all, localize("Branch to merge into each repository's current branch"));
    if (!name) return undefined;
    const plans = all.map((x) => {
      if (!x.data?.current) return { ...x, ref: undefined, why: localize("no branch checked out") };
      if (x.data.current === name) return { ...x, ref: undefined, why: localize("it is the current branch") };
      if (x.data.branches.some((b) => b.kind === "local" && b.name === name)) return { ...x, ref: name, why: "" };
      const remotes = x.data.branches.filter((b) => b.kind === "remote" && b.remoteBranch === name);
      return remotes.length === 1 ? { ...x, ref: remotes[0].name, why: "" } : { ...x, ref: undefined, why: localize("no such branch") };
    });
    const act = plans.filter((p) => p.ref);
    if (!act.length) return this.report(localize("Merge {0}", name), { done: [], unchanged: [], skipped: plans.map((p) => ({ name: p.repo.name, reason: p.why })) });
    if (!(await this.host.ask.warning(localize("Merge {0} into the current branch of {1} repositories?", name, act.length),
      act.map((p) => `${p.repo.name}: ${p.ref} → ${p.data!.current}`).join("\n"), localize("Merge")))) return undefined;
    const result = await this.each(localize("Merging {0}", name), act.map((p) => p.repo), (repo) => this.git(repo, multiCommands.merge(act.find((p) => p.repo.id === repo.id)!.ref!)));
    result.skipped.push(...plans.filter((p) => !p.ref).map((p) => ({ name: p.repo.name, reason: p.why })));
    return this.report(localize("Merge {0}", name), result);
  }

  /** ⇡ Push…: every ticked repository with commits to send, its target and its outgoing commits; push the ones kept ticked. */
  push(): Promise<MultiResult | undefined> {
    return this.exclusive(async () => {
      const all = await this.read();
      const rows = (await runPool(all, WRITE_CONCURRENCY, async (x) => {
        const plan = x.data && pushPlan(x.data);
        if (!plan) return undefined;
        const commits = parseOutgoing(await this.host.run(x.repo.root, multiCommands.outgoing(!plan.setUpstream), WRITE_SIGNAL));
        return commits.length ? { repo: x.repo, plan, commits } : undefined;
      }, WRITE_SIGNAL)).flatMap((s) => (s.status === "fulfilled" && s.value ? [s.value] : []));
      if (!rows.length) {
        void vscode.window.showInformationMessage(localize("Linyra: nothing to push in the ticked repositories."));
        return { done: [], unchanged: all.map((x) => x.repo.name), skipped: [] };
      }
      const chosen = await this.host.ask.pickMany(rows.map((r) => ({
        label: r.repo.name, picked: true,
        description: `${r.plan.branch} → ${r.plan.remote}/${r.plan.destination}${r.plan.setUpstream ? ` (${localize("new")})` : ""} · ${localize(r.commits.length === 1 ? "1 commit" : "{0} commits", r.commits.length)}`,
        detail: r.commits.slice(0, 3).map((c) => `${c.sha} ${c.subject}`).join("  ·  ") + (r.commits.length > 3 ? "  …" : ""),
      })), localize("Push to {0} repositories", rows.length));
      if (!chosen?.length) return undefined;
      const picked = chosen.map((i) => rows[i]);
      const result = await this.each(localize("Pushing"), picked.map((r) => r.repo), async (repo) => {
        const { plan } = picked.find((r) => r.repo.id === repo.id)!;
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), PUSH_TIMEOUT_MS);
        try {
          await this.host.run(repo.root, multiCommands.push(plan.remote, plan.branch, plan.destination, plan.setUpstream), ctl.signal, { tree: true, env: WRITE_ENV });
        } finally {
          clearTimeout(timer);
        }
      });
      return this.report(localize("Push"), result);
    });
  }

  /** ⇣ Update Project: Fetch All, then merge or rebase every ticked repository that is behind its upstream. */
  update(): Promise<MultiResult | undefined> {
    return this.exclusive(async () => {
      const methods: { method: UpdateMethod; label: string; description: string }[] = [
        { method: "merge", label: localize("Merge incoming changes"), description: localize("a merge commit where the branches diverged") },
        { method: "rebase", label: localize("Rebase onto incoming changes"), description: localize("local commits replayed on top; needs a clean working tree") },
      ];
      if (this.lastMethod === "rebase") methods.reverse();
      const i = await this.host.ask.pick(methods, localize("Update {0} repositories", this.host.repos().length));
      if (i === undefined) return undefined;
      const method = this.lastMethod = methods[i].method;
      await this.host.fetchAll();
      const repos = [...this.host.repos()];
      const distance = await runPool(repos, WRITE_CONCURRENCY, async (r) => parseAheadBehind(await this.host.run(r.root, aheadBehindArgs(), WRITE_SIGNAL)), WRITE_SIGNAL);
      const behind = repos.filter((_, j) => { const d = distance[j]; return d.status === "fulfilled" && (d.value?.behind ?? 0) > 0; });
      const noUpstream = repos.filter((_, j) => { const d = distance[j]; return d.status === "rejected" || d.value === null; });
      const result = await this.each(localize("Updating"), behind, (repo) => this.git(repo, multiCommands.update(method)));
      result.unchanged.push(...repos.filter((r) => !behind.includes(r) && !noUpstream.includes(r)).map((r) => r.name));
      result.skipped.push(...noUpstream.map((r) => ({ name: r.name, reason: localize("no upstream branch") })));
      return this.report(localize("Update Project"), result);
    });
  }

  private async exclusive<T>(work: () => Promise<T>): Promise<T | undefined> {
    if (this.running) {
      void vscode.window.showInformationMessage(localize("Linyra: an operation across repositories is already running."));
      return undefined;
    }
    this.running = true;
    try {
      return await work();
    } finally {
      this.running = false;
    }
  }

  private git(repo: Repo, args: string[]): Promise<string> {
    return this.host.run(repo.root, args, WRITE_SIGNAL, { env: WRITE_ENV });
  }

  /** Each ticked repository's branches and remotes (undefined when they could not be read). */
  private async read(): Promise<{ repo: Repo; data: Branches | undefined }[]> {
    const repos = [...this.host.repos()];
    const settled = await runPool(repos, 8, async (r) => {
      const [refs, remotes] = await Promise.all([this.host.run(r.root, branchArgs(), WRITE_SIGNAL), this.host.run(r.root, ["remote"], WRITE_SIGNAL)]);
      return parseBranches(refs, remotes.split(/\r?\n/).filter(Boolean));
    }, WRITE_SIGNAL);
    return repos.map((repo, i) => ({ repo, data: settled[i].status === "fulfilled" ? (settled[i] as PromiseFulfilledResult<Branches>).value : undefined }));
  }

  private async pickShared(all: { data: Branches | undefined }[], placeHolder: string): Promise<string | undefined> {
    const shared = sharedBranches(all.flatMap((x) => (x.data ? [x.data] : [])));
    const i = await this.host.ask.pick(shared.map((s) => ({ label: s.name, description: localize("in {0} of {1} repositories", s.repos, all.length) })), placeHolder);
    return i === undefined ? undefined : shared[i]?.name;
  }

  /** Runs one write per repository (a few at a time) under the Log's progress; never stops at the first failure. */
  private async each(title: string, repos: readonly Repo[], work: (repo: Repo) => Promise<unknown>): Promise<MultiResult> {
    const settled = await vscode.window.withProgress({ location: { viewId: this.host.viewId }, title }, () => runPool(repos, WRITE_CONCURRENCY, (r) => work(r), WRITE_SIGNAL));
    const result: MultiResult = { done: [], unchanged: [], skipped: [] };
    settled.forEach((s, i) => {
      if (s.status === "fulfilled") result.done.push(repos[i].name);
      else result.skipped.push({ name: repos[i].name, reason: localize(updateReason(messageOf(s.reason))) });
    });
    if (repos.length) await this.host.changed(repos.map((r) => r.id));
    return result;
  }

  private report(what: string, r: MultiResult): MultiResult {
    const done = localize("{0}: done in {1} of {2} repositories.", what, r.done.length, r.done.length + r.unchanged.length + r.skipped.length);
    if (r.skipped.length === 0) vscode.window.setStatusBarMessage(`Linyra — ${done}`, 8000);
    else {
      const list = r.skipped.slice(0, 4).map((s) => `${s.name} (${s.reason})`).join(", ");
      const more = r.skipped.length > 4 ? localize(" and {0} more", r.skipped.length - 4) : "";
      void vscode.window.showWarningMessage(`Linyra — ${done} ${localize("Left as they were: {0}{1}.", list, more)}`);
    }
    return r;
  }
}

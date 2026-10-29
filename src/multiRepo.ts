import * as vscode from "vscode";
import { branchArgs, parseBranches, type Branches } from "./branchModel";
import { isValidRef } from "./filterModel";
import { checkValue, listValue, textValue } from "./formModel";
import { localize } from "./i18n";
import type { RunGit } from "./logQuery";
import { checkoutStep, droppedArgs, forcePushPrompt, isProtected, multiReport, parseDropped, type ForcePush, multiCommands, parseOutgoing, pushPlan, sharedBranches, stoppedOnConflicts, tagRemote, updateMethodOrder, updateMethodSetting, updateReason, type ReportKind, type UpdateMethod } from "./multiRepoModel";
import { runPool } from "./pool";
import type { Repo } from "./types";
import { gitMessage, type Ask } from "./uncommittedActions";
import { gitText } from "./actionErrors";
import { checkoutBlock, smartCheckout, smartLabel, smartPrompt, smartReport, type CheckoutBlock } from "./smartCheckout";
import { aheadBehindArgs, FETCH_ENV, parseAheadBehind } from "./upstream";

/** A write must finish once started: a merge killed halfway leaves the working tree mid-change. */
const WRITE_SIGNAL = new AbortController().signal;
/** Writes may take the index lock; git's words stay English for updateReason; never an editor or a prompt. */
const WRITE_ENV = { GIT_OPTIONAL_LOCKS: "1", LC_ALL: "C", GIT_EDITOR: "true", ...FETCH_ENV };
const PUSH_TIMEOUT_MS = 60_000;
/** Several repositories at once, but few: these write, and pushes are network-bound. */
const WRITE_CONCURRENCY = 4;



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
  /** Remembers Update Project's last method. */
  state: vscode.Memento;
}

const LAST_METHOD = "linyra.updateMethod.last";
const METHOD_NAMES: Record<UpdateMethod, string> = { merge: "merge", rebase: "rebase", ffOnly: "fast-forward only" };
const PUSH_TAGS = "linyra.tagAcross.push";

/** A branch action's name given beforehand, and the repositories it is kept to. */
interface Preset { name: string; only?: ReadonlySet<string> }

/**
 * What one action did across the repositories (also the integration suite's answer). `stopped`:
 * git stopped half-way on conflicts (mid-merge or mid-rebase); `skipped`: left as they were
 * (`failed`: git refused, as opposed to nothing to do there).
 */
export interface MultiResult { done: string[]; unchanged: string[]; stopped: { name: string; reason: string }[]; skipped: { name: string; reason: string; failed?: boolean }[] }

/**
 * Work across every ticked repository at once, as the JetBrains IDEs do for a project with
 * several Git roots: a branch operation in all of them, one Push dialog for every repository with
 * commits to send, and Update Project (fetch, then merge or rebase each onto its upstream).
 */
export class MultiRepo {
  private running = false;

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

  /**
   * One of Branches Across Repositories' actions with its branch already named and confirmed (Ask
   * AI lists what runs where first): no picker, no second prompt; `only` keeps it to those repositories.
   */
  across(kind: "checkout" | "create" | "merge", name: string, only?: ReadonlySet<string>): Promise<MultiResult | undefined> {
    const preset = { name, only };
    return this.exclusive(() => (kind === "checkout" ? this.checkout(preset) : kind === "create" ? this.create(preset) : this.merge(preset)));
  }

  private async checkout(preset?: Preset): Promise<MultiResult | undefined> {
    const all = await this.read(preset?.only);
    const name = preset?.name ?? await this.pickShared(all, localize("Branch to check out in every repository"));
    if (!name) return undefined;
    const steps = all.map((x) => ({ ...x, step: x.data ? checkoutStep(x.data, name) : "missing" as const }));
    const act = steps.filter((s) => s.step === "local" || s.step === "track");
    const missing = steps.filter((s) => s.step === "missing").map((s) => s.repo.name);
    if (!act.length) return this.report(localize("Check out {0}", name), "checkout", { done: [], unchanged: steps.filter((s) => s.step === "current").map((s) => s.repo.name), stopped: [], skipped: missing.map((n) => ({ name: n, reason: localize("no such branch") })) });
    if (!preset && !(await this.host.ask.warning(localize("Check out {0} in {1} repositories?", name, act.length),
      missing.length ? localize("Not in {0}: those stay as they are.", missing.join(", ")) : localize("Each repository's working tree changes to that branch."), localize("Check Out")))) return undefined;
    const argsOf = (repo: Repo) => {
      const s = act.find((x) => x.repo.id === repo.id)!;
      const remote = s.data!.branches.find((b) => b.kind === "remote" && b.remoteBranch === name)?.remote;
      return s.step === "local" || !remote ? multiCommands.checkout(name) : multiCommands.track(name, remote);
    };
    // Refused for local changes: offered, once for all of them, as a Smart Checkout.
    const blocked = new Map<string, CheckoutBlock>();
    const result = await this.each(localize("Checking out {0}", name), act.map((s) => s.repo), async (repo) => {
      try {
        await this.git(repo, argsOf(repo));
      } catch (e) {
        const block = checkoutBlock(gitText(e));
        if (block) blocked.set(repo.id, block);
        throw e;
      }
    });
    if (blocked.size > 0) await this.smartAcross(name, act.map((s) => s.repo).filter((r) => blocked.has(r.id)), blocked, argsOf, result);
    result.unchanged.push(...steps.filter((s) => s.step === "current").map((s) => s.repo.name));
    result.skipped.push(...missing.map((n) => ({ name: n, reason: localize("no such branch") })));
    return this.report(localize("Check out {0}", name), "checkout", result);
  }

  private async create(preset?: Preset): Promise<MultiResult | undefined> {
    const all = await this.read(preset?.only);
    const name = preset?.name ?? (await this.host.ask.input(localize("New branch in {0} repositories, from each one's checked-out commit", all.length), localize("Branch name"),
      { validate: (v) => (isValidRef(v.trim()) ? undefined : localize("Enter a valid branch name.")) }))?.trim();
    if (!name || !isValidRef(name)) return undefined;
    const taken = all.filter((x) => x.data?.branches.some((b) => b.kind === "local" && b.name === name));
    const act = all.filter((x) => x.data && !taken.includes(x));
    const result = await this.each(localize("Creating {0}", name), act.map((x) => x.repo), (repo) => this.git(repo, multiCommands.create(name)));
    result.skipped.push(...taken.map((x) => ({ name: x.repo.name, reason: localize("the branch already exists") })));
    return this.report(localize("New branch {0}", name), "create", result);
  }

  private async merge(preset?: Preset): Promise<MultiResult | undefined> {
    const all = await this.read(preset?.only);
    const name = preset?.name ?? await this.pickShared(all, localize("Branch to merge into each repository's current branch"));
    if (!name) return undefined;
    const plans = all.map((x) => {
      if (!x.data?.current) return { ...x, ref: undefined, why: localize("no branch checked out") };
      if (x.data.current === name) return { ...x, ref: undefined, why: localize("it is the current branch") };
      if (x.data.branches.some((b) => b.kind === "local" && b.name === name)) return { ...x, ref: name, why: "" };
      const remotes = x.data.branches.filter((b) => b.kind === "remote" && b.remoteBranch === name);
      return remotes.length === 1 ? { ...x, ref: remotes[0].name, why: "" } : { ...x, ref: undefined, why: localize("no such branch") };
    });
    const act = plans.filter((p) => p.ref);
    if (!act.length) return this.report(localize("Merge {0}", name), "merge", { done: [], unchanged: [], stopped: [], skipped: plans.map((p) => ({ name: p.repo.name, reason: p.why })) });
    if (!preset && !(await this.host.ask.warning(localize("Merge {0} into the current branch of {1} repositories?", name, act.length),
      act.map((p) => `${p.repo.name}: ${p.ref} → ${p.data!.current}`).join("\n"), localize("Merge")))) return undefined;
    const result = await this.each(localize("Merging {0}", name), act.map((p) => p.repo), (repo) => this.git(repo, multiCommands.merge(act.find((p) => p.repo.id === repo.id)!.ref!)));
    result.skipped.push(...plans.filter((p) => !p.ref).map((p) => ({ name: p.repo.name, reason: p.why })));
    return this.report(localize("Merge {0}", name), "merge", result);
  }

  /**
   * ⇡ Push…: every ticked repository with commits to send, its target and its outgoing commits; push the
   * ones kept ticked. `only`: just these repositories (Commit and Push… offers the ones it committed in).
   * A branch that diverged from its remote branch (pushed commits rewritten) is force pushed with a
   * lease, after one confirmation; main, master and VS Code's git.branchProtection never are.
   */
  push(only?: ReadonlySet<string>): Promise<MultiResult | undefined> {
    return this.exclusive(async () => {
      const all = await this.read(only);
      const listed = (await runPool(all, WRITE_CONCURRENCY, async (x) => {
        const plan = x.data && pushPlan(x.data);
        if (!plan) return undefined;
        const commits = parseOutgoing(await this.host.run(x.repo.root, multiCommands.outgoing(!plan.setUpstream), WRITE_SIGNAL));
        const guarded = vscode.workspace.getConfiguration("git", vscode.Uri.file(x.repo.root)).get<string[]>("branchProtection", []);
        return commits.length ? { repo: x.repo, plan, commits, blocked: plan.lease !== undefined && isProtected(plan.destination, Array.isArray(guarded) ? guarded : []) } : undefined;
      }, WRITE_SIGNAL)).flatMap((s) => (s.status === "fulfilled" && s.value ? [s.value] : []));
      // Diverged on a protected branch: a push would be rejected and a force push is not offered.
      const blocked = listed.filter((r) => r.blocked).map((r) => ({ name: r.repo.name, reason: localize("{0} diverged from {1}/{2}: a protected branch is never force pushed; pull it first", r.plan.branch, r.plan.remote, r.plan.destination) }));
      // Ready to push first; diverged ones (ahead and behind) in a section of their own, not ticked: being
      // behind is usually someone else's push (Update Project brings it in). Ticked anyway, a diverged
      // branch is force pushed, after a confirmation naming what the remote loses.
      const rows = [...listed.filter((r) => !r.blocked && !r.plan.lease), ...listed.filter((r) => !r.blocked && r.plan.lease)];
      if (!rows.length) {
        if (blocked.length) return this.report(localize("Push"), "push", { done: [], unchanged: [], stopped: [], skipped: blocked });
        void vscode.window.showInformationMessage(localize("Linyra: nothing to push in the ticked repositories."));
        return { done: [], unchanged: all.map((x) => x.repo.name), stopped: [], skipped: [] };
      }
      const item = (r: (typeof rows)[number]): vscode.QuickPickItem => ({
        label: r.repo.name, picked: !r.plan.lease,
        description: `${r.plan.branch} → ${r.plan.remote}/${r.plan.destination}${r.plan.setUpstream ? ` (${localize("new")})` : ""} · ${localize(r.commits.length === 1 ? "1 commit" : "{0} commits", r.commits.length)}`
          + (r.plan.lease ? ` · ${localize("{0} on the remote you do not have", r.plan.behind ?? 0)}` : ""),
        detail: r.plan.lease ? localize("Tick to force push: the remote loses those commits (you are asked first). To keep them, run Update Project instead.")
          : r.commits.slice(0, 3).map((c) => `${c.sha} ${c.subject}`).join("  ·  ") + (r.commits.length > 3 ? "  …" : ""),
      });
      const ready = rows.filter((r) => !r.plan.lease), diverged = rows.filter((r) => r.plan.lease);
      const items: vscode.QuickPickItem[] = [...ready.map(item),
        ...(diverged.length > 0 ? [{ label: localize("Needs pull or force push"), kind: vscode.QuickPickItemKind.Separator }, ...diverged.map(item)] : [])];
      const rowOf = (i: number) => (i < ready.length ? ready[i] : diverged[i - ready.length - 1]);
      const chosen = await this.host.ask.pickMany(items, localize("Push to {0} repositories", rows.length));
      if (!chosen?.length) return undefined;
      const picked = chosen.map(rowOf).filter((r): r is (typeof rows)[number] => r !== undefined);
      if (picked.length === 0) return undefined;
      const forced = picked.filter((r) => r.plan.lease);
      if (forced.length > 0) {
        const p = forcePushPrompt(await Promise.all(forced.map((r) => this.forcePush(r.repo, r.plan.branch, r.plan.remote, r.plan.destination, r.plan.behind ?? 0))));
        if (!(await this.host.ask.warning(p.message, p.detail, p.button))) return undefined;
      }
      const result = await this.each(localize("Pushing"), picked.map((r) => r.repo), async (repo) => {
        const { plan } = picked.find((r) => r.repo.id === repo.id)!;
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), PUSH_TIMEOUT_MS);
        try {
          await this.host.run(repo.root, multiCommands.push(plan.remote, plan.branch, plan.destination, plan.setUpstream, plan.lease), ctl.signal, { tree: true, env: WRITE_ENV });
        } finally {
          clearTimeout(timer);
        }
      });
      result.skipped.push(...blocked);
      const sent = picked.filter((r) => result.done.includes(r.repo.name)).reduce((n, r) => n + r.commits.length, 0);
      return this.report(localize("Push"), "push", result, sent);
    });
  }

  /**
   * ⇣ Update Project: Fetch All, then merge, rebase or fast-forward every ticked repository that is
   * behind its upstream. The method: linyra.updateMethod, or asked (the last one first; its 📌 makes
   * it the setting, so the question stops).
   */
  update(): Promise<MultiResult | undefined> {
    return this.exclusive(async () => {
      const method = await this.updateMethod();
      if (!method) return undefined;
      await this.host.fetchAll();
      const repos = [...this.host.repos()];
      const distance = await runPool(repos, WRITE_CONCURRENCY, async (r) => parseAheadBehind(await this.host.run(r.root, aheadBehindArgs(), WRITE_SIGNAL)), WRITE_SIGNAL);
      const at = (r: Repo) => { const d = distance[repos.indexOf(r)]; return d.status === "fulfilled" ? d.value : null; };
      const behind = repos.filter((r) => (at(r)?.behind ?? 0) > 0);
      const noUpstream = repos.filter((r) => at(r) === null);
      // Fast-forward only: a diverged branch is not tried (git would refuse it); named, with what would do it.
      const diverged = method === "ffOnly" ? behind.filter((r) => (at(r)?.ahead ?? 0) > 0) : [];
      const result = await this.each(localize("Updating"), behind.filter((r) => !diverged.includes(r)), (repo) => this.git(repo, multiCommands.update(method)));
      result.unchanged.push(...repos.filter((r) => !behind.includes(r) && !noUpstream.includes(r)).map((r) => r.name));
      result.skipped.push(...diverged.map((r) => ({ name: r.name, reason: localize("it has diverged from its upstream: merge or rebase it") })));
      result.skipped.push(...noUpstream.map((r) => ({ name: r.name, reason: localize("no upstream branch") })));
      return this.report(localize("Update Project ({0})", localize(METHOD_NAMES[method])), "update", result);
    });
  }

  /** linyra.updateMethod, or the question: the methods, the last one first, each with a 📌 "don't ask again". */
  private async updateMethod(): Promise<UpdateMethod | undefined> {
    const config = vscode.workspace.getConfiguration("linyra");
    const set = updateMethodSetting(config.get("updateMethod"));
    if (set !== "ask") return set;
    const order = updateMethodOrder(this.host.state.get(LAST_METHOD));
    const describe: Record<UpdateMethod, { label: string; description: string }> = {
      merge: { label: localize("Merge incoming changes"), description: localize("a merge commit where the branches diverged") },
      rebase: { label: localize("Rebase onto incoming changes"), description: localize("local commits replayed on top; needs a clean working tree") },
      ffOnly: { label: localize("Fast-forward only"), description: localize("only branches with no local commits; diverged ones are left as they are") },
    };
    const pin = { iconPath: new vscode.ThemeIcon("pin"), tooltip: localize("Always use this method (don't ask again)") };
    const answer = await this.host.ask.pickWithButton(order.map((m) => describe[m]), localize("Update {0} repositories: how? (📌 = don't ask again)", this.host.repos().length), pin);
    if (!answer) return undefined;
    const method = order[answer.index];
    await this.host.state.update(LAST_METHOD, method);
    if (answer.button) {
      await config.update("updateMethod", method, vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage(localize("Linyra: Update Project now always uses {0}. Change it in Settings (linyra.updateMethod).", localize(METHOD_NAMES[method])));
    }
    return method;
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

  /**
   * ⋯ → Tag Across Repositories…: one tag name on the checked-out commit of every ticked repository
   * (annotated when given a message), then, if asked, pushed to each one's remote. A repository
   * that already has the tag keeps its own and is named.
   */
  tags(preset?: { name: string; message?: string; push: boolean; only?: ReadonlySet<string> }): Promise<MultiResult | undefined> {
    return this.exclusive(async () => {
      const read = await this.read(preset?.only);
      const answer = preset ?? await this.tagForm(read);
      if (!answer || !isValidRef(answer.name)) return undefined;
      const { name, message = "", push } = answer;
      if (!preset) await this.host.state.update(PUSH_TAGS, push);
      const all = read.filter((x) => !answer.only || answer.only.has(x.repo.id));
      const taken = all.filter((x) => x.data?.branches.some((b) => b.kind === "tag" && b.name === name));
      const act = all.filter((x) => x.data && !taken.includes(x));
      if (!act.length) return this.report(localize("Tag {0}", name), "tag", { done: [], unchanged: [], stopped: [], skipped: taken.map((x) => ({ name: x.repo.name, reason: localize("the tag already exists") })) });
      const noRemote: string[] = [];
      const result = await this.each(localize("Tagging {0}", name), act.map((x) => x.repo), async (repo) => {
        const data = act.find((x) => x.repo.id === repo.id)!.data!;
        await this.git(repo, multiCommands.tag(name, message));
        if (!push) return;
        const remote = tagRemote(data);
        if (!remote) { noRemote.push(repo.name); return; }
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), PUSH_TIMEOUT_MS);
        try {
          await this.host.run(repo.root, multiCommands.pushTag(remote, name), ctl.signal, { tree: true, env: WRITE_ENV });
        } catch (e) {
          throw new Error(localize("tagged, but not pushed: {0}", gitMessage(e)));
        } finally {
          clearTimeout(timer);
        }
      });
      result.skipped.push(...taken.map((x) => ({ name: x.repo.name, reason: localize("the tag already exists") })));
      result.skipped.push(...noRemote.map((n) => ({ name: n, reason: localize("tagged, but it has no remote to push to") })));
      result.done = result.done.filter((n) => !noRemote.includes(n));
      return this.report(localize("Tag {0}", name), "tag", result);
    });
  }

  /** Tag Across Repositories' form: the name, an optional message, push or not (remembered), and where. */
  private async tagForm(all: { repo: Repo; data: Branches | undefined }[]): Promise<{ name: string; message: string; push: boolean; only: ReadonlySet<string> } | undefined> {
    const tagged = (name: string) => all.filter((x) => x.data?.branches.some((b) => b.kind === "tag" && b.name === name));
    const values = await this.host.ask.form({
      id: "tagAcross",
      title: localize("Tag Across Repositories"),
      intro: localize("One tag on the checked-out commit of each repository you keep ticked."),
      fields: [
        { kind: "text", id: "name", label: localize("Tag name"), placeholder: localize("for example v1.4.0"), rule: "ref" },
        { kind: "text", id: "message", label: localize("Message (optional)"), multiline: true, placeholder: localize("Release notes, or nothing"),
          hint: localize("With a message, git records who made the tag and when.") },
        { kind: "check", id: "push", label: localize("Push the tag to each repository's remote"), value: this.host.state.get<boolean>(PUSH_TAGS, true) },
        { kind: "list", id: "repos", label: localize("Repositories"), required: localize("Tick at least one repository."),
          items: all.map((x) => ({ id: x.repo.id, label: x.repo.name, value: true,
            description: x.data ? x.data.current ?? localize("HEAD detached") : undefined, disabled: x.data ? undefined : localize("its branches could not be read") })) },
      ],
      submit: localize("Create Tag"), cancel: localize("Cancel"),
    }, async (v): Promise<Record<string, string>> => {
      const ids = new Set(listValue(v, "repos"));
      const name = textValue(v, "name");
      const have = tagged(name).filter((x) => ids.has(x.repo.id));
      return have.length > 0 && have.length === ids.size ? { name: localize("Every ticked repository already has {0}.", name) } : {};
    });
    if (!values) return undefined;
    return { name: textValue(values, "name"), message: textValue(values, "message"), push: checkValue(values, "push"), only: new Set(listValue(values, "repos")) };
  }

  /** What a force push of `branch` drops from `remote/destination`, and whose those commits are. */
  async forcePush(repo: Repo, branch: string, remote: string, destination: string, behind: number): Promise<ForcePush> {
    const [log, me] = await Promise.all([
      this.host.run(repo.root, droppedArgs(branch, `${remote}/${destination}`), WRITE_SIGNAL).catch(() => ""),
      this.host.run(repo.root, ["config", "user.email"], WRITE_SIGNAL).catch(() => ""),
    ]);
    return { repo: repo.name, branch, target: `${remote}/${destination}`, behind, dropped: parseDropped(log), me: me.trim() };
  }

  /** Smart Checkout in the repositories a checkout was refused in: asked once; the result moves them to done. */
  private async smartAcross(name: string, repos: readonly Repo[], blocked: ReadonlyMap<string, CheckoutBlock>, argsOf: (repo: Repo) => string[], result: MultiResult): Promise<void> {
    const p = smartPrompt(repos.map((r) => r.name), name);
    if (!(await this.host.ask.warning(p.message, p.detail, p.button))) return;
    const notes: string[] = [];
    const smart = await this.each(localize("Smart Checkout of {0}", name), repos, async (repo) => {
      const r = await smartCheckout((args) => this.git(repo, args), blocked.get(repo.id)!, smartLabel(name), () => this.git(repo, argsOf(repo)));
      const note = smartReport(repo.name, name, r);
      if (note) notes.push(note);
    });
    result.skipped = result.skipped.filter((s) => !smart.done.includes(s.name));
    result.done.push(...smart.done);
    for (const note of notes) void vscode.window.showWarningMessage(note);
  }

  private git(repo: Repo, args: string[]): Promise<string> {
    return this.host.run(repo.root, args, WRITE_SIGNAL, { env: WRITE_ENV });
  }

  /**
   * Compare's Merge ◀ into ▶…: each plan's merge, with the same progress, refresh and report as
   * Branches Across Repositories; `skipped` joins the report. `quiet`: no report (the caller makes one).
   */
  mergeEach(title: string, plans: readonly { repo: Repo; merge: () => Promise<unknown> }[], skipped: readonly { name: string; reason: string }[], opts: { quiet?: boolean } = {}): Promise<MultiResult | undefined> {
    return this.exclusive(async () => {
      const result = await this.each(title, plans.map((p) => p.repo), (repo) => plans.find((p) => p.repo.id === repo.id)!.merge());
      result.skipped.push(...skipped);
      // Release… reports the merge with its tag and push, once.
      return opts.quiet ? result : this.report(title, "merge", result);
    });
  }

  /** `git merge` of a ref into the repository's checked-out branch (no editor, no autostash). */
  mergeRef(repo: Repo, ref: string): Promise<string> {
    return this.git(repo, multiCommands.merge(ref));
  }

  /** Each ticked repository's branches and remotes (undefined when they could not be read). */
  private async read(only?: ReadonlySet<string>): Promise<{ repo: Repo; data: Branches | undefined }[]> {
    const repos = this.host.repos().filter((r) => !only || only.has(r.id));
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
    const result: MultiResult = { done: [], unchanged: [], stopped: [], skipped: [] };
    settled.forEach((s, i) => {
      if (s.status === "fulfilled") { result.done.push(repos[i].name); return; }
      const message = gitText(s.reason);
      // Stopped half-way: the repository is mid-merge or mid-rebase, not as it was.
      if (stoppedOnConflicts(message)) result.stopped.push({ name: repos[i].name, reason: localize(updateReason(message)) });
      else result.skipped.push({ name: repos[i].name, reason: localize(updateReason(message)), failed: true });
    });
    if (repos.length) await this.host.changed(repos.map((r) => r.id));
    return result;
  }

  /** One notification, in groups (multiReport); stopped on conflicts: a button to Source Control. */
  private report(what: string, kind: ReportKind, r: MultiResult, commits?: number): MultiResult {
    const { level, text } = multiReport(what, kind, r, commits);
    if (level === "info") void vscode.window.showInformationMessage(text);
    else {
      const open = localize("Open Source Control");
      void vscode.window.showWarningMessage(text, ...(r.stopped.length > 0 ? [open] : [])).then((pick) => {
        if (pick === open) void vscode.commands.executeCommand("workbench.view.scm");
      });
    }
    return r;
  }
}

import { showArgs } from "./commitDetail";
import { countArgs, detailOf, parseCounts, pickMergeTarget, remoteHeadArgs, shortRemoteRef, showsMergeTarget, type MergeTarget } from "./hoverModel";
import type { RunGit } from "./logQuery";
import { isAbortError } from "./pool";
import type { HostMessage } from "./protocol";
import type { Commit, Repo } from "./types";
import type { MessageRoutes } from "./messageRoutes";

/** Explain Commit, registered by Linyra's AI features when they are there: the card links to it only then. */
export const EXPLAIN_COMMAND = "linyra.ai.explainCommit";

export type HoverAction = "copySha" | "openOnRemote" | "compare" | "explain";
const ACTIONS: readonly HoverAction[] = ["copySha", "openOnRemote", "compare", "explain"];

export interface HoverHost {
  run: RunGit;
  /** The listed commit with these (untrusted) ids, with its repository. */
  commit(repoId: unknown, sha: unknown): { repo: Repo; commit: Commit } | undefined;
  post(m: Extract<HostMessage, { type: "hoverDetail" }>): void;
  /** vscode.commands (a seam: the unit test has no VS Code). */
  commands: { getCommands(filterInternal?: boolean): PromiseLike<string[]>; executeCommand(command: string, ...rest: unknown[]): PromiseLike<unknown> };
  /** linyra.ai.enabled: the card offers Explain only while AI is on, as the menus do. */
  aiEnabled?: () => boolean;
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The Log's commit hover card, host side. The card draws what the row has at once; once it is
 * shown (the pointer rested on a row), one `git show` adds the message and the counts. Nothing is
 * kept between hovers (CLAUDE.md constraint 1), and the process is killed when the card closes.
 * The HEAD row also shows its merge target: two reads, kept in memory until HEAD or a ref moves.
 */
export class HoverDetails {
  private ctl: AbortController | undefined;
  /** Each repository's merge target, for the HEAD commit it was read at (null: it has none). */
  private readonly targets = new Map<string, { sha: string; target: MergeTarget | null }>();
  /** Whether linyra.ai.explainCommit is registered, once it is. */
  private explainKnown: Promise<boolean> | undefined;
  /** Compare Branches with both sides filled in (extension.ts sets it: Compare is made after the Log). */
  compare: ((repoId: string, left: string, right: string) => Promise<void>) | undefined;

  constructor(private readonly host: HoverHost) {}

  register(routes: MessageRoutes): void {
    routes.on("hover", (m) => this.show(m.repoId, m.sha)).on("hoverEnd", () => this.end()).on("hoverAction", (m) => this.action(m.action, m.repoId, m.sha));
  }

  async show(repoId: unknown, sha: unknown): Promise<void> {
    this.end();
    const found = this.host.commit(repoId, sha);
    if (!found) return;
    const ctl = (this.ctl = new AbortController());
    const { repo, commit } = found;
    const key = { repoId: repo.id, sha: commit.sha };
    const branch = commit.refs?.some((r) => r.kind === "head") ? commit.refs.find((r) => r.kind === "local" && r.current)?.name : undefined;
    // Beside the git show, not after it; a failed or killed read just shows no target.
    const target = branch ? this.mergeTarget(repo, commit.sha, branch, ctl.signal).catch(() => null) : Promise.resolve(null);
    const explain = this.hasExplain();
    try {
      const detail = detailOf(await this.host.run(repo.root, showArgs(commit.sha), ctl.signal));
      if (ctl.signal.aborted) return;
      this.host.post({ type: "hoverDetail", ...key, detail, explain: await explain });
    } catch (e) {
      if (ctl.signal.aborted || isAbortError(e)) return;
      this.host.post({ type: "hoverDetail", ...key, error: messageOf(e), explain: await explain });
    }
    const t = await target;
    if (t && !ctl.signal.aborted && showsMergeTarget(t)) this.host.post({ type: "hoverDetail", ...key, target: t });
  }

  /** The card closed (the pointer left, a scroll, a key): its read is killed, not awaited. */
  end(): void {
    this.ctl?.abort();
    this.ctl = undefined;
  }

  /** HEAD or a branch moved in a repository (undefined: in any): its merge target is read again next time. */
  refsChanged(repoId?: string): void {
    if (repoId) this.targets.delete(repoId);
    else this.targets.clear();
  }

  private hasExplain(): Promise<boolean> {
    if (this.host.aiEnabled && !this.host.aiEnabled()) return Promise.resolve(false);
    // Every command VS Code knows, thousands: asked until Explain is there, then once is enough
    // (a registered command stays for the session).
    this.explainKnown ??= Promise.resolve(this.host.commands.getCommands(true)).then((all) => all.includes(EXPLAIN_COMMAND), () => false)
      .then((found) => { if (!found) this.explainKnown = undefined; return found; });
    return this.explainKnown;
  }

  private async mergeTarget(repo: Repo, sha: string, branch: string, signal: AbortSignal): Promise<MergeTarget | null> {
    const known = this.targets.get(repo.id);
    if (known?.sha === sha) return known.target;
    const ref = pickMergeTarget(await this.host.run(repo.root, remoteHeadArgs(branch), signal), branch);
    const counts = ref ? parseCounts(await this.host.run(repo.root, countArgs(sha, ref), signal)) : undefined;
    const target = ref && counts ? { name: shortRemoteRef(ref), branch, ...counts } : null;
    if (!signal.aborted) this.targets.set(repo.id, { sha, target });
    return target;
  }

  /** A link in the card's footer, on the commit it shows. */
  async action(action: unknown, repoId: unknown, sha: unknown): Promise<void> {
    const found = this.host.commit(repoId, sha);
    if (!found || !ACTIONS.includes(action as HoverAction)) return;
    const arg = { repoId: found.repo.id, sha: found.commit.sha };
    const { commands } = this.host;
    switch (action as HoverAction) {
      case "copySha": await commands.executeCommand("linyra.commitCopySha", arg); return;
      case "openOnRemote": await commands.executeCommand("linyra.commitOpenOnRemote", arg); return;
      case "explain": if (await this.hasExplain()) await commands.executeCommand(EXPLAIN_COMMAND, arg); return;
      case "compare": {
        const known = this.targets.get(found.repo.id);
        if (known?.sha === found.commit.sha && known.target) await this.compare?.(found.repo.id, known.target.name, known.target.branch);
        return;
      }
    }
  }
}

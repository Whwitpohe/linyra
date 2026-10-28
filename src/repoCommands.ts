import { localize } from "./i18n";
import * as vscode from "vscode";
import { copyText } from "./clipboard";
import type { RunGit } from "./logQuery";
import { commitWebUrl } from "./remoteUrl";
import { addExclusion, undoExclusion } from "./repos";
import type { Repo } from "./types";

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** What the repository and commit row commands need from the Log. */
export interface RepoCommandHost {
  repos(): readonly Repo[];
  /** The Repo List's ticked repositories; null for all. */
  repoIds(): string[] | null;
  contextRepo(arg: unknown): Repo | undefined;
  contextCommit(arg: unknown): { repo: Repo; sha: string } | undefined;
  setRepoFilter(repoIds: string[] | null): Promise<void>;
  /** The repository leaves the ticked set (it is being excluded). */
  untick(repoId: string): void;
  /** Of these repositories, those with commits to pull. */
  behind(repoIds: readonly string[]): string[];
  run: RunGit;
}

/** The Log's right-click commands that read or filter, never write: repository rows and commit rows. */
export class RepoCommands implements vscode.Disposable {
  /** Reads started by a right-click: stopped when Linyra is. */
  private readonly background = new AbortController();

  constructor(private readonly host: RepoCommandHost) {}

  /** Show Only Repositories Behind: tick the repositories with commits to pull (as of the last fetch). */
  async showBehind(): Promise<void> {
    const ids = this.host.behind(this.host.repos().map((r) => r.id));
    if (ids.length === 0) {
      void vscode.window.showInformationMessage(localize("Linyra: no repository is behind its upstream (as of the last fetch)."));
      return;
    }
    await this.host.setRepoFilter(ids);
  }

  /** Right-click a commit → Copy Commit ID. */
  async copySha(arg: unknown): Promise<void> {
    const c = this.host.contextCommit(arg);
    if (c) await copyText(c.sha);
  }

  /** Right-click a commit → Copy Message: the whole message (the row shows only the subject). */
  async copyMessage(arg: unknown): Promise<void> {
    const c = this.host.contextCommit(arg);
    if (!c) return;
    try {
      const message = await this.host.run(c.repo.root, ["show", "-s", "--format=%B", c.sha, "--"], this.background.signal);
      await copyText(message.trim());
    } catch (e) {
      void vscode.window.showErrorMessage(localize("Linyra could not read the commit message: {0}", messageOf(e)));
    }
  }

  /**
   * Right-click a commit → Open on Remote: its page on GitHub, GitLab, Bitbucket, Azure DevOps…,
   * from the repository's origin (or its first remote). Returns the URL opened.
   */
  async openOnRemote(arg: unknown): Promise<string | undefined> {
    const c = this.host.contextCommit(arg);
    if (!c) return undefined;
    const signal = new AbortController().signal;
    const urlOf = (name: string) => this.host.run(c.repo.root, ["remote", "get-url", "--", name], signal).then((s) => s.trim(), () => "");
    let remote = await urlOf("origin");
    if (!remote) {
      // No origin: the first remote git lists (alphabetical).
      const names = await this.host.run(c.repo.root, ["remote"], signal).then((s) => s.split("\n").map((x) => x.trim()).filter(Boolean), () => []);
      if (names[0]) remote = await urlOf(names[0]);
    }
    const url = remote ? commitWebUrl(remote, c.sha) : null;
    if (!url) {
      void vscode.window.showInformationMessage(localize("Linyra: {0} has no remote with a web page for this commit.", c.repo.name));
      return undefined;
    }
    // The integration suite checks the URL without launching a browser.
    if (process.env.LINYRA_ITEST !== "1") await vscode.env.openExternal(vscode.Uri.parse(url, true));
    return url;
  }

  /** Right-click → Show Only: this repository's commits alone. */
  async showOnly(arg: unknown): Promise<void> {
    const repo = this.host.contextRepo(arg);
    if (repo) await this.host.setRepoFilter([repo.id]);
  }

  /** Right-click → Hide from the Log: untick this repository (the others stay as they are). */
  async hide(arg: unknown): Promise<void> {
    const repo = this.host.contextRepo(arg);
    if (!repo) return;
    const shown = this.host.repoIds() ?? this.host.repos().map((r) => r.id);
    await this.host.setRepoFilter(shown.filter((id) => id !== repo.id));
  }

  /** Right-click → Show All Repositories. */
  async showAll(): Promise<void> {
    if (this.host.repoIds() !== null) await this.host.setRepoFilter(null);
  }

  async copyPath(arg: unknown): Promise<void> {
    const repo = this.host.contextRepo(arg);
    if (repo) await copyText(repo.root);
  }

  async openFolder(arg: unknown): Promise<void> {
    const repo = this.host.contextRepo(arg);
    if (repo) await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(repo.root), { forceNewWindow: true });
  }

  /**
   * Right-click → Exclude from Linyra: adds the repository's exact path to linyra.excludeRepos
   * (so a repo elsewhere with the same name stays), with an Undo. It goes where the setting
   * already applies from: settings arrays do not merge across scopes, so writing to another
   * would drop the user's own entries. With none yet, the user settings: an absolute path
   * belongs to this machine, not in a workspace file that may sit inside a repository.
   */
  async exclude(arg: unknown): Promise<void> {
    const repo = this.host.contextRepo(arg);
    if (!repo) return;
    const inspected = vscode.workspace.getConfiguration("linyra").inspect<string[]>("excludeRepos");
    const target = inspected?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    const previous = target === vscode.ConfigurationTarget.Workspace ? inspected?.workspaceValue : inspected?.globalValue;
    const pattern = repo.root.replace(/\\/g, "/");
    const next = addExclusion(previous, pattern);
    if (!next) return;
    this.host.untick(repo.id);
    // The configuration listener lists the repositories again (reposSettingChanged).
    await vscode.workspace.getConfiguration("linyra").update("excludeRepos", next, target);
    void vscode.window.showInformationMessage(localize("Linyra: {0} is excluded (linyra.excludeRepos).", repo.name), localize("Undo")).then(async (pick) => {
      if (pick !== localize("Undo")) return;
      const now = vscode.workspace.getConfiguration("linyra").inspect<string[]>("excludeRepos");
      const current = (target === vscode.ConfigurationTarget.Workspace ? now?.workspaceValue : now?.globalValue) ?? [];
      await vscode.workspace.getConfiguration("linyra").update("excludeRepos", undoExclusion(current, pattern, previous), target);
    });
  }

  dispose(): void {
    this.background.abort();
  }
}

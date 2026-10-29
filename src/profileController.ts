import { localize } from "./i18n";
import * as vscode from "vscode";
import { activeProfiles, deleteProfile, nameProblem, profileFilter, profileNames, readProfiles, renameProfile, repoKey, resolveProfiles, saveProfile, setMembership, type Profiles, type ResolvedProfile } from "./profileModel";
import type { Repo } from "./types";
import type { Ask } from "./uncommittedActions";
import type { MessageRoutes } from "./messageRoutes";

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** What profiles need from the Log. */
export interface ProfileHost {
  repos(): readonly Repo[];
  /** The Repo List's ticked repositories; null for all. */
  repoIds(): string[] | null;
  /** The repository a right-click was on. */
  contextRepo(arg: unknown): Repo | undefined;
  setRepoFilter(repoIds: string[] | null): Promise<void>;
  /** linyra.profiles was written: redraw the Repo List. */
  changed(): void;
  ask: Ask;
}

/** Named sets of repositories (linyra.profiles): the Repo List's profile rows and their commands. */
export class ProfileController {
  constructor(private readonly host: ProfileHost) {}

  /** linyra.profiles as written (lenient: malformed entries are skipped). */
  private raw(): Profiles {
    return readProfiles(vscode.workspace.getConfiguration("linyra").get("profiles"));
  }

  /** How each repository is named in linyra.profiles. */
  private keys(): { id: string; key: string }[] {
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => ({ name: f.name, path: f.uri.fsPath }));
    return this.host.repos().map((r) => ({ id: r.id, key: repoKey(r.root, folders, process.platform === "win32") }));
  }

  resolved(): ResolvedProfile[] {
    return resolveProfiles(this.raw(), this.keys());
  }

  /** The profile a right-click was on. */
  private contextProfile(arg: unknown): ResolvedProfile | undefined {
    const name = (arg as { profile?: unknown } | undefined)?.profile;
    return typeof name === "string" ? this.resolved().find((p) => p.name === name) : undefined;
  }

  /** Right-click a profile → Show This Profile (the same as clicking it). */
  async show(arg: unknown): Promise<void> {
    const p = this.contextProfile(arg);
    if (p) await this.host.setRepoFilter(profileFilter(p, this.host.repos().map((r) => r.id)));
  }

  /** ⋯ → Switch Profile…: All repositories, then each profile; works with the Repo List hidden. */
  async switch(): Promise<void> {
    const repos = this.host.repos();
    const all = repos.map((r) => r.id);
    const resolved = this.resolved();
    const repoIds = this.host.repoIds();
    const active = activeProfiles(resolved, repoIds, all);
    const nameOf = new Map(repos.map((r) => [r.id, r.name]));
    const items: vscode.QuickPickItem[] = [
      { label: localize("All repositories"), description: localize("{0} repositories", all.length), detail: repoIds === null ? localize("Current") : undefined },
      ...resolved.map((p) => ({ label: p.name, description: p.ids.map((id) => nameOf.get(id)).join(", ") || localize("no repository found"), detail: active.includes(p.name) ? localize("Current") : undefined })),
    ];
    const i = await this.host.ask.pick(items, resolved.length > 0 ? localize("Switch profile") : localize("No profiles yet: tick some repositories, then Save Selection as Profile…"));
    if (i === undefined) return;
    await this.host.setRepoFilter(i === 0 ? null : profileFilter(resolved[i - 1], all));
  }

  /** The workspace's own linyra.profiles (the listed ones also merge in the User settings' ones). */
  private own(): Profiles {
    return readProfiles(vscode.workspace.getConfiguration("linyra").inspect("profiles")?.workspaceValue);
  }

  /**
   * An edit of the listed profiles, written to the workspace: its own profiles plus the ones this
   * edit changed, never a User-level profile it did not touch (the workspace file may be shared).
   * Nothing changed: nothing written (no settings.json created for a no-op).
   */
  private async writeChanges(before: Profiles, after: Profiles): Promise<void> {
    const own = this.own();
    const out: Profiles = {};
    for (const [name, keys] of Object.entries(after)) {
      if (name in own || JSON.stringify(keys) !== JSON.stringify(before[name])) out[name] = keys;
    }
    if (JSON.stringify(out) !== JSON.stringify(own)) await this.write(out);
  }

  /** A profile from the User settings cannot be renamed or deleted from a workspace: say where it is. */
  private userLevel(name: string): boolean {
    if (name in this.own()) return false;
    void vscode.window.showInformationMessage(localize("Linyra: \"{0}\" is in your User settings; change it there.", name));
    return true;
  }

  /** Writes linyra.profiles to the workspace settings; false (with an error shown) if it could not. */
  private async write(next: Profiles): Promise<boolean> {
    if (!vscode.workspace.workspaceFolders?.length) {
      void vscode.window.showErrorMessage(localize("Linyra: profiles are saved in the workspace settings; open a folder first."));
      return false;
    }
    try {
      await vscode.workspace.getConfiguration("linyra").update("profiles", next, vscode.ConfigurationTarget.Workspace);
    } catch (e) {
      void vscode.window.showErrorMessage(localize("Linyra could not save the profile: {0}", messageOf(e)));
      return false;
    }
    this.host.changed();
    return true;
  }

  /** The ticked repositories as profile entries. */
  private tickedKeys(): string[] {
    const keyOf = new Map(this.keys().map((k) => [k.id, k.key]));
    return (this.host.repoIds() ?? this.host.repos().map((r) => r.id)).flatMap((id) => keyOf.get(id) ?? []);
  }

  /** ＋ Save as profile…, the Repo List's right-click, ⋯: the ticked repositories under a name. */
  register(routes: MessageRoutes): void {
    routes.on("profileSave", () => this.save());
  }

  async save(): Promise<void> {
    const keys = this.tickedKeys();
    if (keys.length === 0) return;
    const current = this.raw();
    const n = keys.length === 1 ? localize("1 repository") : localize("{0} repositories", keys.length);
    const name = await this.host.ask.input(localize("Name for a profile of {0}", n), "backend", {
      validate: (v) => {
        if (!v.trim()) return undefined;
        const taken = Object.keys(current).find((k) => k.toLowerCase() === v.trim().toLowerCase());
        return taken === undefined ? undefined : { message: localize("\"{0}\" exists: Enter replaces it with these {1}.", taken, n), severity: vscode.InputBoxValidationSeverity.Warning };
      },
    });
    if (!name?.trim()) return;
    // Replacing keeps the existing spelling of the name.
    const taken = Object.keys(current).find((k) => k.toLowerCase() === name.trim().toLowerCase());
    await this.writeChanges(current, saveProfile(current, taken ?? name, keys));
  }

  /** Right-click a profile → Update to Current Selection. */
  async update(arg: unknown): Promise<void> {
    const p = this.contextProfile(arg);
    const keys = this.tickedKeys();
    if (!p || keys.length === 0) return;
    const current = this.raw();
    await this.writeChanges(current, saveProfile(current, p.name, keys));
  }

  /** Right-click a profile → Rename…: refuses a name that is taken (in any case). */
  async rename(arg: unknown): Promise<void> {
    const p = this.contextProfile(arg);
    if (!p || this.userLevel(p.name)) return;
    const current = this.raw();
    const name = await this.host.ask.input(localize("New name for profile \"{0}\"", p.name), p.name, { value: p.name, validate: (v) => nameProblem(current, v, p.name) });
    if (name === undefined || nameProblem(current, name, p.name) !== undefined || name.trim() === p.name) return;
    await this.writeChanges(current, renameProfile(current, p.name, name));
  }

  /** Right-click a profile → Delete: asks; the repositories stay as they are. */
  async delete(arg: unknown): Promise<void> {
    const p = this.contextProfile(arg);
    if (!p || this.userLevel(p.name)) return;
    if (!(await this.host.ask.warning(localize("Delete profile \"{0}\"?", p.name), localize("Its repositories stay as they are; only the name goes."), localize("Delete")))) return;
    const current = this.raw();
    await this.writeChanges(current, deleteProfile(current, p.name));
  }

  /** Right-click a repository → Profiles…: tick the profiles it belongs to, or start a new one with it. */
  async forRepo(arg: unknown): Promise<void> {
    const repo = this.host.contextRepo(arg);
    if (!repo) return;
    const key = this.keys().find((k) => k.id === repo.id)?.key;
    if (!key) return;
    const current = this.raw();
    const names = profileNames(current);
    const items: vscode.QuickPickItem[] = [
      ...names.map((n) => ({ label: n, description: current[n].length === 1 ? localize("1 repository") : localize("{0} repositories", current[n].length), picked: current[n].includes(key) })),
      { label: localize("New profile with {0}…", repo.name), picked: false },
    ];
    const chosen = await this.host.ask.pickMany(items, localize("Profiles with {0}", repo.name));
    if (chosen === undefined) return;
    let next = setMembership(current, key, chosen.filter((i) => i < names.length).map((i) => names[i]));
    if (chosen.includes(names.length)) {
      const name = await this.host.ask.input(localize("Name for a new profile with {0}", repo.name), "backend", { validate: (v) => (v.trim() ? nameProblem(next, v) : undefined) });
      if (name !== undefined && nameProblem(next, name) === undefined) next = saveProfile(next, name, [key]);
    }
    await this.writeChanges(current, next);
  }
}

// Where AI configuration lives: linyra.ai.* settings (User settings only: they are
// application-scoped, so a workspace cannot point a saved key at another address) and the API
// keys in VS Code's SecretStorage, each bound to the origin it was entered for.
import * as vscode from "vscode";
import { localize } from "../i18n";
import { activeProfile, DEFAULT_EXCLUDE, originOf, parseProfiles, parseSavedKey, secretName } from "./profileModel";
import { AiError, type AiProfile } from "./types";

export interface AiSettings {
  enabled: boolean;
  profiles: AiProfile[];
  activeId: string | undefined;
  /** The profile in use (the active id, or the only profile). */
  active: AiProfile | undefined;
  exclude: string[];
  maxPromptTokens: number;
}

const section = () => vscode.workspace.getConfiguration("linyra.ai");

export function readAiSettings(): AiSettings {
  const c = section();
  const profiles = parseProfiles(c.get("profiles"));
  const activeId = c.get<string>("activeProfile") || undefined;
  const exclude = c.get<unknown>("exclude", DEFAULT_EXCLUDE);
  const max = c.get<unknown>("maxPromptTokens", 50_000);
  return {
    enabled: c.get<boolean>("enabled", false) === true,
    profiles,
    activeId,
    active: activeProfile(profiles, activeId),
    exclude: Array.isArray(exclude) ? exclude.filter((g): g is string => typeof g === "string") : [...DEFAULT_EXCLUDE],
    maxPromptTokens: typeof max === "number" && Number.isFinite(max) ? max : 50_000,
  };
}

/** Writes the profile list (never a key) and the active id; `enable` also sets linyra.ai.enabled. */
export async function writeAiSettings(profiles: readonly AiProfile[], activeId: string | undefined, enable?: boolean): Promise<void> {
  const c = section();
  const target = vscode.ConfigurationTarget.Global;
  await c.update("profiles", profiles.map(({ id, label, protocol, baseUrl, model, effort }) => ({ id, label, protocol, baseUrl, model, effort })), target);
  await c.update("activeProfile", activeId, target);
  if (enable !== undefined) await c.update("enabled", enable, target);
}

export class AiKeys {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async saved(profileId: string): Promise<{ key: string; origin: string } | undefined> {
    return parseSavedKey(await this.secrets.get(secretName(profileId)));
  }

  /** The key to send to this profile's address; undefined when it has none. Throws when the key was entered for another address. */
  async keyFor(profile: AiProfile): Promise<string | undefined> {
    const saved = await this.saved(profile.id);
    if (!saved) return undefined;
    if (saved.origin !== originOf(profile.baseUrl)) {
      throw new AiError(localize("The saved API key was entered for {0}, not {1}. Run Linyra: Configure AI… to enter a key for this address.", saved.origin, originOf(profile.baseUrl)), "auth");
    }
    return saved.key;
  }

  async set(profileId: string, key: string | undefined, baseUrl: string): Promise<void> {
    if (key) await this.secrets.store(secretName(profileId), JSON.stringify({ key, origin: originOf(baseUrl) }));
    else await this.secrets.delete(secretName(profileId));
  }

  async delete(profileId: string): Promise<void> {
    await this.secrets.delete(secretName(profileId));
  }
}

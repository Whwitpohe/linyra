export interface Settings {
  pageSize: number;
  maxConcurrency: number;
  scanDepth: number;
  excludeRepos: string[];
}

export const DEFAULT_SETTINGS: Settings = { pageSize: 200, maxConcurrency: 16, scanDepth: 2, excludeRepos: [] };

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;
}

/** `get` reads one key of the `linyra` configuration section. */
export function readSettings(get: (key: string) => unknown): Settings {
  const exclude = get("excludeRepos");
  return {
    pageSize: clampInt(get("pageSize"), 1, 1000, DEFAULT_SETTINGS.pageSize),
    maxConcurrency: clampInt(get("maxConcurrency"), 1, 64, DEFAULT_SETTINGS.maxConcurrency),
    scanDepth: clampInt(get("scanDepth"), 0, 6, DEFAULT_SETTINGS.scanDepth),
    excludeRepos: Array.isArray(exclude) ? exclude.filter((x): x is string => typeof x === "string") : [],
  };
}

/** linyra.avatars: who may be asked for an author's picture. */
export type AvatarMode = "off" | "remote" | "remote+gravatar";
/** linyra.avatarHosts: what a self-hosted remote is. */
export type AvatarHostKind = "gitlab" | "github";

export interface AvatarSettings {
  mode: AvatarMode;
  /** "host" or "host:port", lowercased → its kind. */
  hosts: Readonly<Record<string, AvatarHostKind>>;
  /** The user's own avatar service; "" when unset or unusable. */
  urlTemplate: string;
}

export const DEFAULT_AVATAR_SETTINGS: AvatarSettings = { mode: "remote", hosts: {}, urlTemplate: "" };

/** Narrowest first: a later mode asks every server an earlier one does, and more. */
const AVATAR_MODES: readonly AvatarMode[] = ["off", "remote", "remote+gravatar"];
const isAvatarMode = (v: unknown): v is AvatarMode => typeof v === "string" && (AVATAR_MODES as readonly string[]).includes(v);

/**
 * The user's choice, narrowed by the workspace's: a repository's .vscode/settings.json can turn
 * avatars off, never send its authors' addresses to more servers than the user chose.
 */
export function avatarMode(user: unknown, workspace: readonly unknown[] = []): AvatarMode {
  let mode = isAvatarMode(user) ? user : DEFAULT_AVATAR_SETTINGS.mode;
  for (const w of workspace) if (isAvatarMode(w) && AVATAR_MODES.indexOf(w) < AVATAR_MODES.indexOf(mode)) mode = w;
  return mode;
}

const HOST_KEY = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/;

export function avatarHosts(value: unknown): Record<string, AvatarHostKind> {
  const hosts: Record<string, AvatarHostKind> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return hosts;
  for (const [key, kind] of Object.entries(value)) {
    // "https://git.acme.test/" is written often enough: its host is what was meant.
    const host = key.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
    if (HOST_KEY.test(host) && (kind === "gitlab" || kind === "github")) hosts[host] = kind;
  }
  return hosts;
}

/** An http(s) template that names the author ({md5}, {sha256} or {email}); anything else is "". */
export function avatarUrlTemplate(value: unknown): string {
  if (typeof value !== "string") return "";
  const t = value.trim();
  return t.length <= 2048 && /^https?:\/\/\S+$/i.test(t) && /\{(?:md5|sha256|email)\}/.test(t) ? t : "";
}

/** `get` reads one key of the `linyra` section; `workspaceModes`: linyra.avatars as the workspace and its folders set it. */
export function readAvatarSettings(get: (key: string) => unknown, workspaceModes: readonly unknown[] = []): AvatarSettings {
  return { mode: avatarMode(get("avatars"), workspaceModes), hosts: avatarHosts(get("avatarHosts")), urlTemplate: avatarUrlTemplate(get("avatarUrlTemplate")) };
}

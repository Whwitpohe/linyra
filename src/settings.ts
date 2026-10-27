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

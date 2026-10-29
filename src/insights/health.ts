// Repository Health: what each check means, when a recommendation applies, and exactly what a
// write runs. Pure: no vscode, no node. The host reads the facts; the webview draws the rows.
import { localize } from "../i18n";
import type { ObjectCounts } from "./parse";

/** Where recommendations start. Git's own defaults where it has one (gc.auto, gc.autoPackLimit). */
export const THRESHOLDS = {
  /** A commit-graph is worth writing once a repository has this many objects. */
  commitGraphObjects: 1_000,
  /** git gc --auto's own default (gc.auto). */
  looseObjects: 6_700,
  /** git gc --auto's own default (gc.autoPackLimit). */
  packs: 50,
  /** git status rescans every folder for untracked files: the cache pays off from about here. */
  untrackedCache: 10_000,
  fsmonitor: 50_000,
  manyFiles: 100_000,
  /** Scheduled maintenance is worth it from either of these. */
  maintenanceFiles: 10_000,
  maintenancePackKiB: 100 * 1024,
};

export type HealthCheckId = "commitGraph" | "objects" | "tracked" | "untrackedCache" | "fsmonitor" | "manyFiles" | "maintenance";
export const CHECKS: readonly HealthCheckId[] = ["commitGraph", "objects", "tracked", "untrackedCache", "fsmonitor", "manyFiles", "maintenance"];

/** The settings Health turns on and off, as git spells them. */
export const CONFIG_KEYS = ["core.untrackedCache", "core.fsmonitor", "feature.manyFiles"] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];
export const isConfigKey = (v: unknown): v is ConfigKey => typeof v === "string" && (CONFIG_KEYS as readonly string[]).includes(v);

/** git maintenance run's tasks Health offers (prefetch is left out: it goes to the network). */
export const TASKS = ["commit-graph", "loose-objects", "incremental-repack", "pack-refs", "gc"] as const;
export type MaintenanceTask = (typeof TASKS)[number];
export const isTask = (v: unknown): v is MaintenanceTask => typeof v === "string" && (TASKS as readonly string[]).includes(v);

/** Each column's name and what it means, in plain words. */
export function checkInfo(id: HealthCheckId): { label: string; explain: string } {
  switch (id) {
    case "commitGraph": return { label: localize("Commit-graph"), explain: localize("A file listing every commit and its parents, so git log, the graph, topological order and ahead/behind counts need not open each commit.") };
    case "objects": return { label: localize("Objects"), explain: localize("Loose objects are one file each; packs hold many. Thousands of loose objects or dozens of packs slow every read.") };
    case "tracked": return { label: localize("Tracked files"), explain: localize("The files in the index. The three settings beside it pay off when there are many.") };
    case "untrackedCache": return { label: localize("Untracked cache"), explain: localize("git status remembers which folders had no new files and skips those that did not change.") };
    case "fsmonitor": return { label: localize("File system monitor"), explain: localize("A git process watches the working tree, so git status asks it what changed instead of looking at every file.") };
    case "manyFiles": return { label: localize("Many files"), explain: localize("feature.manyFiles: a newer index format and the untracked cache, for repositories with very many files.") };
    case "maintenance": return { label: localize("Maintenance"), explain: localize("git maintenance start registers the repository and lets the system's scheduler repack it and refresh its commit-graph in the background.") };
  }
}

export function taskInfo(task: MaintenanceTask): { label: string; detail: string } {
  switch (task) {
    case "commit-graph": return { label: task, detail: localize("Writes the commit-graph, so history walks are fast.") };
    case "loose-objects": return { label: task, detail: localize("Packs the loose objects, then deletes the loose copies already packed.") };
    case "incremental-repack": return { label: task, detail: localize("Merges small packs into bigger ones, a little at a time.") };
    case "pack-refs": return { label: task, detail: localize("Packs branches and tags into one file (git 2.38 and later).") };
    case "gc": return { label: task, detail: localize("git gc: repacks everything and deletes unreachable objects older than two weeks.") };
  }
}

/** What Health read of a repository. undefined: that read failed. */
export interface HealthFacts {
  root: string;
  commitGraph: boolean | undefined;
  objects: ObjectCounts | undefined;
  tracked: number | undefined;
  /** Every scope's values (git config --get-regexp), lowercased keys. */
  config: ReadonlyMap<string, readonly (string | null)[]> | undefined;
}

export type HealthStatus = "ok" | "suggest" | "info" | "unknown";

export type HealthAction =
  | { kind: "commitGraph" }
  | { kind: "maintenance"; tasks: MaintenanceTask[] }
  | { kind: "config"; key: ConfigKey; value: boolean }
  | { kind: "copy" };

export interface HealthCheck {
  id: HealthCheckId;
  value: string;
  status: HealthStatus;
  /** The recommendation, or why there is none. */
  advice: string;
  /** What the button does (a recommended one is `recommended`). */
  action?: HealthAction & { label: string; recommended: boolean };
}

export interface HealthRow {
  repoId: string;
  name: string;
  checks: HealthCheck[];
  /** How many checks recommend something. */
  suggestions: number;
  /** What Optimize Selected… runs here: the recommended actions that write. */
  optimize: HealthAction[];
}

/** git's boolean: no value at all is true; yes/on/true/1 and no/off/false/0/"" (else undefined: "keep", a path). */
export function gitBool(v: string | null | undefined): boolean | undefined {
  if (v === null) return true;
  if (v === undefined) return undefined;
  const s = v.trim().toLowerCase();
  if (["true", "yes", "on", "1"].includes(s)) return true;
  if (["false", "no", "off", "0", ""].includes(s)) return false;
  return undefined;
}

const last = (config: HealthFacts["config"], key: string): string | null | undefined => {
  const values = config?.get(key.toLowerCase());
  return values && values.length ? values[values.length - 1] : undefined;
};

/** The settings as git applies them: the last value wins, and feature.manyFiles turns the untracked cache on by default. */
export function effectiveConfig(config: HealthFacts["config"], root: string, insensitive: boolean) {
  const manyFiles = gitBool(last(config, "feature.manyFiles")) === true;
  const uc = last(config, "core.untrackedCache");
  const ucBool = gitBool(uc);
  const untrackedCache: { on: boolean; source: "set" | "manyFiles" | "unset" } = ucBool !== undefined ? { on: ucBool, source: "set" } : manyFiles ? { on: true, source: "manyFiles" } : { on: false, source: "unset" };
  const fm = last(config, "core.fsmonitor");
  const fmBool = gitBool(fm);
  const fsmonitor: { on: boolean; hook?: string } = fm === undefined ? { on: false } : fmBool !== undefined ? { on: fmBool } : { on: true, hook: fm ?? undefined };
  const norm = (p: string) => {
    const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
    return insensitive ? s.toLowerCase() : s;
  };
  const registered = (config?.get("maintenance.repo") ?? []).some((p) => p !== null && norm(p) === norm(root));
  return { manyFiles, untrackedCache, fsmonitor, registered };
}

export interface FormatOptions {
  number(n: number): string;
  bytes(n: number): string;
  /** process.platform: the file system monitor is built into git on Windows and macOS only. */
  platform: string;
  /** Windows and macOS compare paths case-insensitively. */
  insensitive: boolean;
}

/** One repository's row: every check's value, status, advice and button. */
export function assess(repo: { id: string; name: string }, f: HealthFacts, o: FormatOptions): HealthRow {
  const T = THRESHOLDS;
  const checks: HealthCheck[] = [];
  const unknown = (id: HealthCheckId): HealthCheck => ({ id, value: "—", status: "unknown", advice: localize("Could not be read.") });
  const objects = f.objects ? f.objects.loose + f.objects.inPack : undefined;
  const tracked = f.tracked;
  const many = (n: number) => tracked !== undefined && tracked >= n;
  const cfg = f.config ? effectiveConfig(f.config, f.root, o.insensitive) : undefined;

  if (f.commitGraph === undefined) checks.push(unknown("commitGraph"));
  else if (f.commitGraph) checks.push({ id: "commitGraph", value: localize("Present"), status: "ok", advice: localize("git log and the graph read it instead of every commit."),
    action: { kind: "commitGraph", label: localize("Write Commit-Graph"), recommended: false } });
  else {
    const needed = objects === undefined || objects >= T.commitGraphObjects;
    checks.push({ id: "commitGraph", value: localize("Missing"), status: needed ? "suggest" : "ok",
      advice: needed ? localize("Write one: topological order and the graph walk the whole history without it.") : localize("Not needed yet: fewer than {0} objects.", o.number(T.commitGraphObjects)),
      action: { kind: "commitGraph", label: localize("Write Commit-Graph"), recommended: needed } });
  }

  if (!f.objects) checks.push(unknown("objects"));
  else {
    const tasks: MaintenanceTask[] = [];
    if (f.objects.loose >= T.looseObjects) tasks.push("loose-objects");
    if (f.objects.packs >= T.packs) tasks.push("incremental-repack");
    const value = [localize("{0} loose", o.number(f.objects.loose)), localize(f.objects.packs === 1 ? "{0} pack" : "{0} packs", o.number(f.objects.packs)), o.bytes(f.objects.packKiB * 1024)].join(" · ");
    const advice = tasks.length === 2 ? localize("Over {0} loose objects and {1} packs: run the loose-objects and incremental-repack tasks.", o.number(T.looseObjects), o.number(T.packs))
      : tasks[0] === "loose-objects" ? localize("Over {0} loose objects (git gc's own limit): pack them.", o.number(T.looseObjects))
      : tasks[0] === "incremental-repack" ? localize("Over {0} packs (git gc's own limit): merge them.", o.number(T.packs))
      : localize("Under git gc's limits ({0} loose objects, {1} packs).", o.number(T.looseObjects), o.number(T.packs));
    checks.push({ id: "objects", value, status: tasks.length ? "suggest" : "ok", advice,
      action: { kind: "maintenance", tasks: tasks.length ? tasks : ["loose-objects", "incremental-repack"], label: localize("Run Maintenance…"), recommended: tasks.length > 0 } });
  }

  checks.push(tracked === undefined ? unknown("tracked")
    : { id: "tracked", value: localize(tracked === 1 ? "{0} file" : "{0} files", o.number(tracked)), status: "info",
      advice: many(T.untrackedCache) ? localize("Many files: the settings beside this make git status faster.") : localize("Under {0} files: git status is fast without help.", o.number(T.untrackedCache)) });

  if (!cfg) checks.push(unknown("untrackedCache"), unknown("fsmonitor"), unknown("manyFiles"));
  else {
    const uc = cfg.untrackedCache;
    const ucWanted = many(T.untrackedCache) && !uc.on;
    checks.push({ id: "untrackedCache", value: uc.on ? (uc.source === "manyFiles" ? localize("On (feature.manyFiles)") : localize("On")) : localize("Off"),
      status: ucWanted ? "suggest" : "ok",
      advice: ucWanted ? localize("Over {0} tracked files: turn it on.", o.number(T.untrackedCache)) : uc.on ? localize("On: git status skips folders that did not change.") : localize("Not needed under {0} tracked files.", o.number(T.untrackedCache)),
      action: uc.source === "manyFiles" ? undefined : { kind: "config", key: "core.untrackedCache", value: !uc.on, label: uc.on ? localize("Turn Off") : localize("Turn On"), recommended: ucWanted } });

    const fm = cfg.fsmonitor;
    const builtIn = o.platform === "win32" || o.platform === "darwin";
    const fmWanted = builtIn && many(T.fsmonitor) && !fm.on;
    checks.push({ id: "fsmonitor", value: fm.hook ? localize("Hook: {0}", fm.hook) : fm.on ? localize("On (built-in)") : localize("Off"),
      status: fmWanted ? "suggest" : !builtIn && !fm.on ? "info" : "ok",
      advice: fmWanted ? localize("Over {0} tracked files: turn it on. git then runs a watcher in the background for this repository.", o.number(T.fsmonitor))
        : fm.on ? localize("On: git status asks the monitor what changed.")
        : !builtIn ? localize("git's built-in monitor runs on Windows and macOS only.")
        : localize("Not needed under {0} tracked files.", o.number(T.fsmonitor)),
      action: fm.hook || (!builtIn && !fm.on) ? undefined : { kind: "config", key: "core.fsmonitor", value: !fm.on, label: fm.on ? localize("Turn Off") : localize("Turn On"), recommended: fmWanted } });

    const mfWanted = many(T.manyFiles) && !cfg.manyFiles;
    checks.push({ id: "manyFiles", value: cfg.manyFiles ? localize("On") : localize("Off"), status: mfWanted ? "suggest" : "ok",
      advice: mfWanted ? localize("Over {0} tracked files: turn it on. Older tools (libgit2, JGit) may not read the index it writes.", o.number(T.manyFiles))
        : cfg.manyFiles ? localize("On: index version 4, index.skipHash and the untracked cache.") : localize("Not needed under {0} tracked files.", o.number(T.manyFiles)),
      action: { kind: "config", key: "feature.manyFiles", value: !cfg.manyFiles, label: cfg.manyFiles ? localize("Turn Off") : localize("Turn On"), recommended: mfWanted } });
  }

  if (!cfg) checks.push(unknown("maintenance"));
  else {
    const big = many(T.maintenanceFiles) || (f.objects !== undefined && f.objects.packKiB >= T.maintenancePackKiB);
    const wanted = big && !cfg.registered;
    checks.push({ id: "maintenance", value: cfg.registered ? localize("Registered") : localize("Not registered"), status: wanted ? "suggest" : "ok",
      advice: cfg.registered ? localize("The system's scheduler maintains it (if git maintenance start set one up).")
        : wanted ? localize("A big repository: run git maintenance start in a terminal. It changes your global git config and the system's scheduled tasks, so Linyra does not run it.")
        : localize("Not needed for a repository this size."),
      action: cfg.registered ? undefined : { kind: "copy", label: localize("Copy Command"), recommended: false } });
  }

  const optimize = checks.flatMap((c) => (c.action?.recommended && c.action.kind !== "copy" ? [stripAction(c.action)] : []));
  return { repoId: repo.id, name: repo.name, checks, suggestions: checks.filter((c) => c.status === "suggest").length, optimize };
}

function stripAction(a: HealthAction & { label?: string; recommended?: boolean }): HealthAction {
  switch (a.kind) {
    case "commitGraph": return { kind: "commitGraph" };
    case "maintenance": return { kind: "maintenance", tasks: [...a.tasks] };
    case "config": return { kind: "config", key: a.key, value: a.value };
    case "copy": return { kind: "copy" };
  }
}

/** One git command a write runs, and what it changes. */
export interface WritePlan { args: string[]; writes: string }

/** What an action runs, exactly. A copy runs nothing. */
export function writePlan(action: HealthAction): WritePlan | undefined {
  switch (action.kind) {
    case "commitGraph": return { args: ["commit-graph", "write", "--reachable"], writes: localize("writes .git/objects/info/commit-graph") };
    case "maintenance": return action.tasks.length ? { args: ["maintenance", "run", ...action.tasks.map((t) => `--task=${t}`)], writes: action.tasks.includes("gc")
      ? localize("rewrites the packs and deletes unreachable objects older than two weeks")
      : localize("rewrites packs and loose objects, keeping every object") } : undefined;
    case "config": return { args: ["config", "--local", action.key, action.value ? "true" : "false"], writes: localize("writes .git/config") };
    case "copy": return undefined;
  }
}

/** The command as the confirmation shows it. */
export const commandText = (p: WritePlan): string => `git ${p.args.join(" ")}`;

/** git maintenance start, for a terminal, in that repository. */
export const maintenanceStart = (root: string): string => `git -C "${root}" maintenance start`;

/**
 * The confirmation: what will be written, in which repository, by which command. Nothing is
 * written without it.
 */
export function confirmText(plans: readonly { name: string; plans: readonly WritePlan[] }[]): { message: string; detail: string; button: string } {
  const repos = plans.filter((p) => p.plans.length > 0);
  const lines = repos.flatMap((r) => [`${r.name}:`, ...r.plans.map((p) => `  ${commandText(p)}  (${p.writes})`), ""]);
  const detail = [localize("Linyra will run:"), "", ...lines, localize("Each command writes only inside that repository's .git folder.")].join("\n");
  const only = repos.length === 1 && repos[0].plans.length === 1 ? repos[0].plans[0] : undefined;
  if (only?.args[0] === "commit-graph") return { message: localize("Write the commit-graph in {0}?", repos[0].name), detail, button: localize("Write Commit-Graph") };
  if (only?.args[0] === "maintenance") return { message: localize("Run git maintenance in {0}?", repos[0].name), detail, button: localize("Run Maintenance") };
  if (only?.args[0] === "config") return { message: localize("Set {0} to {1} in {2}?", only.args[2], only.args[3], repos[0].name), detail, button: only.args[3] === "true" ? localize("Turn On") : localize("Turn Off") };
  return { message: repos.length === 1 ? localize("Optimize {0}?", repos[0].name) : localize("Optimize {0} repositories?", repos.length), detail, button: localize("Optimize") };
}

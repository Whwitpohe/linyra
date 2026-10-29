import { localize } from "./i18n";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import { abortError } from "./pool";

export class GitError extends Error {
  /** stdout: what git printed before failing (merge-tree lists conflicts and exits 1). */
  constructor(message: string, readonly exitCode: number | null, readonly stdout = "") {
    super(message);
    this.name = "GitError";
  }
}

// Overrides that keep output parseable whatever the user's git config says.
const CONFIG = [
  "-c", "log.showSignature=false",
  "-c", "core.quotepath=off",
  "-c", "i18n.logOutputEncoding=UTF-8",
  "-c", "color.ui=never",
];

/** git's message for a failure: its fatal:/error: line (hint: lines come first), else the first line. */
export function errorLine(stderr: string): string {
  const lines = stderr.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  const line = lines.find((l) => /^(fatal|error): /.test(l)) ?? lines.find((l) => !/^(hint|warning):/.test(l)) ?? lines[0] ?? "";
  return line.replace(/^(fatal|error): /, "").trim();
}

/** Spawn failures that mean "this binary cannot run here", so the next candidate is tried. */
// EINVAL: Node refuses to spawn a Windows .cmd/.bat without a shell.
const NOT_RUNNABLE = new Set(["ENOENT", "EACCES", "ENOTDIR", "EISDIR", "EINVAL", "EPERM"]);

class NotRunnable extends Error {}

export interface RunOptions {
  /** UTF-8 input for Git's batch commands. Never interpreted by a shell. */
  input?: string;
  /**
   * Abort kills git's whole process tree (ssh, remote helpers, credential helpers), not only
   * git: for network commands, whose helpers would otherwise outlive a timeout.
   */
  tree?: boolean;
  /** Added to the environment. */
  env?: Record<string, string>;
}

/** Kills a process and everything it started: its process group on POSIX, taskkill /T on Windows. */
function killTree(pid: number): void {
  try {
    if (process.platform === "win32") spawn("taskkill", ["/T", "/F", "/PID", String(pid)], { windowsHide: true, stdio: "ignore" }).on("error", () => undefined);
    else process.kill(-pid, "SIGTERM");
  } catch {
    // already gone
  }
}

function spawnGit(binary: string, cwd: string, args: string[], signal?: AbortSignal, opts: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (opts.tree && signal?.aborted) return reject(abortError());
    const child = spawn(binary, [...CONFIG, ...args], {
      cwd,
      // A tree run handles the abort itself (below): killing only git would orphan its helpers.
      signal: opts.tree ? undefined : signal,
      // Its own process group, so the whole tree can be killed at once (POSIX only).
      detached: opts.tree === true && process.platform !== "win32",
      windowsHide: true,
      // No credential prompts; no index.lock contention with VS Code's own git.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", ...opts.env },
    });
    const onAbort = () => {
      if (child.pid !== undefined) killTree(child.pid);
      reject(abortError());
    };
    if (opts.tree) signal?.addEventListener("abort", onAbort, { once: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e: NodeJS.ErrnoException) => {
      if (e.name === "AbortError") reject(e);
      else if (e.code && NOT_RUNNABLE.has(e.code)) reject(new NotRunnable(e.code));
      else reject(e);
    });
    if (opts.input !== undefined) {
      // An invalid command can close stdin before the write completes; its exit code
      // and stderr below remain the authoritative error instead of an unhandled EPIPE.
      child.stdin.on("error", () => undefined);
      child.stdin.end(opts.input);
    }
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      // Aborted: usually rejected already by the "error" handler, but not when git had exited
      // before the abort (Node then emits no error). Settling twice is harmless; never is a hang.
      if (signal?.aborted) return reject(abortError());
      if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
      else reject(new GitError(errorLine(Buffer.concat(err).toString("utf8")) || localize("git exited with code {0}", String(code)), code, Buffer.concat(out).toString("utf8")));
    });
  });
}

/**
 * Runs git with the first binary that can run: VS Code's `git.path`, then the path VS
 * Code's Git extension found, then git on PATH (gitBinary.ts). The working binary is
 * remembered until reset(), which the extension calls when `git.path` changes.
 * Async only: the extension host is shared with every other extension.
 */
export class GitRunner {
  private resolved: string | undefined;
  /** Bumped by reset(): a lookup that started before git.path changed must not win. */
  private generation = 0;
  private lastFailed = false;

  constructor(private readonly candidates: () => string[]) {}

  /** No candidate could run on the last attempt (VS Code's Git reporting its path may help). */
  failed(): boolean {
    return this.lastFailed;
  }

  /** The binary in use, once one has run. */
  binary(): string | undefined {
    return this.resolved;
  }

  reset(): void {
    this.resolved = undefined;
    this.generation++;
  }

  readonly run = async (cwd: string, args: string[], signal?: AbortSignal, opts?: RunOptions): Promise<string> => {
    const generation = this.generation;
    if (this.resolved) {
      try {
        return await spawnGit(this.resolved, cwd, args, signal, opts);
      } catch (e) {
        if (!(e instanceof NotRunnable)) throw e;
        await this.checkFolder(cwd);
        this.resolved = undefined; // it ran before and stopped: look again
      }
    }
    const tried: string[] = [];
    for (const binary of this.candidates()) {
      try {
        const out = await spawnGit(binary, cwd, args, signal, opts);
        this.remember(binary, generation);
        return out;
      } catch (e) {
        if (!(e instanceof NotRunnable)) {
          this.remember(binary, generation); // it ran; the error is git's own
          throw e;
        }
        // A missing working folder looks exactly like a missing binary (both ENOENT).
        await this.checkFolder(cwd);
        tried.push(binary);
      }
    }
    if (generation === this.generation) this.lastFailed = true;
    throw new GitError(localize("git was not found (tried: {0}). Check the git.path setting.", tried.join(", ")), null);
  };

  private remember(binary: string, generation: number): void {
    if (generation !== this.generation) return; // git.path changed meanwhile
    this.resolved = binary;
    this.lastFailed = false;
  }

  private async checkFolder(cwd: string): Promise<void> {
    const ok = await fs.stat(cwd).then((s) => s.isDirectory(), () => false);
    if (!ok) throw new GitError(localize("the repository folder is missing: {0}", cwd), null);
  }
}

/** git from PATH only: tests and callers with no VS Code settings. */
export const runGit = new GitRunner(() => ["git"]).run;

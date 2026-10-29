import * as vscode from "vscode";
import { debounce } from "./debounce";
import { runPool } from "./pool";
import { readHead } from "./repoHead";
import type { RepoMark, WorkMark } from "./repoMarkModel";
import type { Repo } from "./types";

export interface MarksHost {
  repos(): readonly Repo[];
  /** git status's last answer for the repository (the uncommitted store; undefined: not read, or under a Path filter). */
  storeWork(repoId: string): WorkMark | undefined;
  /** What VS Code's Git last found in a repository it watches (undefined: not known). */
  vsCodeWork(root: string): WorkMark | undefined;
  /** The marks changed: send them to the Repo List. */
  changed(byRepo: Record<string, RepoMark>): void;
  concurrency(): number;
}

/**
 * Each repository's Repo List mark. The branch and the operation are read from the git dir's files
 * (cheap: no process) when VS Code's Git reports the repository, when Linyra changed it, and when
 * the window regains focus; the uncommitted work is what the store or VS Code's Git already know.
 */
export class RepoMarks implements vscode.Disposable {
  private readonly heads = new Map<string, Omit<RepoMark, "work">>();
  private sent = "";
  private marks: Record<string, RepoMark> = {};
  private readonly background = new AbortController();
  private readonly touchedIds = new Set<string>();
  private readonly readSoon = debounce(() => {
    const ids = new Set(this.touchedIds);
    this.touchedIds.clear();
    void this.read(ids);
  }, 300);
  private readonly changedEmitter = new vscode.EventEmitter<void>();
  /** A repository's mark changed (the Commit side bar shows the operation too). */
  readonly onDidChange = this.changedEmitter.event;

  constructor(private readonly host: MarksHost) {}

  /** Reads these repositories' branch and operation again (every repository by default). */
  async read(only?: ReadonlySet<string>): Promise<void> {
    const all = this.host.repos();
    const repos = only ? all.filter((r) => only.has(r.id)) : [...all];
    const settled = await runPool(repos, this.host.concurrency(), (r) => readHead(r.root), this.background.signal);
    if (this.background.signal.aborted) return;
    settled.forEach((s, i) => {
      if (s.status === "fulfilled" && s.value) this.heads.set(repos[i].id, s.value);
      else this.heads.delete(repos[i].id);
    });
    for (const id of [...this.heads.keys()]) if (!all.some((r) => r.id === id)) this.heads.delete(id);
    this.publish();
  }

  /** VS Code's Git reported the repository (a checkout, a merge stopping, a save): read it again soon. */
  touched(repoId: string): void {
    this.touchedIds.add(repoId);
    this.readSoon();
  }

  /** The uncommitted work changed somewhere: the * + ! marks follow, without reading anything. */
  publish(): void {
    const next: Record<string, RepoMark> = {};
    for (const r of this.host.repos()) {
      const head = this.heads.get(r.id);
      if (!head) continue;
      const work = this.host.storeWork(r.id) ?? this.host.vsCodeWork(r.root);
      next[r.id] = work ? { ...head, work } : head;
    }
    const key = JSON.stringify(next);
    if (key === this.sent) return;
    this.sent = key;
    this.marks = next;
    this.host.changed(next);
    this.changedEmitter.fire();
    void vscode.commands.executeCommand("setContext", "linyra.anyOperation", Object.values(next).some((m) => m.operation !== undefined));
  }

  byRepo(): Readonly<Record<string, RepoMark>> {
    return this.marks;
  }

  get(repoId: string): RepoMark | undefined {
    return this.marks[repoId];
  }

  dispose(): void {
    this.background.abort();
    this.readSoon.cancel();
    this.changedEmitter.dispose();
  }
}

// Which repositories a Linyra write is running in, shared by every module that writes (commit
// rows, the Repo List, actions across repositories, Pull): one write per repository at a time, so a
// Reset never runs in the middle of Update Project's merge there. Pure: no vscode.

/** Repository ids held by a running write. */
export class RepoBusy {
  private readonly held = new Set<string>();

  has(id: string): boolean {
    return this.held.has(id);
  }

  /** Holds the repository for a write: its release (once is enough), or undefined when a write already runs there. */
  take(id: string): (() => void) | undefined {
    if (this.held.has(id)) return undefined;
    this.held.add(id);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.held.delete(id);
    };
  }

  /** Holds every free one of these; `busy`: those a write already runs in, left out. */
  takeEach(ids: readonly string[]): { taken: string[]; busy: string[]; release: () => void } {
    const releases: (() => void)[] = [], taken: string[] = [], busy: string[] = [];
    for (const id of ids) {
      const release = this.take(id);
      if (release) { releases.push(release); taken.push(id); } else if (!taken.includes(id)) busy.push(id);
    }
    return { taken, busy, release: () => { for (const r of releases) r(); } };
  }
}

/** The one registry of the extension host. */
export const repoBusy = new RepoBusy();

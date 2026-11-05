// globalState as this window last wrote it. VS Code's extension host keeps the extension's state as
// one object, writes it whole after an update, and takes back whatever the main process then says
// it holds: the answer to an earlier write, arriving after a later update, puts the older value
// back (and the later update is lost if its own write had not gone out yet). Two updates in the
// same moment do that: a pane's width saved as Stash Changes… remembers Include new files.
// Pure: no vscode import (the types only).
import type { Memento } from "vscode";

/** A Memento whose values written in this session are read back as written; the rest from `m`. */
export function sessionMemento<M extends Memento>(m: M): M {
  const written = new Map<string, unknown>();
  const wrapped: Memento = {
    keys: () => [...new Set([...m.keys(), ...written.keys()])].filter((key) => !written.has(key) || written.get(key) !== undefined),
    get: <T>(key: string, fallback?: T): T | undefined => {
      if (!written.has(key)) return fallback === undefined ? m.get<T>(key) : m.get<T>(key, fallback);
      // undefined removes the key: the default answers, as VS Code's own get does.
      const value = written.get(key) as T | undefined;
      return value === undefined ? fallback : value;
    },
    update: (key: string, value: unknown) => {
      // A copy, as VS Code keeps one: a caller changing its object later does not change what was saved.
      written.set(key, value !== null && typeof value === "object" ? JSON.parse(JSON.stringify(value)) : value);
      return m.update(key, value);
    },
  };
  // setKeysForSync (globalState's), called on VS Code's own object: inherited, it would run on this one.
  const sync = (m as Partial<{ setKeysForSync(keys: readonly string[]): void }>).setKeysForSync;
  const extra = typeof sync === "function" ? { setKeysForSync: (keys: readonly string[]) => sync.call(m, keys) } : {};
  return Object.assign(Object.create(m) as M, wrapped, extra);
}

/**
 * The extension's context with globalState read as this session wrote it (sessionMemento). The
 * context itself is frozen: a new object over it, every other member the context's own.
 */
export function withSessionState<C extends { globalState: Memento }>(context: C): C {
  return Object.create(context, { globalState: { value: sessionMemento(context.globalState), enumerable: true } }) as C;
}

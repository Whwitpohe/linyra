/** Only the Mementos belonging to whwitpohe.linyra are passed here. */
export interface PrivateState {
  keys(): readonly string[];
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

/** Preserve earlier Linyra layouts and filters without opening another extension's storage. */
export async function migratePrivateState(state: PrivateState): Promise<void> {
  const previousPrefix = "polylog.";
  const keys = new Set(state.keys());
  for (const key of keys) {
    if (!key.startsWith(previousPrefix)) continue;
    const target = `linyra.${key.slice(previousPrefix.length)}`;
    if (!keys.has(target)) await state.update(target, state.get(key));
    // Remove the old key only after its value is safely saved, or a newer preference exists.
    await state.update(key, undefined);
  }
}

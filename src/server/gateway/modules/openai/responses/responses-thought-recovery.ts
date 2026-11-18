interface RecoveryCount {
  removed: number;
  unknown: number;
}
type ActiveHistory = (sessionKey?: string) => RecoveryCount;
const activeHistories = new Set<ActiveHistory>();

/** Entries live exactly as long as their open transport; closed sockets leave no aliases. */
export function registerActiveResponsesHistory(history: ActiveHistory): () => void {
  activeHistories.add(history);
  return () => {
    activeHistories.delete(history);
  };
}

/** The durable Responses owner also owns deletion of its live transport histories. */
export async function deleteResponsesRecoveryScope(
  sessionKey: string | undefined,
  deleteDurable: (key?: string) => Promise<RecoveryCount>,
): Promise<RecoveryCount> {
  let removed = 0;
  let unknown = 0;
  for (const invalidate of Array.from(activeHistories)) {
    const result = invalidate(sessionKey);
    removed += result.removed;
    unknown += result.unknown;
  }
  const durable = await deleteDurable(sessionKey);
  return { removed: removed + durable.removed, unknown: unknown + durable.unknown };
}

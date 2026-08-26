/**
 * Shared knobs for the durable stores.
 *
 * Bounds are read from the environment so an operator can tighten or relax them
 * on an installed build without a rebuild, and durable paths are suppressed
 * under the test runner so a unit test never writes into the real data
 * directory. Tests that need a file pass an explicit path instead.
 */
export function isDurableStoreTestEnvironment(): boolean {
  return process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
}

/** Reads a positive integer override, falling back when unset or nonsensical. */
export function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

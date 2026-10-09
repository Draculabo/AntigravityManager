import { setTimeout as delay } from 'node:timers/promises';

// Match the existing CLI startup window; the comparison check guards against policy drift.
const STARTUP_TIMEOUT_MS = 45_000;

/** Bound total readiness time, including a stalled management probe. */
export async function waitForOwnedCore({ management, childHasExited, result }) {
  const startedAt = Date.now();
  const deadline = startedAt + STARTUP_TIMEOUT_MS;
  const readiness = { probes: 0, elapsedMs: 0, states: {}, errors: {} };
  const errorNames = new Set([
    'ServiceNotRunningError',
    'ManagementTimeoutError',
    'ManagementProtocolError',
  ]);
  const stateNames = new Set(['running', 'stopped', 'starting', 'stopping']);
  result.startupReadiness = readiness;
  while (true) {
    readiness.elapsedMs = Date.now() - startedAt;
    if (childHasExited()) {
      throw new Error('Owned core exited during startup');
    }
    if (Date.now() >= deadline) {
      throw new Error('Owned core readiness timed out');
    }
    readiness.probes++;
    const timeout = new AbortController();
    try {
      const status = await Promise.race([
        management.status(),
        delay(Math.max(0, deadline - Date.now()), undefined, { signal: timeout.signal }).then(
          () => {
            throw new Error('Owned core readiness timed out');
          },
        ),
      ]);
      if (Date.now() > deadline) {
        throw new Error('Owned core readiness timed out');
      }
      const state = stateNames.has(status.state) ? status.state : 'other';
      readiness.states[state] = (readiness.states[state] ?? 0) + 1;
      if (status.state === 'running') {
        return;
      }
    } catch (error) {
      if (error.message === 'Owned core readiness timed out') {
        readiness.elapsedMs = Date.now() - startedAt;
        throw error;
      }
      const name = errorNames.has(error.name) ? error.name : 'other';
      readiness.errors[name] = (readiness.errors[name] ?? 0) + 1;
    } finally {
      timeout.abort();
    }
    readiness.elapsedMs = Date.now() - startedAt;
    if (Date.now() >= deadline) {
      throw new Error('Owned core readiness timed out');
    }
    await delay(Math.min(500, deadline - Date.now()));
  }
}

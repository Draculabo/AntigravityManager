import { randomUUID } from 'node:crypto';
import { trafficAuditService, type TrafficAuditService } from './traffic-audit.service';
import {
  createThoughtSessionKey,
  runWithTrafficAuditRequestContext,
} from './traffic-audit-context';
import { isAuditManagementIpc, readIpcSessionId } from './ipc-audit-policy';
import type { createRemoteIpcAuditRecorder } from './remote-ipc-audit-recorder';

let selectedRemote: ReturnType<typeof createRemoteIpcAuditRecorder> | undefined;
export function selectIpcAuditRecorder(
  remote: ReturnType<typeof createRemoteIpcAuditRecorder> | undefined,
): void {
  selectedRemote = remote;
}

type IpcAuditSource = Pick<TrafficAuditService, 'startParent' | 'completeParent'>;

/** Tracks handler lifetime rather than its connection, so late completions cannot reopen stores. */
export function createIpcAuditRecorder(source: IpcAuditSource = trafficAuditService) {
  let accepting = true;
  const active = new Set<Promise<unknown>>();

  async function record<TResult extends { output: unknown }>(
    path: readonly string[],
    input: unknown,
    next: () => TResult | PromiseLike<TResult>,
    remote: ReturnType<typeof createRemoteIpcAuditRecorder> | undefined,
  ): Promise<TResult> {
    if (remote) {
      return remote.run(path, input, next);
    }
    const auditPath = path.join('/');
    const sessionId = readIpcSessionId(input);
    const parent = isAuditManagementIpc(auditPath)
      ? null
      : source.startParent({
          method: 'IPC',
          operation: auditPath,
          protocol: 'ipc',
          requestBody: input,
          sessionId: sessionId ?? undefined,
          trafficClass: 'ipc',
          url: `/ipc/${auditPath}`,
        });
    return runWithTrafficAuditRequestContext(
      {
        attemptSequence: 0,
        parent,
        thoughtSessionKey: createThoughtSessionKey({}, sessionId ?? `request-${randomUUID()}`),
        thoughtSessionStable: Boolean(sessionId),
      },
      async () => {
        try {
          const result = await next();
          source.completeParent(parent, {
            outcome: 'completed',
            responseBody: result.output,
            status: 200,
          });
          return result;
        } catch (error) {
          source.completeParent(parent, { error, outcome: 'internal_error', status: 500 });
          throw error;
        }
      },
    );
  }

  return {
    run<TResult extends { output: unknown }>(
      path: readonly string[],
      input: unknown,
      next: () => TResult | PromiseLike<TResult>,
    ): Promise<TResult> {
      if (!accepting) {
        return Promise.reject(new Error('IPC requests are unavailable during shutdown'));
      }
      // Register before invoking a handler that could synchronously request shutdown.
      const remote = source === trafficAuditService ? selectedRemote : undefined;
      const task = Promise.resolve().then(() => record(path, input, next, remote));
      active.add(task);
      return task.finally(() => active.delete(task));
    },
    closeAdmission(): void {
      accepting = false;
    },
    async drain(): Promise<void> {
      // Handler failures are delivered to their callers; they are not cleanup failures.
      await Promise.allSettled([...active]);
    },
  };
}

export const ipcAuditRecorder = createIpcAuditRecorder();

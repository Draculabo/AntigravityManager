import type { TrafficAuditRepository } from './traffic-audit.repository';
import type {
  TrafficAuditWorkerCommand,
  AuditCaptureGeneration,
} from './traffic-audit.worker-protocol';

type Repository = Pick<
  TrafficAuditRepository,
  'execute' | 'maintenance' | 'shouldPruneAfterIpcInsert' | 'shouldPruneIpc' | 'pruneIpc'
>;
type Reply = { id: number } & ({ yielded: true } | { result: unknown } | { error: string });

/** Owns the resumable maintenance cursor; no SQLite transaction survives a reply. */
export function createTrafficAuditWorkerDispatcher(
  repository: Repository,
  reply: (message: Reply) => void,
  reportIpcPruneFailure: (error: unknown) => void,
) {
  let active: { id: number; steps: ReturnType<Repository['maintenance']> } | null = null;
  let ipcPrune: ReturnType<Repository['pruneIpc']> | null = null;
  let ipcPruneTick: NodeJS.Immediate | null = null;
  let closed = false;

  function scheduleIpcPrune(): void {
    if (ipcPrune) {
      return;
    }
    ipcPrune = repository.pruneIpc();
    ipcPruneTick = setImmediate(advanceIpcPrune);
  }

  function advanceIpcPrune(): void {
    ipcPruneTick = null;
    try {
      const step = ipcPrune?.next();
      if (step?.done === false) {
        ipcPruneTick = setImmediate(advanceIpcPrune);
      } else {
        ipcPrune = null;
        if (step?.value) {
          scheduleIpcPrune();
        }
      }
    } catch (error) {
      ipcPrune = null;
      reportIpcPruneFailure(error);
    }
  }

  return (
    id: number,
    command: TrafficAuditWorkerCommand,
    maxDiskBytes?: number,
    capture?: AuditCaptureGeneration,
  ): void => {
    try {
      if (closed) {
        throw new Error('Traffic audit worker is closed');
      }
      if (command.operation === 'maintenance' || command.operation === 'configure') {
        // Keep configuration passes in admission order while other commands can run.
        if (active && active.id !== id) {
          reply({ id, yielded: true });
          return;
        }
        if (!active) {
          if (!ipcPrune && repository.shouldPruneIpc()) {
            scheduleIpcPrune();
          }
          active = { id, steps: repository.maintenance(command.payload) };
        }
        if (ipcPrune) {
          if (ipcPruneTick) {
            clearImmediate(ipcPruneTick);
          }
          advanceIpcPrune();
          reply({ id, yielded: true });
          return;
        }
        const step = active.steps.next();
        if (step.done) {
          active = null;
          reply({ id, result: step.value });
        } else {
          reply({ id, yielded: true });
        }
        return;
      }
      if (command.operation === 'shutdown') {
        closed = true;
        if (ipcPruneTick) {
          clearImmediate(ipcPruneTick);
          ipcPruneTick = null;
        }
        ipcPrune = null;
        if (active) {
          reply({ id: active.id, error: 'Traffic audit maintenance interrupted by shutdown' });
          active = null;
        }
      }
      const result = capture
        ? repository.execute(command, maxDiskBytes, capture)
        : maxDiskBytes === undefined
          ? repository.execute(command)
          : repository.execute(command, maxDiskBytes);
      reply({ id, result });
      if (
        !ipcPrune &&
        result === 1 &&
        command.operation === 'insertParent' &&
        command.payload.trafficClass === 'ipc'
      ) {
        try {
          if (repository.shouldPruneAfterIpcInsert()) {
            scheduleIpcPrune();
          }
        } catch (error) {
          reportIpcPruneFailure(error);
        }
      }
    } catch (error) {
      if (active?.id === id) {
        active = null;
      }
      reply({ id, error: error instanceof Error ? error.message : String(error) });
    }
  };
}

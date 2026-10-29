import type { TrafficAuditRepository } from './traffic-audit.repository';
import type { TrafficAuditWorkerCommand } from './traffic-audit.worker-protocol';

type Repository = Pick<TrafficAuditRepository, 'execute' | 'maintenance'>;
type Reply = { id: number } & ({ yielded: true } | { result: unknown } | { error: string });

/** Owns the resumable maintenance cursor; no SQLite transaction survives a reply. */
export function createTrafficAuditWorkerDispatcher(
  repository: Repository,
  reply: (message: Reply) => void,
) {
  let active: { id: number; steps: ReturnType<Repository['maintenance']> } | null = null;
  let closed = false;
  return (id: number, command: TrafficAuditWorkerCommand): void => {
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
        active ??= { id, steps: repository.maintenance(command.payload) };
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
        if (active) {
          reply({ id: active.id, error: 'Traffic audit maintenance interrupted by shutdown' });
          active = null;
        }
      }
      reply({ id, result: repository.execute(command) });
    } catch (error) {
      if (active?.id === id) {
        active = null;
      }
      reply({ id, error: error instanceof Error ? error.message : String(error) });
    }
  };
}

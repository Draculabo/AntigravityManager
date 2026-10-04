import { logger } from '@/shared/logging/logger';
import type { AuditOperations } from '../audit/audit-owner.service';
import type { TrafficAuditEvent } from '../audit/traffic-audit.types';
import { getAuditAdapter } from './audit-adapter';

/** One sequential poll per window; selection changes invalidate stale replies and cursors. */
export function subscribeSelectedAuditEvents(
  present: (event: TrafficAuditEvent) => void,
  resolveOwner: () => AuditOperations = getAuditAdapter,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let owner: AuditOperations | undefined;
  let epoch: string | undefined;
  let after = 0;
  let unavailable = false;

  async function poll(): Promise<void> {
    const selected = resolveOwner();
    if (selected !== owner) {
      owner = selected;
      epoch = undefined;
      after = 0;
    }
    try {
      const batch = await selected.events({ epoch, after });
      if (stopped || resolveOwner() !== selected) {
        return;
      }
      unavailable = false;
      if (batch.reset) {
        present({ id: 'all', kind: 'cleared', timestamp: Date.now() });
      }
      epoch = batch.epoch;
      for (const item of batch.events) {
        if (stopped) {
          return;
        }
        present(item.event);
        after = item.sequence;
      }
      if (batch.events.length === 0) {
        after = batch.latest;
      }
    } catch {
      if (!stopped && !unavailable) {
        logger.warn('Audit presentation is unavailable');
      }
      unavailable = true;
    } finally {
      if (!stopped) {
        timer = setTimeout(
          () => {
            void poll();
          },
          unavailable ? 2000 : 250,
        );
      }
    }
  }
  poll();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

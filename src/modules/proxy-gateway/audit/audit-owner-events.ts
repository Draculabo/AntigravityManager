import { randomUUID } from 'node:crypto';
import { logger } from '@/shared/logging/logger';
import {
  AuditEventBatchSchema,
  type AuditEventBatch,
  type AuditEventReadInput,
} from './audit-owner.schema';
import { TrafficAuditEventSchema, type TrafficAuditEvent } from './traffic-audit.types';

/** Bounded presentation hints. Overflow requires refresh, never replay of database work. */
export class AuditOwnerEvents {
  private epoch = randomUUID();
  private sequence = 0;
  private readonly events: AuditEventBatch['events'] = [];

  publish(event: TrafficAuditEvent): void {
    const parsed = TrafficAuditEventSchema.extend({
      id: TrafficAuditEventSchema.shape.id.min(1).max(128),
    })
      .strict()
      .safeParse(event);
    if (!parsed.success) {
      logger.warn('Audit presentation event rejected');
      return;
    }
    if (this.sequence === Number.MAX_SAFE_INTEGER) {
      this.events.length = 0;
      this.sequence = 0;
      this.epoch = randomUUID();
    }
    this.events.push({ sequence: ++this.sequence, event: parsed.data });
    if (this.events.length > 128) {
      this.events.shift();
    }
  }

  read(input: AuditEventReadInput): AuditEventBatch {
    const sameEpoch = input.epoch === this.epoch;
    const after = sameEpoch ? input.after : 0;
    const oldest = this.events[0]?.sequence ?? this.sequence + 1;
    return AuditEventBatchSchema.parse({
      epoch: this.epoch,
      latest: this.sequence,
      reset: !sameEpoch || after < oldest - 1 || after > this.sequence,
      events: this.events.filter((item) => item.sequence > after).slice(0, 32),
    });
  }
}

import { randomUUID } from 'node:crypto';
import { logger } from '@/shared/logging/logger';
import {
  AccountOwnerEventDraftSchema,
  type AccountOwnerEventDraft,
  type AccountOwnerEvent,
} from './account-owner-events.schema';

/** A process-local presentation journal; it never owns or retries account mutations. */
export class AccountOwnerEventJournal {
  private readonly events: AccountOwnerEvent[] = [];
  private sequence = 0;
  private epoch = randomUUID();
  constructor(private readonly capacity = 128) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 128) {
      throw new Error('Invalid owner event capacity');
    }
  }

  publish(event: AccountOwnerEventDraft): void {
    // Account/model metadata comes from external files or provider data; constrain it here.
    const bounded = AccountOwnerEventDraftSchema.safeParse(event);
    if (!bounded.success) {
      logger.warn('Owner presentation event rejected');
      return;
    }
    if (this.sequence === Number.MAX_SAFE_INTEGER) {
      this.events.length = 0;
      this.sequence = 0;
      this.epoch = randomUUID();
    }
    this.events.push({ sequence: ++this.sequence, event: bounded.data });
    if (this.events.length > this.capacity) {
      this.events.shift();
      logger.warn('Owner presentation journal overflow; oldest event dropped');
    }
  }

  read(epoch: string | undefined, after: number) {
    const cursor = epoch === this.epoch ? after : 0;
    return {
      epoch: this.epoch,
      latest: this.sequence,
      events: this.events.filter((item) => item.sequence > cursor).slice(0, 32),
    };
  }
}

export const accountOwnerEvents = new AccountOwnerEventJournal();

import { logger } from '@/shared/logging/logger';
import {
  AccountOwnerEventBatchSchema,
  type AccountOwnerEventDraft,
} from '../services/account-owner-events.schema';
import { CloudAccountViewSchema, type CloudAccountView } from '../services/cloud-account-view';
import { z } from 'zod';
import { presentAccountOwnerEvent } from './cloud-monitor-desktop-effects';

export interface AccountOwnerEventPumpDependencies {
  readEvents(epoch: string | undefined, after: number): Promise<unknown>;
  listViews(): Promise<unknown>;
  present(event: AccountOwnerEventDraft, views: CloudAccountView[]): void;
}

/** Best-effort remote presentation, with no account-mutation or embedded fallback path. */
export class AccountOwnerEventPump {
  private epoch: string | undefined;
  private cursor = 0;
  private stopped = true;
  private timer: NodeJS.Timeout | null = null;
  private active: Promise<void> | null = null;
  constructor(private readonly dependencies: AccountOwnerEventPumpDependencies) {}

  start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    this.tick();
  }
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
  async drain(): Promise<void> {
    await this.active;
  }

  async poll(): Promise<void> {
    if (this.stopped) {
      return;
    }
    if (this.active) {
      return this.active;
    }
    const work = this.readAndPresent();
    this.active = work;
    try {
      await work;
    } finally {
      if (this.active === work) {
        this.active = null;
      }
    }
  }
  private tick(): void {
    void this.poll()
      .catch(() => {
        logger.warn('Owner event transport unavailable');
      })
      .finally(() => {
        if (!this.stopped) {
          this.timer = setTimeout(() => this.tick(), 2000);
          this.timer.unref();
        }
      });
  }
  private async readAndPresent(): Promise<void> {
    const batch = AccountOwnerEventBatchSchema.parse(
      await this.dependencies.readEvents(this.epoch, this.cursor),
    );
    if (this.stopped) {
      return;
    }
    const epochChanged = this.epoch !== batch.epoch;
    const cursor = epochChanged ? 0 : this.cursor;
    const events = batch.events
      .filter((item) => item.sequence > cursor)
      .sort((a, b) => a.sequence - b.sequence);
    const views =
      events.length > 0
        ? z.array(CloudAccountViewSchema).parse(await this.dependencies.listViews())
        : [];
    if (this.stopped) {
      return;
    }
    if (epochChanged) {
      this.epoch = batch.epoch;
      this.cursor = 0;
    }
    for (const item of events) {
      if (item.sequence <= this.cursor) {
        continue;
      }
      this.cursor = item.sequence;
      try {
        this.dependencies.present(item.event, views);
      } catch {
        logger.warn('Owner presentation effect failed');
      }
    }
  }
}

export function createAccountOwnerEventPump(client: {
  readAccountOwnerEvents(epoch: string | undefined, after: number): Promise<unknown>;
  accountViews(): Promise<unknown>;
}): AccountOwnerEventPump {
  return new AccountOwnerEventPump({
    readEvents: (epoch, after) => client.readAccountOwnerEvents(epoch, after),
    listViews: () => client.accountViews(),
    present: presentAccountOwnerEvent,
  });
}

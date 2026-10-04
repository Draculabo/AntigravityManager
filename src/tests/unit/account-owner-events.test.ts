import { describe, expect, it } from 'vitest';
import { AccountOwnerEventJournal } from '@/modules/cloud-account/services/account-owner-events.service';
import {
  AccountOwnerEventBatchSchema,
  AccountOwnerEventReadInputSchema,
  type AccountOwnerEventDraft,
} from '@/modules/cloud-account/services/account-owner-events.schema';

const event: AccountOwnerEventDraft = {
  kind: 'account-switched',
  accountId: 'account-1',
  target: 'agy',
  reason: 'auto',
};

describe('bounded owner presentation journal', () => {
  it('drops oldest hints while keeping monotonic cursors and bounded pages', () => {
    const journal = new AccountOwnerEventJournal(2);
    for (let i = 0; i < 3; i++) {
      journal.publish(event);
    }
    const batch = journal.read(undefined, 0);
    expect(AccountOwnerEventBatchSchema.parse(batch)).toEqual({
      epoch: batch.epoch,
      latest: 3,
      events: [
        { sequence: 2, event },
        { sequence: 3, event },
      ],
    });
    expect(journal.read(batch.epoch, 3)).toEqual({ epoch: batch.epoch, latest: 3, events: [] });
    expect(journal.read('11111111-1111-4111-8111-111111111111', 999).events).toEqual(batch.events);
    const pages = new AccountOwnerEventJournal();
    for (let i = 0; i < 40; i++) {
      pages.publish(event);
    }
    const first = pages.read(undefined, 0);
    expect(first.events).toHaveLength(32);
    expect(pages.read(first.epoch, 32).events.map((item) => item.sequence)).toEqual([
      33, 34, 35, 36, 37, 38, 39, 40,
    ]);
    expect(new AccountOwnerEventJournal().read(undefined, 0).epoch).not.toBe(batch.epoch);
  });
  it('rejects secret-bearing, unknown and oversized hints without changing journal state', () => {
    const journal = new AccountOwnerEventJournal();
    for (const invalid of [
      { ...event, access_token: 'secret' },
      { ...event, accountId: 'C:/private-path' },
      { kind: 'future', accountId: 'account-1' },
      {
        kind: 'low-quota',
        accountId: 'account-1',
        language: 'en',
        models: ['http://proxy.example'],
      },
      {
        kind: 'low-quota',
        accountId: 'account-1',
        language: 'en',
        models: Array(17).fill('gemini'),
      },
      { kind: 'low-ai-credit', accountId: 'account-1', language: 'en', credits: Infinity },
    ]) {
      journal.publish(invalid as never);
    }
    expect(journal.read(undefined, 0)).toMatchObject({ latest: 0, events: [] });
    journal.publish(event);
    expect(journal.read(undefined, 0).events).toEqual([{ sequence: 1, event }]);
  });
  it('fails closed on malformed private batches and cursors', () => {
    const journal = new AccountOwnerEventJournal();
    journal.publish(event);
    const batch = journal.read(undefined, 0);
    expect(
      AccountOwnerEventBatchSchema.safeParse({ ...batch, events: Array(33).fill(batch.events[0]) })
        .success,
    ).toBe(false);
    expect(AccountOwnerEventBatchSchema.safeParse({ ...batch, latest: 0 }).success).toBe(false);
    expect(
      AccountOwnerEventReadInputSchema.safeParse({ epoch: batch.epoch, after: -1 }).success,
    ).toBe(false);
    expect(AccountOwnerEventReadInputSchema.safeParse({ after: 0, token: 'secret' }).success).toBe(
      false,
    );
  });
});

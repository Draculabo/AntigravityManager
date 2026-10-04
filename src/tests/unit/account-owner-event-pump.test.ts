import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountOwnerEventPump } from '@/modules/cloud-account/ipc/account-owner-event-pump';
import { presentAccountOwnerEvent } from '@/modules/cloud-account/ipc/cloud-monitor-desktop-effects';
import type { AccountOwnerEventBatch } from '@/modules/cloud-account/services/account-owner-events.schema';
import type { CloudAccountView } from '@/modules/cloud-account/services/cloud-account-view';

const effects = vi.hoisted(() => ({
  notifications: [] as Array<{ title: string; body: string; silent?: boolean }>,
  show: vi.fn(),
  tray: vi.fn(),
}));
vi.mock('electron', () => ({
  Notification: class {
    constructor(options: { title: string; body: string; silent?: boolean }) {
      effects.notifications.push(options);
    }
    show() {
      effects.show();
    }
  },
}));
vi.mock('@/modules/app-shell/ipc/tray/handler', () => ({ updateTrayMenu: effects.tray }));
const view: CloudAccountView = {
  id: 'account-1',
  provider: 'google',
  email: 'owner@example.com',
  quota: { models: { 'gemini-pro': { percentage: 5, resetTime: '', display_name: 'Gemini Pro' } } },
  created_at: 1,
  last_used: 1,
  proxy_configured: false,
};
const epoch = '11111111-1111-4111-8111-111111111111';
const batch: AccountOwnerEventBatch = {
  epoch,
  latest: 3,
  events: [
    {
      sequence: 1,
      event: { kind: 'low-quota', accountId: view.id, language: 'en', models: ['gemini-pro'] },
    },
    {
      sequence: 2,
      event: { kind: 'low-ai-credit', accountId: view.id, language: 'en', credits: 10 },
    },
    {
      sequence: 3,
      event: { kind: 'account-switched', accountId: view.id, target: 'agy', reason: 'auto' },
    },
  ],
};
let pump: AccountOwnerEventPump | null;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  effects.notifications.length = 0;
});
afterEach(async () => {
  pump?.stop();
  await pump?.drain();
  pump = null;
  vi.useRealTimers();
});

describe('desktop owner event pump', () => {
  it('uses current active state for the tray when a historical switch hint arrives', () => {
    const active = { ...view, id: 'account-2', email: 'active@example.com', is_active: true };
    presentAccountOwnerEvent(batch.events[2].event, [view, active]);
    expect(effects.tray).toHaveBeenCalledExactlyOnceWith(active);
    expect(effects.notifications[0].body).toContain(view.email);
  });
  it('uses strict owner views to render notifications/tray and suppresses duplicate batches', async () => {
    const readEvents = vi.fn(async () => batch);
    const listViews = vi.fn(async () => [view]);
    pump = new AccountOwnerEventPump({ readEvents, listViews, present: presentAccountOwnerEvent });
    pump.start();
    await pump.poll();
    expect(effects.notifications).toEqual([
      {
        title: 'Low Quota Alert',
        body: 'owner@example.com: Gemini Pro are low on quota',
        silent: false,
      },
      {
        title: 'Low AI Credits Alert',
        body: 'owner@example.com: AI credits balance is low (10)',
        silent: false,
      },
      {
        title: 'Antigravity Manager: Auto-Switch',
        body: 'Switched account to owner@example.com due to quota limit. Reopen IDE and type "continue" if needed!',
      },
    ]);
    expect(effects.tray).toHaveBeenCalledExactlyOnceWith(view);
    await pump.poll();
    expect(readEvents).toHaveBeenLastCalledWith(epoch, 3);
    expect(listViews).toHaveBeenCalledOnce();
    expect(effects.show).toHaveBeenCalledTimes(3);
  });
  it('resets the cursor for a new owner epoch without replaying old events', async () => {
    const readEvents = vi.fn(async () => batch);
    const present = vi.fn();
    pump = new AccountOwnerEventPump({ readEvents, listViews: async () => [view], present });
    pump.start();
    await pump.poll();
    const nextEpoch = '22222222-2222-4222-8222-222222222222';
    readEvents.mockResolvedValue({
      epoch: nextEpoch,
      latest: 1,
      events: [{ sequence: 1, event: batch.events[1].event }],
    });
    await pump.poll();
    await pump.poll();
    expect(present).toHaveBeenCalledTimes(4);
    expect(readEvents).toHaveBeenLastCalledWith(nextEpoch, 1);
  });
  it('advances the cursor after a presentation failure without retrying owner work', async () => {
    const present = vi.fn(() => {
      throw new Error('Notification unavailable');
    });
    pump = new AccountOwnerEventPump({
      readEvents: async () => batch,
      listViews: async () => [view],
      present,
    });
    pump.start();
    await pump.poll();
    await pump.poll();
    expect(present).toHaveBeenCalledTimes(3);
  });
  it('rejects malformed event and view transport without presenting or using local state', async () => {
    const readEvents = vi.fn(
      async (): Promise<unknown> => ({
        ...batch,
        events: [{ sequence: 1, event: { kind: 'future', token: 'secret' } }],
      }),
    );
    const listViews = vi.fn(async () => [view]);
    const present = vi.fn();
    pump = new AccountOwnerEventPump({ readEvents, listViews, present });
    pump.start();
    await expect(pump.poll()).rejects.toThrow();
    expect(listViews).not.toHaveBeenCalled();
    expect(present).not.toHaveBeenCalled();
    readEvents.mockResolvedValue(batch);
    listViews.mockResolvedValue([{ ...view, token: 'secret' }] as never);
    await expect(pump.poll()).rejects.toThrow();
    expect(present).not.toHaveBeenCalled();
  });
  it('stops polling and suppresses presentation from an in-flight response during shutdown', async () => {
    let complete: (batch: AccountOwnerEventBatch) => void = () => {};
    const readEvents = vi.fn(
      () =>
        new Promise<AccountOwnerEventBatch>((resolve) => {
          complete = resolve;
        }),
    );
    const listViews = vi.fn(async () => [view]);
    const present = vi.fn();
    pump = new AccountOwnerEventPump({ readEvents, listViews, present });
    pump.start();
    pump.stop();
    complete(batch);
    await pump.drain();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(readEvents).toHaveBeenCalledOnce();
    expect(listViews).not.toHaveBeenCalled();
    expect(present).not.toHaveBeenCalled();
  });
  it('does not present or fetch local views after a remote transport failure', async () => {
    const listViews = vi.fn(async () => [view]);
    const present = vi.fn();
    pump = new AccountOwnerEventPump({
      readEvents: async () => {
        throw new Error('Core unavailable');
      },
      listViews,
      present,
    });
    pump.start();
    await expect(pump.poll()).rejects.toThrow('Core unavailable');
    pump.stop();
    expect(listViews).not.toHaveBeenCalled();
    expect(present).not.toHaveBeenCalled();
  });
});

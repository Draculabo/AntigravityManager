import { describe, expect, it } from 'vitest';

import {
  MediaWindowLimitError,
  planMediaSendWindow,
} from '@/server/gateway/common/media-send-window';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';

const config = {
  ...DEFAULT_APP_CONFIG.proxy.image_scheduler,
  per_account_concurrency: DEFAULT_APP_CONFIG.proxy.image_scheduler.per_account_concurrency,
  send_window_enabled: true,
  send_window_strategy: 'count' as const,
  send_window_count: 10,
  send_window_memory_mib: 32,
  send_window_strip_remote_urls: false,
};

const inline = (bytes: number, protectedItem = false) => ({
  inline: true,
  bytes,
  protected: protectedItem,
});

const remote = (protectedItem = false) => ({ inline: false, bytes: 0, protected: protectedItem });

describe('shared media send window', () => {
  it('is disabled by default and returns an empty omission set', () => {
    const plan = planMediaSendWindow([inline(1000), inline(1000)], undefined);
    expect(plan.omitted.size).toBe(0);
  });

  it('protects every current image while the newest-N count trims only history', () => {
    const plan = planMediaSendWindow(
      [inline(1000), inline(2000), inline(3000, true), inline(4000, true)],
      { ...config, send_window_count: 1 },
    );
    expect([...plan.omitted]).toEqual([0, 1]);
    expect(plan.protectedBytes).toBe(7000);
  });

  it('keeps the newest historical inline images and never measures remote bytes', () => {
    const plan = planMediaSendWindow(
      [inline(1000), remote(), inline(1000), inline(1000), inline(1000)],
      { ...config, send_window_count: 2 },
    );
    expect([...plan.omitted]).toEqual([0, 2]);
  });

  it('keeps a newest-first decoded-byte suffix within the memory budget', () => {
    const plan = planMediaSendWindow([inline(20), inline(30), inline(40)], {
      ...config,
      send_window_strategy: 'memory',
      send_window_memory_mib: 0.00004,
      send_window_count: 0,
    });
    expect([...plan.omitted]).toEqual([0, 1]);
  });

  it('rejects when the protected current turn alone exceeds the memory budget', () => {
    expect(() =>
      planMediaSendWindow([inline(1024 * 1024 + 1, true)], {
        ...config,
        send_window_strategy: 'memory',
        send_window_memory_mib: 1,
      }),
    ).toThrow(MediaWindowLimitError);
  });

  it('counts historical remote images only when explicitly enabled', () => {
    const kept = planMediaSendWindow([remote()], config);
    expect(kept.omitted.size).toBe(0);
    const stripped = planMediaSendWindow([remote(), inline(1, true)], {
      ...config,
      send_window_count: 1,
      send_window_strip_remote_urls: true,
    });
    expect([...stripped.omitted]).toEqual([0]);
  });

  it('does not combine the count strategy with the memory soft budget', () => {
    const plan = planMediaSendWindow([inline(2 * 1024 * 1024), inline(2 * 1024 * 1024, true)], {
      ...config,
      send_window_count: 0,
      send_window_memory_mib: 1,
    });
    expect([...plan.omitted]).toEqual([]);
    expect(plan.selectedBytes).toBe(4 * 1024 * 1024);
  });

  it('keeps current remote images and selects only the newest counted history', () => {
    const plan = planMediaSendWindow([remote(), inline(1), remote(true)], {
      ...config,
      send_window_count: 2,
      send_window_strip_remote_urls: true,
    });
    expect([...plan.omitted]).toEqual([0]);
  });

  it('uses memory independently from count and keeps unmeasured remote URLs', () => {
    const plan = planMediaSendWindow([inline(1), inline(1), remote(), remote(true)], {
      ...config,
      send_window_strategy: 'memory',
      send_window_count: 1,
      send_window_strip_remote_urls: true,
    });
    expect([...plan.omitted]).toEqual([]);
  });

  it('is idempotent once an omitted slot is no longer a recognized image record', () => {
    const first = planMediaSendWindow([inline(1000), inline(1000)], {
      ...config,
      send_window_count: 1,
    });
    expect([...first.omitted]).toEqual([0]);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatAccountLastUsed } from '@/modules/cloud-account/utils/format-last-used';

describe('account last-used time', () => {
  afterEach(() => vi.useRealTimers());

  it('follows the current language and falls back to English for an unsupported locale', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-05T00:00:00Z'));
    const timestamp = Date.now() / 1000 - 120;
    expect({
      chinese: formatAccountLastUsed(timestamp, 'zh-CN'),
      english: formatAccountLastUsed(timestamp, 'en-US'),
      unsupported: formatAccountLastUsed(timestamp, 'other'),
    }).toEqual({ chinese: '2 分钟前', english: '2 minutes ago', unsupported: '2 minutes ago' });
  });
});

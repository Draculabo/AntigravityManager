import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudAccountSettingsStore } from '@/modules/cloud-account/persistence/cloud-account-settings-store';

const fixture = vi.hoisted(() => ({ get: vi.fn(), close: vi.fn() }));
vi.mock('@/modules/cloud-account/persistence/cloud-account-db', () => ({
  getCloudDb: () => ({
    raw: { close: fixture.close },
    orm: { select: () => ({ from: () => ({ where: () => ({ get: fixture.get }) }) }) },
  }),
}));
vi.mock('@/shared/logging/logger');
beforeEach(() => vi.resetAllMocks());

describe('strict settings read boundary', () => {
  it('returns undefined only for an absent row and closes its connection', () => {
    fixture.get.mockReturnValue(undefined);
    expect(CloudAccountSettingsStore.readSetting('weekly_warmup_history')).toBeUndefined();
    expect(fixture.close).toHaveBeenCalledOnce();
  });
  it('decodes the complete persisted value', () => {
    const config = { enabled: true, groups: ['claude'] };
    fixture.get.mockReturnValue({ value: JSON.stringify(config) });
    expect(CloudAccountSettingsStore.readSetting('weekly_warmup_config')).toEqual(config);
    expect(fixture.close).toHaveBeenCalledOnce();
  });
  it.each(['corrupt JSON', 'query failure'])(
    'propagates %s and still closes its connection',
    (failure) => {
      if (failure === 'corrupt JSON') {
        fixture.get.mockReturnValue({ value: '{broken-json' });
      } else {
        fixture.get.mockImplementation(() => {
          throw new Error('read failed');
        });
      }
      expect(() => CloudAccountSettingsStore.readSetting('weekly_warmup_history')).toThrow();
      expect(fixture.close).toHaveBeenCalledOnce();
    },
  );
});

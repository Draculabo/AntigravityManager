import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  autoSwitchEnabled: true,
  getAccounts: vi.fn(async () => []),
  getSetting: vi.fn((key: string, defaultValue: unknown) => {
    return key === 'auto_switch_enabled' ? mocks.autoSwitchEnabled : defaultValue;
  }),
  checkAndSwitchIfNeeded: vi.fn(async () => false),
}));

vi.mock('electron', () => ({
  Notification: class Notification {
    show() {}
  },
}));

vi.mock('@/modules/cloud-account/persistence/cloudHandler', () => ({
  CloudAccountRepo: {
    getAccounts: mocks.getAccounts,
  },
}));

vi.mock('@/modules/cloud-account/persistence/cloud-account-settings-store', () => ({
  CloudAccountSettingsStore: {
    getSetting: mocks.getSetting,
  },
}));

vi.mock('@/modules/cloud-account/services/GoogleAPIService', () => ({
  GoogleAPIService: {
    normalizeRefreshedOAuthClientKey: vi.fn(),
  },
}));

vi.mock('@/modules/cloud-account/services/AutoSwitchService', () => ({
  AutoSwitchService: {
    checkAndSwitchIfNeeded: mocks.checkAndSwitchIfNeeded,
  },
}));

vi.mock('@/shared/logging/logger', () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('@/modules/cloud-account/utils/account-status', () => ({
  classifyAccountStatusFromError: vi.fn(() => null),
}));

import { CloudMonitorService } from '@/modules/cloud-account/services/CloudMonitorService';

describe('CloudMonitorService runtime auto-switch toggles', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.autoSwitchEnabled = true;
    mocks.getAccounts.mockClear();
    mocks.getSetting.mockClear();
    mocks.checkAndSwitchIfNeeded.mockClear();
    CloudMonitorService.resetStateForTesting();
  });

  afterEach(() => {
    CloudMonitorService.resetStateForTesting();
    vi.useRealTimers();
  });

  it('starts recurring monitoring when an enabled setting triggers an immediate poll', async () => {
    await CloudMonitorService.poll();

    expect(mocks.getAccounts).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(mocks.getAccounts).toHaveBeenCalledTimes(2);
  });

  it('stops the recurring timer after auto-switch is disabled at runtime', async () => {
    await CloudMonitorService.poll();
    expect(mocks.getAccounts).toHaveBeenCalledTimes(1);

    mocks.autoSwitchEnabled = false;
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(mocks.getAccounts).toHaveBeenCalledTimes(1);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const startup = vi.hoisted(() => ({
  calls: [] as string[],
  conversionError: null as Error | null,
}));

vi.mock('@/shared/security/electron-security-runtime', () => ({
  configureElectronSecurityRuntime: () => {
    startup.calls.push('configure');
  },
}));

vi.mock('@/modules/cloud-account/persistence/cloudHandler', () => ({
  CloudAccountRepo: {
    init: async () => {
      startup.calls.push('initialize-accounts');
      if (startup.conversionError) {
        throw startup.conversionError;
      }
    },
  },
}));

beforeEach(() => {
  startup.calls = [];
  startup.conversionError = null;
});

describe('desktop account storage startup', () => {
  it('configures old key providers before checking account rows', async () => {
    const { initializeDesktopAccountSecurity } =
      await import('@/modules/app-shell/services/account-security-startup');

    await initializeDesktopAccountSecurity();

    expect(startup.calls).toEqual(['configure', 'initialize-accounts']);
  });

  it('propagates a failed old-account conversion', async () => {
    const { initializeDesktopAccountSecurity } =
      await import('@/modules/app-shell/services/account-security-startup');
    startup.conversionError = new Error('Old account conversion failed');

    await expect(initializeDesktopAccountSecurity()).rejects.toThrow(
      'Old account conversion failed',
    );

    expect(startup.calls).toEqual(['configure', 'initialize-accounts']);
  });
});

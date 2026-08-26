import { describe, expect, it } from 'vitest';
import { CloudAccountExportSchema } from '@/modules/cloud-account/types';

const validProfile = {
  machineId: 'machine-id',
  macMachineId: 'mac-machine-id',
  devDeviceId: 'device-id',
  sqmId: 'sqm-id',
};

function createExportAccount(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'google' as const,
    email: 'user@example.com',
    token: {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_in: 3600,
      expiry_timestamp: 1_800_000_000,
      token_type: 'Bearer',
    },
    ...overrides,
  };
}

function createExport(accounts: unknown[]) {
  return {
    version: '1.0' as const,
    exportedAt: 1_700_000_000,
    accounts,
  };
}

describe('CloudAccountExportSchema device profile validation', () => {
  it('accepts valid device profile and history entries', () => {
    const result = CloudAccountExportSchema.safeParse(
      createExport([
        createExportAccount({
          device_profile: validProfile,
          device_history: [
            {
              id: 'version-1',
              createdAt: 1_700_000_001,
              label: 'Imported profile',
              profile: validProfile,
              isCurrent: true,
            },
          ],
        }),
      ]),
    );

    expect(result.success).toBe(true);
  });

  it('rejects malformed imported device profiles', () => {
    const result = CloudAccountExportSchema.safeParse(
      createExport([
        createExportAccount({
          device_profile: {
            machineId: 'machine-id',
          },
        }),
      ]),
    );

    expect(result.success).toBe(false);
  });

  it('rejects malformed imported device history entries', () => {
    const result = CloudAccountExportSchema.safeParse(
      createExport([
        createExportAccount({
          device_history: [
            {
              id: 'version-1',
              createdAt: 1_700_000_001,
              label: 'Broken profile',
              profile: { machineId: 'machine-id' },
              isCurrent: true,
            },
          ],
        }),
      ]),
    );

    expect(result.success).toBe(false);
  });
});

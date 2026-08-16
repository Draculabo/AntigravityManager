import { describe, expect, it, vi } from 'vitest';
import { normalizeDeviceHistory } from '@/modules/cloud-account/persistence/cloud-account-device-profile-codec';

const profile = {
  machineId: 'machine-id',
  macMachineId: 'mac-machine-id',
  devDeviceId: 'device-id',
  sqmId: 'sqm-id',
};

describe('cloud account device profile codec', () => {
  it('keeps generated legacy history ids stable across reads', () => {
    const legacyHistory = [
      {
        createdAt: 1_700_000_000,
        label: 'legacy profile',
        profile,
      },
    ];

    const first = normalizeDeviceHistory(legacyHistory);
    const second = normalizeDeviceHistory(legacyHistory);

    expect(first?.[0].id).toMatch(/^legacy-[a-f0-9]{32}$/);
    expect(second?.[0].id).toBe(first?.[0].id);
  });

  it('does not use the current clock when deriving a legacy history id', () => {
    const legacyHistory = [{ profile }];
    const now = vi.spyOn(Date, 'now');

    now.mockReturnValue(1_700_000_000_000);
    const first = normalizeDeviceHistory(legacyHistory);

    now.mockReturnValue(1_800_000_000_000);
    const second = normalizeDeviceHistory(legacyHistory);

    expect(second?.[0].id).toBe(first?.[0].id);
    now.mockRestore();
  });

  it('preserves explicit ids and distinguishes duplicate legacy entries', () => {
    const normalized = normalizeDeviceHistory([
      { id: 'persisted-id', profile },
      { profile },
      { profile },
    ]);

    expect(normalized?.[0].id).toBe('persisted-id');
    expect(normalized?.[1].id).not.toBe(normalized?.[2].id);
  });
});

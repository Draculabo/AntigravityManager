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

  it('does not use the current clock when normalizing a legacy history entry', () => {
    const legacyHistory = [{ profile }];
    const now = vi.spyOn(Date, 'now');

    now.mockReturnValue(1_700_000_000_000);
    const first = normalizeDeviceHistory(legacyHistory);

    now.mockReturnValue(1_800_000_000_000);
    const second = normalizeDeviceHistory(legacyHistory);

    expect(second).toEqual(first);
    expect(first?.[0].createdAt).toBe(0);
    now.mockRestore();
  });

  it('keeps generated legacy history ids stable when distinct entries are reordered', () => {
    const firstEntry = {
      createdAt: 1_700_000_000,
      label: 'first legacy profile',
      profile,
    };
    const secondEntry = {
      createdAt: 1_700_000_100,
      label: 'second legacy profile',
      profile: {
        ...profile,
        machineId: 'second-machine-id',
      },
    };

    const initial = normalizeDeviceHistory([firstEntry, secondEntry]);
    const reordered = normalizeDeviceHistory([secondEntry, firstEntry]);

    expect(reordered?.find((entry) => entry.label === firstEntry.label)?.id).toBe(
      initial?.find((entry) => entry.label === firstEntry.label)?.id,
    );
    expect(reordered?.find((entry) => entry.label === secondEntry.label)?.id).toBe(
      initial?.find((entry) => entry.label === secondEntry.label)?.id,
    );
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

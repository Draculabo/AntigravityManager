import { describe, expect, it, vi } from 'vitest';
import { startOwnedCore } from '@/core/owned-startup';
import { ProfileOwnershipError } from '@/core/ownership/profile-lease';

describe('standalone core profile ownership startup', () => {
  it('does not open management or persistence when the desktop owns the profile', async () => {
    const management = { start: vi.fn() };
    const core = { start: vi.fn() };
    const onManagementReady = vi.fn();
    const lease = {
      acquire: async () => {
        throw new ProfileOwnershipError({ version: 1, kind: 'desktop', pid: 456 });
      },
    };

    await expect(startOwnedCore({ lease, management, core, onManagementReady })).rejects.toThrow(
      'desktop process 456',
    );
    expect(management.start).not.toHaveBeenCalled();
    expect(core.start).not.toHaveBeenCalled();
    expect(onManagementReady).not.toHaveBeenCalled();
  });

  it('starts management and persistence only after acquiring the lease', async () => {
    const events: string[] = [];
    await startOwnedCore({
      lease: {
        acquire: async () => {
          events.push('lease');
        },
      },
      management: {
        start: async () => {
          events.push('management');
        },
      },
      onManagementReady: () => {
        events.push('signal');
      },
      core: {
        start: async () => {
          events.push('core');
        },
      },
    });
    expect(events).toEqual(['lease', 'management', 'signal', 'core']);
  });
});

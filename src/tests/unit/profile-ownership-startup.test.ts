import { describe, expect, it, vi } from 'vitest';
import { initializeOwnedDesktopProfile } from '@/modules/app-shell/services/profile-ownership-startup';
import { ProfileOwnershipError } from '@/core/ownership/profile-lease';

describe('desktop profile ownership startup', () => {
  it('does not initialize persistence when the core owns the profile', async () => {
    const initialize = vi.fn();
    const close = vi.fn();
    const lease = {
      acquire: async () => {
        throw new ProfileOwnershipError({ version: 1, kind: 'core', pid: 456 });
      },
      close,
    };

    await expect(initializeOwnedDesktopProfile(lease, initialize)).rejects.toThrow(
      'core process 456',
    );
    expect(initialize).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it('releases ownership when desktop initialization fails', async () => {
    const error = new Error('database unavailable');
    const close = vi.fn().mockResolvedValue(undefined);
    const lease = { acquire: vi.fn().mockResolvedValue(undefined), close };
    const initialize = vi.fn().mockRejectedValue(error);

    await expect(initializeOwnedDesktopProfile(lease, initialize)).rejects.toBe(error);
    expect(lease.acquire).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});

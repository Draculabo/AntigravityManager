import type { ProfileLease } from '@/core/ownership/profile-lease';

/** Acquire the cross-runtime profile lease before any persistence work. */
export async function initializeOwnedDesktopProfile<T>(
  lease: Pick<ProfileLease, 'acquire' | 'close'>,
  initialize: () => Promise<T>,
): Promise<T> {
  await lease.acquire();
  try {
    return await initialize();
  } catch (error) {
    await lease.close();
    throw error;
  }
}

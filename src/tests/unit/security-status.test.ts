import { describe, expect, it } from 'vitest';
import { normalizeSecurityStatus } from '@/shared/security/security-status';

describe('normalizeSecurityStatus', () => {
  it('marks Linux basic_text safeStorage as degraded', () => {
    expect(
      normalizeSecurityStatus(
        { state: 'secure', masterKeySource: 'safeStorage' },
        { platform: 'linux', safeStorageBackend: 'basic_text' },
      ),
    ).toEqual({ state: 'degraded', masterKeySource: 'safeStorage' });
  });

  it('keeps protected Linux safeStorage backends secure', () => {
    expect(
      normalizeSecurityStatus(
        { state: 'secure', masterKeySource: 'safeStorage' },
        { platform: 'linux', safeStorageBackend: 'gnome_libsecret' },
      ),
    ).toEqual({ state: 'secure', masterKeySource: 'safeStorage' });
  });

  it('does not downgrade non-Linux safeStorage', () => {
    expect(
      normalizeSecurityStatus(
        { state: 'secure', masterKeySource: 'safeStorage' },
        { platform: 'darwin', safeStorageBackend: 'basic_text' },
      ),
    ).toEqual({ state: 'secure', masterKeySource: 'safeStorage' });
  });

  it('preserves already degraded compatibility storage', () => {
    expect(
      normalizeSecurityStatus(
        { state: 'degraded', masterKeySource: 'file' },
        { platform: 'linux', safeStorageBackend: 'basic_text' },
      ),
    ).toEqual({ state: 'degraded', masterKeySource: 'file' });
  });
});

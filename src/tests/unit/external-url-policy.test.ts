import { describe, expect, it } from 'vitest';
import { isTrustedExternalUrl } from '@/modules/app-shell/utils/externalUrlPolicy';

describe('external URL policy', () => {
  it.each([
    'https://github.com/Draculabo/AntigravityManager',
    'https://github.com/Draculabo/AntigravityManager/',
    'https://github.com/Draculabo/AntigravityManager/issues',
    'https://github.com/Draculabo/AntigravityManager/issues/',
    'https://github.com/Draculabo/AntigravityManager/releases/tag/v0.21.1',
  ])('allows an owned GitHub destination: %s', (url) => {
    expect(isTrustedExternalUrl(url)).toBe(true);
  });

  it.each([
    'http://github.com/Draculabo/AntigravityManager',
    'https://github.com/Draculabo/AntigravityManager/issues/322',
    'https://github.com/Draculabo/AntigravityManager.evil.example/issues',
    'https://evil.example/Draculabo/AntigravityManager',
    'not-a-url',
  ])('rejects a destination outside the narrow allowlist: %s', (url) => {
    expect(isTrustedExternalUrl(url)).toBe(false);
  });
});

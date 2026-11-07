import { describe, expect, it } from 'vitest';
import { BUG_REPORT_URL } from '@/modules/app-shell/bug-report';
import { isTrustedExternalUrl } from '@/modules/app-shell/utils/externalUrlPolicy';

describe('external URL policy', () => {
  it('allows the production bug-report URL', () => {
    expect(isTrustedExternalUrl(BUG_REPORT_URL)).toBe(true);
  });

  it.each([
    'https://github.com/Draculabo/AntigravityManager',
    'https://github.com/Draculabo/AntigravityManager/',
    'https://github.com/Draculabo/AntigravityManager/issues',
    'https://github.com/Draculabo/AntigravityManager/issues/',
    'https://github.com/Draculabo/AntigravityManager/releases/tag/v0.21.1',
    'https://github.com/Draculabo/AntigravityManager/issues/new?template=bug_report.md',
    'https://github.com/Draculabo/AntigravityManager/issues/new/?template=bug_report.md',
  ])('allows an owned GitHub destination: %s', (url) => {
    expect(isTrustedExternalUrl(url)).toBe(true);
  });

  it.each([
    'http://github.com/Draculabo/AntigravityManager',
    'https://user:password@github.com/Draculabo/AntigravityManager/issues/new?template=bug_report.md',
    'https://github.com/Draculabo/AntigravityManager/issues/new',
    'https://github.com/Draculabo/AntigravityManager/issues/new?template=bug_report.md#details',
    'https://github.com/Draculabo/AntigravityManager/issues/new?template=bug_report.md&title=bug',
    'https://github.com/Draculabo/AntigravityManager/issues/new?template=bug_report.md&template=bug_report.md',
    'https://github.com/Draculabo/AntigravityManager/issues/new?template=feature_request.md',
    'https://github.com/Draculabo/AntigravityManager/issues%2Fnew?template=bug_report.md',
    'https://github.com/Draculabo/AntigravityManager/issues?template=bug_report.md',
    'https://github.com/Draculabo/AntigravityManager/issues/322?template=bug_report.md',
    'https://github.com/Draculabo/AntigravityManager/issues/322',
    'https://github.com/Draculabo/AntigravityManager.evil.example/issues',
    'https://evil.example/Draculabo/AntigravityManager',
    'not-a-url',
  ])('rejects a destination outside the narrow allowlist: %s', (url) => {
    expect(isTrustedExternalUrl(url)).toBe(false);
  });
});

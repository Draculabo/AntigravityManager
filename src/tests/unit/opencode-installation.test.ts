import { describe, expect, it } from 'vitest';
import { extractOpenCodeVersion } from '@/modules/proxy-gateway/opencode-sync/opencode-installation';

describe('OpenCode installation detection', () => {
  it('extracts a semantic version from CLI output', () => {
    expect(extractOpenCodeVersion('opencode v1.2.3\n')).toBe('1.2.3');
    expect(extractOpenCodeVersion('opencode/0.9.7')).toBe('0.9.7');
    expect(extractOpenCodeVersion('0.9.7-beta.1')).toBe('0.9.7');
  });

  it('returns the unknown fallback for a custom version format', () => {
    expect(extractOpenCodeVersion('\nOpenCode nightly-2026-08-03\n')).toBe('unknown');
    expect(extractOpenCodeVersion('   ')).toBe('unknown');
  });
});

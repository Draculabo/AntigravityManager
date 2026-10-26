import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { enforceThoughtSessionLimits } from '@/modules/proxy-gateway/thought-store/thought-store.service';
import type { ThoughtRecord } from '@/modules/proxy-gateway/thought-store/thought-store.types';

function records(count: number): ThoughtRecord[] {
  return Array.from({ length: count }, (_, id) => ({
    id: id + 1,
    createdAt: id,
    fingerprint: `turn-${id}`,
    model: 'gemini-pro',
    sourceFamily: 'gemini',
    thought: 'thought',
    signature: null,
    partSignatures: [],
    toolIds: [],
    toolNames: [],
    visible: 'reply',
    oversized: false,
    oversizedBytes: null,
    oversizedSha256: null,
  }));
}
describe('independent L1 thought retention', () => {
  it('retains 600 recent small turns by default and up to 10,000 when configured', () => {
    const recent = records(700);
    enforceThoughtSessionLimits(recent, DEFAULT_APP_CONFIG.proxy.thought_store);
    expect(recent.map((record) => record.id)).toEqual(
      Array.from({ length: 600 }, (_, index) => index + 101),
    );
    const expanded = records(10_001);
    enforceThoughtSessionLimits(expanded, { max_turns_per_session: 10_000, max_session_mib: 64 });
    expect(expanded.map((record) => record.id)).toEqual(
      Array.from({ length: 10_000 }, (_, index) => index + 2),
    );
  });
  it('accounts visible text, tool identifiers and fingerprints in the per-session byte limit', () => {
    for (const field of ['visible', 'fingerprint', 'toolIds'] as const) {
      const values = records(2);
      const oversized = 'x'.repeat(1024 * 1024);
      if (field === 'toolIds') {
        values[0].toolIds = [oversized];
      } else {
        values[0][field] = oversized;
      }
      enforceThoughtSessionLimits(values, { max_turns_per_session: 600, max_session_mib: 1 });
      expect(values.map((record) => record.id)).toEqual([2]);
    }
  });
});

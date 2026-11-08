import { afterEach, expect, it, vi } from 'vitest';
import { ThoughtToolRecovery } from '@/modules/proxy-gateway/thought-store/thought-tool-recovery';
import { THOUGHT_TOOL_LINK_TTL_MS } from '@/modules/proxy-gateway/thought-store/thought-tool-links';
import type { ThoughtRecord } from '@/modules/proxy-gateway/thought-store/thought-store.types';

afterEach(() => vi.restoreAllMocks());

it.each(['legacy', 'partial', 'history'] as const)(
  'retains %s diagnostic signatures without automatically recovering unproven tools',
  (captureState) => {
    const recovery = new ThoughtToolRecovery();
    const original = {
      ...record(),
      operationId: null,
      causalAnchor: null,
      completedAt: null,
      captureState,
    };
    const restored = recovery.apply([original], [])[0];
    expect(restored).toEqual({
      ...original,
      partSignatures: original.partSignatures.map((part) =>
        part.kind === 'tool' ? { ...part, signature: null } : part,
      ),
    });
    expect(original.partSignatures[1].signature).toBe('tool');
  },
);

function record(id: string | number = 1): ThoughtRecord {
  return {
    id,
    createdAt: 1,
    fingerprint: 'same',
    thought: 'reasoning',
    visible: 'OK',
    signature: 'root',
    model: 'gemini-pro',
    sourceFamily: 'gemini',
    oversized: false,
    oversizedBytes: null,
    oversizedSha256: null,
    operationId: 'operation',
    causalAnchor: 'a'.repeat(64),
    completedAt: Date.now(),
    captureState: 'complete',
    toolIds: ['call'],
    toolNames: ['read'],
    partSignatures: [
      { kind: 'thought', position: 0, start: 0, end: 9, signature: 'root' },
      {
        kind: 'tool',
        position: 1,
        callId: 'call',
        name: 'read',
        argsDigest: 'b'.repeat(64),
        signature: 'tool',
      },
      {
        kind: 'tool',
        position: 2,
        callId: 'other',
        name: 'read',
        argsDigest: 'c'.repeat(64),
        signature: 'other-tool',
      },
    ],
  };
}

it('honors exact retained positions on warm replay without changing diagnostic content', () => {
  const recovery = new ThoughtToolRecovery();
  const original = record();
  const live = recovery.apply([original], [{ operationId: 'operation', positions: [1, 2] }]);
  expect(live).toEqual([original]);
  const evicted = recovery.apply(live, [{ operationId: 'operation', positions: [2] }]);
  expect(evicted).toEqual([
    {
      ...original,
      partSignatures: [
        original.partSignatures[0],
        { ...original.partSignatures[1], signature: null },
        original.partSignatures[2],
      ],
    },
  ]);
  expect(original.partSignatures[1].signature).toBe('tool');
});

it('denies deleted durable records and unavailable permission reads, preserving thought content', () => {
  const recovery = new ThoughtToolRecovery();
  const original = record();
  const expected = [
    {
      ...original,
      partSignatures: original.partSignatures.map((part) =>
        part.kind === 'tool' ? { ...part, signature: null } : part,
      ),
    },
  ];
  expect(recovery.apply([original], [])).toEqual(expected);
  expect(recovery.apply([original])).toEqual(expected);
});

it('keeps unacknowledged captures when a successful snapshot has no durable row', () => {
  const recovery = new ThoughtToolRecovery();
  const original = record('memory-operation');
  expect(recovery.apply([original], [])).toEqual([original]);
  recovery.markPersisted(original);
  const enriched = { ...original, thought: 'enriched reasoning' };
  recovery.inherit(original, enriched);
  expect(recovery.apply([enriched], [])[0].partSignatures).toEqual(
    original.partSignatures.map((part) =>
      part.kind === 'tool' ? { ...part, signature: null } : part,
    ),
  );
});

it('remembers a persisted memory capture even when its durable row is later absent', () => {
  const recovery = new ThoughtToolRecovery();
  const original = record('memory-operation');
  const hydrated = recovery.apply([original], [{ operationId: 'operation', positions: [1, 2] }]);
  expect(hydrated).toEqual([original]);
  expect(
    recovery
      .apply(hydrated, [])[0]
      .partSignatures.every((part) => part.kind !== 'tool' || part.signature === null),
  ).toBe(true);
});

it('never extends original completion, including memory-only captures and live snapshot rows', () => {
  const recovery = new ThoughtToolRecovery();
  const original = record('memory-operation');
  const now = original.completedAt!;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now + THOUGHT_TOOL_LINK_TTL_MS - 1);
  expect(recovery.apply([original], [])[0]).toEqual(original);
  clock.mockReturnValue(now + THOUGHT_TOOL_LINK_TTL_MS);
  const expired = recovery.apply([original], [{ operationId: 'operation', positions: [1, 2] }])[0];
  expect(expired.completedAt).toBe(now);
  expect(
    expired.partSignatures.every((part) => part.kind !== 'tool' || part.signature === null),
  ).toBe(true);
  expect(expired.signature).toBe('root');
});

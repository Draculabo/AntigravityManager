import { expect, it } from 'vitest';
import { replayableToolPositions } from '@/modules/proxy-gateway/thought-store/thought-tool-link-replay';
import { thoughtToolLayoutDigest } from '@/modules/proxy-gateway/thought-store/thought-tool-layout';
import type { ThoughtToolSignature } from '@/modules/proxy-gateway/thought-store/thought-part-signatures';

const first: ThoughtToolSignature = {
  kind: 'tool',
  position: 0,
  callId: 'call-a',
  name: 'read',
  argsDigest: 'a'.repeat(64),
  signature: 'A',
};
const second: ThoughtToolSignature = { ...first, position: 1, callId: 'call-b', signature: 'B' };

it('binds permissions to tool identity and layout while permitting signature redaction', () => {
  expect(thoughtToolLayoutDigest([first, second])).not.toBe(thoughtToolLayoutDigest([
    { ...first, position: 1 }, { ...second, position: 0 },
  ]));
  expect(thoughtToolLayoutDigest([first])).not.toBe(thoughtToolLayoutDigest([{ ...first, callId: 'other' }]));
  expect(thoughtToolLayoutDigest([first])).toBe(thoughtToolLayoutDigest([{ ...first, signature: null }]));
});

it('keeps evicted references absent while following a live tool across layout changes', () => {
  expect(
    replayableToolPositions(
      [first, second],
      [
        { ...first, position: 5 },
        { ...second, position: 0 },
      ],
      new Set([1]),
    ),
  ).toEqual(new Set([0]));
});

it('allows a missing signed field in a uniquely identified proven round', () => {
  expect(replayableToolPositions([{ ...first, signature: null }], [first], new Set())).toEqual(
    new Set([0]),
  );
});

it('refuses ambiguous missing-ID and parallel claims instead of transferring their permission', () => {
  expect(
    replayableToolPositions([first, second], [{ ...first, callId: null }], new Set([0])),
  ).toEqual(new Set());
  expect(
    replayableToolPositions([{ ...first, callId: null }], [first, second], new Set([0])),
  ).toEqual(new Set());
});

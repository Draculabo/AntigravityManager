import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createUpstreamSessionIdentity,
  withUpstreamSessionIdentity,
} from '@/server/gateway/common/upstream-session-identity';
import type { GeminiInternalRequest } from '@/modules/proxy-gateway/antigravity/types';

afterEach(() => vi.useRealTimers());
describe('upstream conversation identity', () => {
  it('retains stable session and conversation identities while separating accounts and stores', () => {
    const identity = createUpstreamSessionIdentity('account-a', 'tenant/task-a');
    expect(createUpstreamSessionIdentity('account-a', 'tenant/task-a')).toEqual(identity);
    expect(createUpstreamSessionIdentity('account-b', 'tenant/task-a').sessionId).not.toBe(
      identity.sessionId,
    );
    expect(createUpstreamSessionIdentity('account-b', 'tenant/task-a').conversationId).toBe(
      identity.conversationId,
    );
    expect(createUpstreamSessionIdentity('account-a', 'tenant/task-b').sessionId).not.toBe(
      identity.sessionId,
    );
    expect(createUpstreamSessionIdentity('account-a', 'tenant/task-b').conversationId).not.toBe(
      identity.conversationId,
    );
    const id = BigInt(identity.sessionId);
    expect(id >= -(2n ** 63n) && id < 2n ** 63n).toBe(true);
    expect(JSON.stringify(identity)).not.toMatch(/account-a|tenant|task-a/);
  });
  it('does not collide framed account/store pairs or normalize task punctuation', () => {
    expect(createUpstreamSessionIdentity('a|b', 'c').sessionId).not.toBe(
      createUpstreamSessionIdentity('a', 'b|c').sessionId,
    );
    expect(createUpstreamSessionIdentity('a', 'A').sessionId).not.toBe(
      createUpstreamSessionIdentity('a', 'a').sessionId,
    );
  });
  it('creates a new request ID at the same clock instant without copying or mutating content', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T00:00:00Z'));
    const body: GeminiInternalRequest = {
      model: 'gemini-pro-agent',
      requestId: 'old',
      userAgent: 'test',
      request: { contents: [{ role: 'user', parts: [{ text: 'A'.repeat(1024 * 1024) }] }] },
    };
    const identity = createUpstreamSessionIdentity('a', 'store');
    const first = withUpstreamSessionIdentity(body, identity),
      second = withUpstreamSessionIdentity(body, identity);
    expect(first.requestId).not.toBe(second.requestId);
    expect(first.requestId.split('/').slice(0, 3)).toEqual([
      'agent',
      identity.conversationId,
      String(Date.now()),
    ]);
    expect(first.requestId).toMatch(/^agent\/[a-f0-9]{16}\/\d+\/[a-f0-9]{32}\/0$/);
    expect(first.request.sessionId).toBe(identity.sessionId);
    expect(first.request.contents).toBe(body.request.contents);
    expect(body.requestId).toBe('old');
    expect(body.request.sessionId).toBeUndefined();
  });
});

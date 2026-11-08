import { afterEach, expect, it, vi } from 'vitest';
import { SignatureStore } from '@/modules/proxy-gateway/antigravity/SignatureStore';

const model = 'gemini-3-flash';
const HOUR = 60 * 60 * 1000;
afterEach(() => {
  SignatureStore.clear();
  vi.useRealTimers();
});

it('bounds all message slots in one active session and preserves its most recent captures', () => {
  vi.useFakeTimers();
  for (let messageCount = 0; messageCount <= 10_000; messageCount += 1) {
    vi.setSystemTime(messageCount);
    SignatureStore.store({
      model,
      sessionKey: 'large',
      messageCount,
      signature: `signature-${messageCount}`,
    });
  }
  expect(SignatureStore.getAt({ model, sessionKey: 'large', messageCount: 0 })).toBeNull();
  expect(SignatureStore.getAt({ model, sessionKey: 'large', messageCount: 10_000 })).toBe(
    'signature-10000',
  );
  expect(SignatureStore.clearThoughtSession()).toEqual({ removed: 10_000, unknown: 0 });
}, 30_000);

it('uses one association budget across message, legacy and tool-ID indexes', () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  SignatureStore.store({ model, sessionKey: 'legacy', signature: 'legacy' });
  for (let messageCount = 1; messageCount <= 5_001; messageCount += 1) {
    vi.setSystemTime(messageCount);
    SignatureStore.store({
      model,
      sessionKey: 'tools',
      messageCount,
      toolCallId: `tool-${messageCount}`,
      toolName: 'read',
      signature: `signature-${messageCount}`,
    });
  }
  expect(SignatureStore.get({ model, sessionKey: 'legacy' })).toBeNull();
  expect(
    SignatureStore.getForToolCall({
      model,
      sessionKey: 'tools',
      toolCallId: 'tool-5001',
      toolName: 'read',
    }),
  ).toBe('signature-5001');
  expect(SignatureStore.clearThoughtSession()).toEqual({ removed: 10_000, unknown: 0 });
}, 30_000);

it.each(['message', 'tool', 'legacy'] as const)(
  'expires %s associations at the original capture boundary after reads and equivalent stores',
  (kind) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const options = {
      model,
      sessionKey: 'scope',
      signature: 'opaque',
      ...(kind !== 'legacy' ? { messageCount: 2 } : {}),
      ...(kind === 'tool' ? { toolCallId: 'tool', toolName: 'read' } : {}),
    };
    const read = () =>
      kind === 'tool'
        ? SignatureStore.getForToolCall({ ...options, toolCallId: 'tool' })
        : kind === 'message'
          ? SignatureStore.getAt({ ...options, messageCount: 2 })
          : SignatureStore.get(options);
    SignatureStore.store(options);
    vi.setSystemTime(HOUR - 2);
    expect(read()).toBe('opaque');
    SignatureStore.store(options);
    vi.setSystemTime(HOUR - 1);
    expect(read()).toBe('opaque');
    vi.setSystemTime(HOUR);
    expect(read()).toBeNull();
    expect(SignatureStore.get(options)).toBeNull();
  },
);

it('does not make an expired message live again when a newer slot keeps its session active', () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  SignatureStore.store({ model, sessionKey: 'scope', messageCount: 1, signature: 'old' });
  vi.setSystemTime(HOUR - 1);
  SignatureStore.store({ model, sessionKey: 'scope', messageCount: 2, signature: 'new' });
  vi.setSystemTime(HOUR);
  expect(SignatureStore.getAt({ model, sessionKey: 'scope', messageCount: 1 })).toBeNull();
  expect(SignatureStore.get({ model, sessionKey: 'scope' })).toBe('new');
});

it('expires ambiguity at its original boundary and permits a genuinely later capture', () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const scope = {
    model,
    sessionKey: 'scope',
    messageCount: 1,
    toolCallId: 'tool',
    toolName: 'read',
  };
  SignatureStore.store({ ...scope, signature: 'first' });
  vi.setSystemTime(HOUR - 2);
  SignatureStore.store({ ...scope, signature: 'conflicting' });
  expect(SignatureStore.getForToolCall(scope)).toBeNull();
  vi.setSystemTime(HOUR - 1);
  SignatureStore.store({ ...scope, signature: 'conflicting' });
  expect(SignatureStore.getAt(scope)).toBeNull();
  vi.setSystemTime(HOUR);
  expect(SignatureStore.clearThoughtSession('unrelated')).toEqual({ removed: 0, unknown: 0 });
  SignatureStore.store({ ...scope, signature: 'new-capture' });
  expect(SignatureStore.getForToolCall(scope)).toBe('new-capture');
  expect(SignatureStore.getAt(scope)).toBe('new-capture');
});

import { afterEach, expect, it } from 'vitest';
import { SignatureStore } from '@/modules/proxy-gateway/antigravity/SignatureStore';
import {
  runWithTrafficAuditRequestContext,
  type TrafficAuditRequestContext,
} from '@/modules/proxy-gateway/audit/traffic-audit-context';
import { thoughtCaptureLeases } from '@/modules/proxy-gateway/thought-store/thought-capture-leases';
const contexts: TrafficAuditRequestContext[] = [];
function owned(key: string, work: () => void) {
  const context: TrafficAuditRequestContext = {
    attemptSequence: 0,
    parent: null,
    thoughtSessionKey: key,
    thoughtSessionStable: true,
  };
  contexts.push(context);
  return runWithTrafficAuditRequestContext(context, work);
}
afterEach(() => {
  for (const context of contexts.splice(0)) {
    context.thoughtCaptureLease?.release();
  }
  SignatureStore.clear();
});
const capture = (sessionKey: string, signature: string) =>
  SignatureStore.store({
    model: 'gemini-3-pro-high',
    sessionKey,
    messageCount: 2,
    toolCallId: 'tool',
    toolName: 'read',
    signature,
  });
it('removes only captured Thought ownership while preserving another protocol root and unknown legacy values', () => {
  owned('thought-A', () => capture('protocol-root-A', 'A'));
  owned('thought-B', () => capture('protocol-root-B', 'B'));
  capture('legacy-root', 'legacy');
  expect(SignatureStore.clearThoughtSession('thought-A')).toEqual({ removed: 2, unknown: 2 });
  expect(
    SignatureStore.getForToolCall({
      model: 'gemini-3-pro-high',
      sessionKey: 'protocol-root-A',
      toolCallId: 'tool',
      toolName: 'read',
    }),
  ).toBeNull();
  expect(
    SignatureStore.getForToolCall({
      model: 'gemini-3-pro-high',
      sessionKey: 'protocol-root-B',
      toolCallId: 'tool',
      toolName: 'read',
    }),
  ).toBe('B');
  expect(
    SignatureStore.getForToolCall({
      model: 'gemini-3-pro-high',
      sessionKey: 'legacy-root',
      toolCallId: 'tool',
      toolName: 'read',
    }),
  ).toBe('legacy');
});
it('prevents a revoked old mapper context from reading or republishing signatures after deletion', () => {
  owned('thought-A', () => capture('protocol-root-A', 'A'));
  const context = contexts[0];
  const release = thoughtCaptureLeases.block('thought-A');
  try {
    SignatureStore.clearThoughtSession('thought-A');
    runWithTrafficAuditRequestContext(context, () => {
      capture('protocol-root-A', 'late');
      expect(
        SignatureStore.get({ model: 'gemini-3-pro-high', sessionKey: 'protocol-root-A' }),
      ).toBeNull();
    });
  } finally {
    release();
  }
  expect(
    SignatureStore.get({ model: 'gemini-3-pro-high', sessionKey: 'protocol-root-A' }),
  ).toBeNull();
  owned('thought-A', () => capture('protocol-root-A', 'fresh'));
  expect(SignatureStore.get({ model: 'gemini-3-pro-high', sessionKey: 'protocol-root-A' })).toBe(
    'fresh',
  );
});

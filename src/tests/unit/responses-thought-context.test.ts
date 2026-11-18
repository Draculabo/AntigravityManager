import { expect, it } from 'vitest';
import { ResponsesThoughtContext } from '@/server/gateway/modules/openai/responses/responses-thought-context';
import { OpenAIResponsesWebSocketProtocol } from '@/server/gateway/modules/openai/responses/openai-responses-websocket.protocol';
import { deleteResponsesRecoveryScope } from '@/server/gateway/modules/openai/responses/responses-thought-recovery';
import {
  captureCurrentAuditSession,
  getTrafficAuditRequestContext,
} from '@/modules/proxy-gateway/audit/traffic-audit-context';
import { thoughtCaptureLeases } from '@/modules/proxy-gateway/thought-store/thought-capture-leases';
import { resolveOpenAISessionScope } from '@/server/gateway/common/signature-session-scope';
import { createThoughtSessionKey } from '@/modules/proxy-gateway/audit/traffic-audit-http-metadata';
const noDurableRows = async () => ({ removed: 0, unknown: 0 });
const payload = { type: 'response.create', model: 'fixture', input: [] };

it('does not reinstall a transcript when asynchronous schema admission finishes after clear or disconnect', async () => {
  const baseline = thoughtCaptureLeases.protectedKeys();
  for (const mode of ['clear', 'disconnect']) {
    let ready!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const protocol = new OpenAIResponsesWebSocketProtocol(async () => {
      ready();
      await gate;
    });
    const owner = new ResponsesThoughtContext(protocol);
    const running = owner.run(payload, { headers: { 'x-session-id': 'client-A' } }, () =>
      protocol.accept(payload),
    );
    const outcome = expect(running).rejects.toThrow('Responses history was invalidated');
    await entered;
    const release = thoughtCaptureLeases.block(createThoughtSessionKey({}, 'client-A'));
    try {
      if (mode === 'clear') {
        await deleteResponsesRecoveryScope(undefined, noDurableRows);
      } else {
        owner.dispose();
      }
      resume();
      await outcome;
      expect(protocol.hasHistory()).toBe(false);
    } finally {
      resume();
      release();
      owner.dispose();
    }
  }
  expect(thoughtCaptureLeases.protectedKeys()).toEqual(baseline);
  expect(await deleteResponsesRecoveryScope(undefined, noDurableRows)).toEqual({
    removed: 0,
    unknown: 0,
  });
});

it('keeps the protocol-proven hint-free scope between frames and forgets it after exact invalidation', async () => {
  const protocol = new OpenAIResponsesWebSocketProtocol();
  const owner = new ResponsesThoughtContext(protocol);
  const scope = resolveOpenAISessionScope(
    { model: 'fixture', messages: [{ role: 'user', content: 'business input' }] },
    {},
  );
  try {
    await owner.run(payload, { headers: {} }, async () => {
      await protocol.accept(payload);
      captureCurrentAuditSession(scope);
      expect(getTrafficAuditRequestContext()?.thoughtSessionKey).toBe(scope.storeKey);
    });
    await owner.run({ type: 'response.append', input: [] }, { headers: {} }, async () => {
      expect(getTrafficAuditRequestContext()?.thoughtSessionKey).toBe(scope.storeKey);
    });
    expect(await deleteResponsesRecoveryScope(scope.storeKey, noDurableRows)).toEqual({
      removed: 1,
      unknown: 0,
    });
    await owner.run(payload, { headers: {} }, async () => {
      expect(getTrafficAuditRequestContext()?.thoughtSessionKey).not.toBe(scope.storeKey);
      await protocol.accept(payload);
    });
  } finally {
    owner.dispose();
  }
});

it('never merges a different explicit client into the connection transcript', async () => {
  const protocol = new OpenAIResponsesWebSocketProtocol();
  const owner = new ResponsesThoughtContext(protocol);
  try {
    await owner.run({ ...payload, session_id: 'first' }, { headers: {} }, async () => {
      await protocol.accept({ ...payload, input: [{ role: 'user', content: 'first input' }] });
      protocol.complete({ id: 'old', output: [{ role: 'assistant', content: 'first output' }] });
    });
    await owner.run({ ...payload, session_id: 'second' }, { headers: {} }, async () => {
      const action = await protocol.accept({
        ...payload,
        input: [{ role: 'user', content: 'second input' }],
      });
      expect(action).toEqual({
        kind: 'request',
        request: {
          model: 'fixture',
          input: [{ role: 'user', content: 'second input' }],
          stream: true,
        },
      });
    });
  } finally {
    owner.dispose();
  }
});

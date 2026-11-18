import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SqliteWorkerCommand } from '@/shared/persistence/sqlite-worker/bounded-sqlite-worker';
import type { TrafficAuditRequestContext } from '@/modules/proxy-gateway/audit/traffic-audit-context';
const state = vi.hoisted(() => ({
  directory: '',
  request: vi.fn<(command: SqliteWorkerCommand) => Promise<unknown>>(),
}));
vi.mock('@/shared/platform/paths', () => ({ getProxyStateDir: () => state.directory }));
vi.mock('@/shared/persistence/sqlite-worker/bounded-sqlite-worker', () => ({
  BoundedSqliteWorker: class {
    start() {}
    request = state.request;
    drainAdmitted = async () => {};
    close = async () => {};
    getStats() {
      return { alive: true, pendingBytes: 0, pendingCommands: 0 };
    }
  },
}));
import { ThoughtStoreService } from '@/modules/proxy-gateway/thought-store/thought-store.service';
import { SignatureStore } from '@/modules/proxy-gateway/antigravity/SignatureStore';
import { OpenAIResponsesSessionService } from '@/server/gateway/modules/openai/responses/openai-responses-session.service';
import { OpenAIResponsesSessionStoreImpl } from '@/server/gateway/modules/openai/responses/openai-responses-session.store';
import { runWithTrafficAuditRequestContext } from '@/modules/proxy-gateway/audit/traffic-audit-context';
import { responsesIdentityFixture } from './responses-identity.fixture';
let thoughts: ThoughtStoreService;
let responses: OpenAIResponsesSessionService;
const contexts: TrafficAuditRequestContext[] = [];
const signatureInput = (key: string) => ({
  model: 'gemini-3-pro-high',
  sessionKey: key,
  messageCount: 2,
  signature: key,
});
function owned<T>(key: string, work: () => T): T {
  const context: TrafficAuditRequestContext = {
    attemptSequence: 0,
    parent: null,
    thoughtSessionKey: key,
    thoughtSessionStable: true,
  };
  contexts.push(context);
  return runWithTrafficAuditRequestContext(context, work);
}
function save(key: string) {
  owned(key, () => {
    SignatureStore.store(signatureInput(key));
    responses.save(key, {
      identity: responsesIdentityFixture,
      model: 'gemini-pro',
      inputItems: [],
    });
  });
}
beforeEach(async () => {
  state.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-joint-thought-'));
  state.request.mockReset().mockResolvedValue({ sessions: 1, records: 3 });
  thoughts = new ThoughtStoreService();
  responses = new OpenAIResponsesSessionService({
    filePath: path.join(state.directory, 'responses.json'),
  });
  responses.onModuleInit();
  save('client-A');
  save('client-B');
  await responses.flush();
});
afterEach(async () => {
  await thoughts.shutdown();
  responses.onModuleDestroy();
  await responses.flush();
  SignatureStore.clear();
  for (const context of contexts.splice(0)) {
    context.thoughtCaptureLease?.release();
  }
  vi.restoreAllMocks();
  expect(path.dirname(path.resolve(state.directory))).toBe(path.resolve(os.tmpdir()));
  expect(path.basename(state.directory).startsWith('agm-joint-thought-')).toBe(true);
  await fs.rm(state.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});
it('runs the registered owners after confirmed SQLite deletion and reopens the exact JSON result', async () => {
  state.request.mockImplementationOnce(async (command) => {
    expect(command).toEqual({ operation: 'deleteSession', payload: { sessionKey: 'client-A' } });
    expect(responses.get('client-A')).not.toBeNull();
    expect(SignatureStore.get(signatureInput('client-A'))).toBe('client-A');
    expect(contexts[0].thoughtCaptureLease?.valid).toBe(false);
    return { sessions: 1, records: 3 };
  });
  expect(await thoughts.deleteSession('client-A')).toEqual({
    sessions: 1,
    records: 3,
    recoveryComplete: true,
    recovery: [
      { owner: 'signature-cache', state: 'complete', removed: 1, unknown: 0 },
      { owner: 'responses', state: 'complete', removed: 1, unknown: 0 },
    ],
  });
  const reopened = new OpenAIResponsesSessionStoreImpl({
    filePath: path.join(state.directory, 'responses.json'),
  });
  expect(reopened.get('client-A')).toBeNull();
  expect(reopened.get('client-B')?.thoughtSessionKey).toBe('client-B');
  expect(SignatureStore.get(signatureInput('client-A'))).toBeNull();
  expect(SignatureStore.get(signatureInput('client-B'))).toBe('client-B');
  await reopened.flush();
});
it('preserves peers on SQLite failure while keeping the old request revoked', async () => {
  state.request.mockRejectedValueOnce(new Error('synthetic SQLite refusal'));
  await expect(thoughts.deleteSession('client-A')).rejects.toThrow('synthetic SQLite refusal');
  expect(responses.get('client-A')).not.toBeNull();
  expect(SignatureStore.get(signatureInput('client-A'))).toBe('client-A');
  expect(contexts[0].thoughtCaptureLease?.valid).toBe(false);
});
it('reports a real JSON replacement failure after confirmed SQLite deletion without retry', async () => {
  const rename = vi.spyOn(fs, 'rename').mockRejectedValue(new Error('synthetic JSON refusal'));
  const receipt = await thoughts.deleteSession('client-A');
  expect(receipt).toEqual({
    sessions: 1,
    records: 3,
    recoveryComplete: false,
    recovery: [
      { owner: 'signature-cache', state: 'complete', removed: 1, unknown: 0 },
      { owner: 'responses', state: 'failed', removed: 0, unknown: 0 },
    ],
  });
  expect(state.request).toHaveBeenCalledTimes(1);
  const reopened = new OpenAIResponsesSessionStoreImpl({
    filePath: path.join(state.directory, 'responses.json'),
  });
  expect(reopened.get('client-A')).not.toBeNull();
  rename.mockRestore();
  await reopened.flush();
});
it('keeps Responses and signatures when ending, maintaining or closing Thought history', async () => {
  await thoughts.endSession('client-A');
  state.request.mockResolvedValue({
    removedSessions: 1,
    invalidatedSessions: ['client-A'],
    moreWorkPending: false,
  });
  const { DEFAULT_APP_CONFIG } = await import('@/modules/config/types');
  await thoughts.configure(DEFAULT_APP_CONFIG.proxy.thought_store);
  await thoughts.close();
  expect(responses.get('client-A')).not.toBeNull();
  expect(SignatureStore.get(signatureInput('client-A'))).toBe('client-A');
});

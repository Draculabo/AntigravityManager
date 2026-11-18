import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OpenAIResponsesSessionStoreImpl } from '@/server/gateway/modules/openai/responses/openai-responses-session.store';
import {
  runWithTrafficAuditRequestContext,
  type TrafficAuditRequestContext,
} from '@/modules/proxy-gateway/audit/traffic-audit-context';
import { thoughtCaptureLeases } from '@/modules/proxy-gateway/thought-store/thought-capture-leases';
import { responsesIdentityFixture } from './responses-identity.fixture';
const contexts: TrafficAuditRequestContext[] = [];
let directory: string;
let store: OpenAIResponsesSessionStoreImpl;
let filePath: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-thought-peer-'));
  filePath = path.join(directory, 'responses.json');
  store = new OpenAIResponsesSessionStoreImpl({ filePath });
});
afterEach(async () => {
  await store.flush();
  vi.restoreAllMocks();
  for (const context of contexts.splice(0)) {
    context.thoughtCaptureLease?.release();
  }
  expect(path.dirname(path.resolve(directory))).toBe(path.resolve(os.tmpdir()));
  expect(path.basename(directory).startsWith('agm-thought-peer-')).toBe(true);
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
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
const session = {
  identity: responsesIdentityFixture,
  model: 'gemini-pro',
  inputItems: [{ role: 'user', content: 'fixture' }],
};

it('retains exact captured ownership across reopen and deletes only that client and its descendants', async () => {
  owned('client-A', () => store.save('root-A', session));
  owned('client-B', () => store.save('root-B', session));
  store.save('unknown-root', session);
  const parent = store.getWithParent('root-A')!.parent;
  owned('client-different-entry', () =>
    store.saveDelta('child-A', {
      identity: responsesIdentityFixture,
      model: 'gemini-pro',
      inputDelta: [],
      responseOutput: [{ role: 'assistant', content: 'child' }],
      parent,
    }),
  );
  await store.flush();
  const privateCopy = path.join(directory, 'before-delete.json');
  await fs.copyFile(filePath, privateCopy);
  const reopened = new OpenAIResponsesSessionStoreImpl({ filePath });
  expect(reopened.get('child-A')?.thoughtSessionKey).toBe('client-A');
  expect(await reopened.deleteThoughtSession('client-A')).toEqual({ removed: 2, unknown: 1 });
  const final = new OpenAIResponsesSessionStoreImpl({ filePath });
  expect(final.get('root-A')).toBeNull();
  expect(final.get('child-A')).toBeNull();
  expect(final.get('root-B')?.thoughtSessionKey).toBe('client-B');
  expect(final.get('unknown-root')).not.toBeNull();
  await final.flush();
  // Offline restoration replaces the file only after every fixture writer has settled.
  await fs.copyFile(privateCopy, filePath);
  const restored = new OpenAIResponsesSessionStoreImpl({ filePath });
  expect(restored.get('root-A')?.thoughtSessionKey).toBe('client-A');
  expect(restored.get('child-A')?.thoughtSessionKey).toBe('client-A');
  expect(restored.get('root-B')?.thoughtSessionKey).toBe('client-B');
  expect(restored.get('unknown-root')).not.toBeNull();
  await restored.flush();
});

it('revokes retained parents and rejects foreign-store capabilities without deleting neighboring history', async () => {
  owned('client-A', () => store.save('root-A', session));
  owned('client-B', () => store.save('root-B', session));
  const parent = store.getWithParent('root-A')!.parent;
  const other = new OpenAIResponsesSessionStoreImpl();
  const delta = {
    identity: responsesIdentityFixture,
    model: 'gemini-pro',
    inputDelta: [],
    responseOutput: [],
    parent,
  };
  expect(() => other.saveDelta('foreign', delta)).toThrow(
    'Invalid OpenAI Responses session parent',
  );
  await store.deleteThoughtSession('client-A');
  expect(() => store.saveDelta('late', delta)).toThrow('Responses history parent was invalidated');
  expect(store.get('root-B')).not.toBeNull();
});

it('does not republish history from a revoked request and permits a fresh later request', async () => {
  owned('client-A', () => store.save('root-A', session));
  const context = contexts[0];
  const release = thoughtCaptureLeases.block('client-A');
  try {
    await store.deleteThoughtSession('client-A');
    runWithTrafficAuditRequestContext(context, () => store.save('late', session));
  } finally {
    release();
  }
  expect(store.get('late')).toBeNull();
  owned('client-A', () => store.save('fresh', session));
  expect(store.get('fresh')).not.toBeNull();
});

it('reports strict replacement failure rather than claiming durable deletion', async () => {
  owned('client-A', () => store.save('root-A', session));
  await store.flush();
  const rename = vi
    .spyOn(fs, 'rename')
    .mockRejectedValue(new Error('synthetic replacement failure'));
  await expect(store.deleteThoughtSession('client-A')).rejects.toThrow(
    'synthetic replacement failure',
  );
  expect(store.get('root-A')).toBeNull();
  const reopened = new OpenAIResponsesSessionStoreImpl({ filePath });
  expect(reopened.get('root-A')).not.toBeNull();
  rename.mockRestore();
  await reopened.flush();
});

it('does not publish a media-backed save admitted before its request lease was revoked', async () => {
  owned('client-A', () => store.save('root-A', session));
  const context = contexts[0];
  let started!: () => void;
  let finish!: () => void;
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  vi.spyOn(store, 'storeInputMedia').mockImplementationOnce(async (items) => {
    started();
    await gate;
    return items;
  });
  const saving = runWithTrafficAuditRequestContext(context, () =>
    store.saveDeltaWithMedia('late-child', {
      identity: responsesIdentityFixture,
      model: 'gemini-pro',
      inputDelta: [{ role: 'user', content: 'next' }],
      responseOutput: [],
    }),
  );
  await reading;
  const release = thoughtCaptureLeases.block('client-A');
  try {
    await store.deleteThoughtSession('client-A');
    finish();
    await saving;
  } finally {
    finish();
    release();
  }
  const reopened = new OpenAIResponsesSessionStoreImpl({ filePath });
  expect(reopened.get('root-A')).toBeNull();
  expect(reopened.get('late-child')).toBeNull();
});

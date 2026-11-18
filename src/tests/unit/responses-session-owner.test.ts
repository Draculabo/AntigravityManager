import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ directory: '' }));
vi.mock('@/shared/platform/paths', () => ({ getProxyStateDir: () => state.directory }));
vi.mock('@/shared/persistence/durable-store-settings', async (load) => ({
  ...(await load<object>()),
  isDurableStoreTestEnvironment: () => false,
}));
import { ResponsesSessionOwner } from '@/server/gateway/modules/openai/responses/responses-session-owner';
import { OpenAIResponsesSessionStoreImpl } from '@/server/gateway/modules/openai/responses/openai-responses-session.store';
import { FileContentStore } from '@/server/gateway/modules/files/file-content-store.service';
import { FilesService } from '@/server/gateway/modules/files/files.service';
import { invalidateThoughtRecoveryPeers } from '@/modules/proxy-gateway/thought-store/thought-recovery-peers';
import { responsesIdentityFixture } from './responses-identity.fixture';
let filePath: string;
const owners: ResponsesSessionOwner[] = [];
const files: FileContentStore[] = [];
beforeEach(async () => {
  state.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-responses-owner-'));
  filePath = path.join(state.directory, 'responses.json');
});
afterEach(async () => {
  await Promise.allSettled(owners.splice(0).map((owner) => owner.shutdown()));
  for (const file of files.splice(0)) {
    file.onModuleDestroy();
  }
  vi.restoreAllMocks();
  expect(path.dirname(path.resolve(state.directory))).toBe(path.resolve(os.tmpdir()));
  expect(path.basename(state.directory).startsWith('agm-responses-owner-')).toBe(true);
  await fs.rm(state.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});
const session = (key: string) => ({
  identity: responsesIdentityFixture,
  thoughtSessionKey: key,
  model: 'fixture',
  inputItems: [{ role: 'user', content: key }],
});
function create() {
  const options = vi.fn(() => ({ filePath }));
  const owner = new ResponsesSessionOwner(options);
  owners.push(owner);
  return { owner, options };
}
function createFiles() {
  const store = new FileContentStore({
    rootDirectory: path.join(state.directory, 'public-files'),
    sweepIntervalMs: 0,
  });
  files.push(store);
  return new FilesService(store);
}

it('deletes exact persisted history before any gateway starts without eager profile access or another writer', async () => {
  const writer = new OpenAIResponsesSessionStoreImpl({ filePath });
  writer.save('A', session('A'));
  writer.save('B', session('B'));
  await writer.flushStrict();
  const { owner, options } = create();
  expect(options).not.toHaveBeenCalled();
  const receipt = await invalidateThoughtRecoveryPeers('A');
  expect(receipt.recovery.find((effect) => effect.owner === 'responses')).toEqual({
    owner: 'responses',
    state: 'complete',
    removed: 1,
    unknown: 0,
  });
  expect(options).toHaveBeenCalledOnce();
  const cache = owner.get();
  expect(cache.get('A')).toBeNull();
  expect(cache.get('B')?.thoughtSessionKey).toBe('B');
  cache.onModuleInit();
  cache.onModuleDestroy();
  expect(owner.get()).toBe(cache);
  expect(await cache.deleteThoughtSession('B')).toEqual({ removed: 1, unknown: 0 });
  const reopened = new OpenAIResponsesSessionStoreImpl({ filePath });
  expect(reopened.get('A')).toBeNull();
  expect(reopened.get('B')).toBeNull();
});

it('reuses the same metadata instance across gateway restart while replacing and disposing private media owners', async () => {
  const { owner, options } = create();
  const cache = owner.get(createFiles());
  cache.onModuleInit();
  const firstMedia = cache.getMediaStore();
  if (!firstMedia) {
    throw new Error('Expected first gateway media facade');
  }
  const dispose = vi.spyOn(firstMedia, 'dispose');
  await cache.saveDeltaWithMedia('A', {
    identity: responsesIdentityFixture,
    thoughtSessionKey: 'A',
    model: 'fixture',
    inputDelta: [
      { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AQ==' }] },
    ],
    responseOutput: [],
  });
  cache.save('B', session('B'));
  await cache.flushStrict();
  cache.onModuleDestroy();
  expect(dispose).toHaveBeenCalledOnce();
  expect(cache.getMediaStore()).toBeUndefined();
  const receipt = await invalidateThoughtRecoveryPeers('A');
  expect(receipt.recovery.find((effect) => effect.owner === 'responses')?.state).toBe('complete');
  const restarted = owner.get(createFiles());
  expect(restarted).toBe(cache);
  expect(options).toHaveBeenCalledOnce();
  expect(restarted.getMediaStore()).not.toBe(firstMedia);
  expect(restarted.get('A')).toBeNull();
  expect(restarted.get('B')?.thoughtSessionKey).toBe('B');
  restarted.save('C', session('C'));
  await restarted.flushStrict();
  const reopened = new OpenAIResponsesSessionStoreImpl({ filePath });
  expect(reopened.get('A')).toBeNull();
  expect(reopened.get('B')).not.toBeNull();
  expect(reopened.get('C')).not.toBeNull();
  await reopened.flushStrict();
});

it('strictly reports terminal JSON failure, closes admission and never creates a replacement owner', async () => {
  const { owner, options } = create();
  owner.get().save('A', session('A'));
  vi.spyOn(fs, 'rename').mockRejectedValue(new Error('synthetic terminal write failure'));
  const closing = owner.shutdown();
  expect(owner.shutdown()).toBe(closing);
  await expect(closing).rejects.toThrow('synthetic terminal write failure');
  expect(() => owner.get()).toThrow('Responses history owner is closed');
  expect(options).toHaveBeenCalledOnce();
  const receipt = await invalidateThoughtRecoveryPeers('A');
  expect(receipt.recovery.find((effect) => effect.owner === 'responses')?.state).toBe(
    'unavailable',
  );
});

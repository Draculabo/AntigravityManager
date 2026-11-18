import fs from 'node:fs';
import { responsesIdentityFixture } from './responses-identity.fixture';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decodeResponsesHistoryOwner,
  getOwnedResponsesHistory,
  resolveResponsesHistoryOwner,
} from '@/server/gateway/modules/openai/responses/responses-history-owner';
import { OpenAIResponsesSessionStoreImpl } from '@/server/gateway/modules/openai/responses/openai-responses-session.store';
import {
  OPENAI_RESPONSES_SESSION_FILENAME,
  OpenAIResponsesSessionService,
} from '@/server/gateway/modules/openai/responses/openai-responses-session.service';

const a = resolveResponsesHistoryOwner({ authorization: 'Bearer synthetic-owner-a' });
const b = resolveResponsesHistoryOwner({ 'x-api-key': 'synthetic-owner-b' });
const folders: string[] = [];
const stores: OpenAIResponsesSessionStoreImpl[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.flush()));
  vi.restoreAllMocks();
  for (const folder of folders.splice(0)) {
    if (
      path.dirname(path.resolve(folder)) !== path.resolve(os.tmpdir()) ||
      !path.basename(folder).startsWith('agm-owner-')
    ) {
      throw new Error('Unsafe owner fixture cleanup');
    }
    fs.rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
function fixture(options: ConstructorParameters<typeof OpenAIResponsesSessionStoreImpl>[0] = {}) {
  const store = new OpenAIResponsesSessionStoreImpl(options);
  stores.push(store);
  return store;
}
function directory() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-owner-'));
  folders.push(folder);
  return folder;
}
const session = {
  identity: responsesIdentityFixture,
  model: 'gemini-3-flash',
  inputItems: [{ role: 'user', content: 'A private synthetic task' }],
};

describe('Responses history caller ownership without encryption', () => {
  it('canonicalizes existing credential presentations and keeps anonymous distinct', () => {
    expect(resolveResponsesHistoryOwner({ 'x-api-key': 'synthetic-owner-a' })).toBe(a);
    expect(resolveResponsesHistoryOwner({ 'x-goog-api-key': 'synthetic-owner-a' })).toBe(a);
    expect(a).not.toBe(b);
    expect(resolveResponsesHistoryOwner()).not.toBe(
      resolveResponsesHistoryOwner({ 'x-api-key': 'anonymous' }),
    );
    expect(
      [undefined, 'unknown', null, 'sha256-v1:broken'].map(decodeResponsesHistoryOwner),
    ).toEqual(['unknown', 'unknown', null, null]);
  });

  it('retains unowned records as unknown without allowing a first reader to claim them', () => {
    const store = fixture();
    store.save('resp_old', session);
    expect(store.getHistoryOwner('resp_old')).toBe('unknown');
    for (const owner of [a, b, resolveResponsesHistoryOwner(), 'unknown'] as const) {
      expect(getOwnedResponsesHistory(store, 'resp_old', owner)).toBeNull();
    }
    expect(store.get('resp_old')?.inputItems).toEqual(session.inputItems);
    expect(store.getHistoryOwner('resp_old')).toBe('unknown');
  });

  it('checks ownership before materializing or renewing retention and eviction order', () => {
    let now = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const store = fixture({ ttlMs: 100, maxSessions: 2 });
    store.save('resp_a', { ...session, historyOwner: a });
    now = 1010;
    store.save('resp_b', { ...session, historyOwner: b });
    now = 1090;
    const read = vi.spyOn(store, 'getWithParent');
    expect(getOwnedResponsesHistory(store, 'resp_a', b)).toBeNull();
    expect(read).not.toHaveBeenCalled();
    store.save('resp_c', { ...session, historyOwner: b });
    expect(store.getHistoryOwner('resp_a')).toBeNull();
    now = 1109;
    expect(getOwnedResponsesHistory(store, 'resp_b', a)).toBeNull();
    now = 1110;
    expect(getOwnedResponsesHistory(store, 'resp_b', b)).toBeNull();
  });

  it('rejects a parent from another owner and retains the original branch', () => {
    const store = fixture();
    store.save('resp_a', { ...session, historyOwner: a });
    const root = getOwnedResponsesHistory(store, 'resp_a', a);
    if (!root) {
      throw new Error('Missing owned fixture');
    }
    const delta = {
      identity: responsesIdentityFixture,
      inputDelta: [{ role: 'user', content: 'Continue' }],
      responseOutput: [],
      model: session.model,
      parent: root.parent,
    };
    expect(() => store.saveDelta('resp_wrong', { ...delta, historyOwner: b })).toThrow(
      'ownership mismatch',
    );
    expect(store.get('resp_wrong')).toBeNull();
    store.saveDelta('resp_child', { ...delta, historyOwner: a });
    expect(getOwnedResponsesHistory(store, 'resp_child', b)).toBeNull();
    expect(getOwnedResponsesHistory(store, 'resp_child', a)?.session.inputItems).toEqual([
      ...session.inputItems,
      ...delta.inputDelta,
    ]);
  });

  it('replaces unsupported active history and persists new owned branches in plaintext', async () => {
    const folder = directory();
    const filePath = path.join(folder, OPENAI_RESPONSES_SESSION_FILENAME);
    const legacy = JSON.stringify({
      version: 1,
      entries: [{ key: 'resp_legacy', updatedAt: Date.now(), value: session }],
    });
    fs.writeFileSync(filePath, legacy);
    const writer = new OpenAIResponsesSessionService({ filePath });
    stores.push(writer);
    writer.save('resp_a', { ...session, historyOwner: a, response: { id: 'resp_a', output: [] } });
    await writer.flush();
    const text = fs.readFileSync(filePath, 'utf8');
    expect(text).toContain('A private synthetic task');
    expect(text).toContain(a);
    expect(text).not.toContain('synthetic-owner-a');
    const restarted = fixture({ filePath });
    expect(getOwnedResponsesHistory(restarted, 'resp_a', b)).toBeNull();
    expect(getOwnedResponsesHistory(restarted, 'resp_a', a)?.session.response).toEqual({
      id: 'resp_a',
      output: [],
    });
    expect(getOwnedResponsesHistory(restarted, 'resp_legacy', a)).toBeNull();
    const replaced = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(replaced.entries.map((entry: { key: string }) => entry.key)).toEqual(['resp_a']);
    expect(fs.readFileSync(filePath, 'utf8')).not.toBe(legacy);
  });

  it('rejects malformed owner metadata and mixed-owner serialized parent chains', async () => {
    const filePath = path.join(directory(), 'owned.json');
    const writer = fixture({ filePath });
    writer.save('resp_valid', { ...session, historyOwner: a });
    writer.saveDelta('resp_child', {
      identity: responsesIdentityFixture,
      model: session.model,
      historyOwner: a,
      parent: writer.getWithParent('resp_valid')?.parent,
      inputDelta: [],
      responseOutput: [],
    });
    await writer.flush();
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const invalid = structuredClone(raw.entries[0]);
    invalid.key = 'resp_malformed';
    invalid.value.node.historyOwner = 'not-an-owner';
    // Flat fields cannot make an invalid parent graph valid.
    invalid.value.inputItems = session.inputItems;
    invalid.value.model = session.model;
    invalid.value.historyOwner = a;
    const mixed = structuredClone(raw.entries[1]);
    mixed.key = 'resp_mixed';
    mixed.value.node.parent.historyOwner = b;
    raw.entries.push(invalid, mixed);
    fs.writeFileSync(filePath, JSON.stringify(raw));
    const reader = fixture({ filePath });
    expect(reader.getHistoryOwner('resp_malformed')).toBeNull();
    expect(reader.getHistoryOwner('resp_mixed')).toBeNull();
    expect(getOwnedResponsesHistory(reader, 'resp_valid', a)?.session.inputItems).toEqual(
      session.inputItems,
    );
  });
});

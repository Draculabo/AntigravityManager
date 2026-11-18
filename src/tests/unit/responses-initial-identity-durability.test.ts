import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as paths from '@/shared/platform/paths';
import * as settings from '@/shared/persistence/durable-store-settings';
import { OpenAIOperations } from '@/server/gateway/modules/openai/openai-operations.service';
import {
  OpenAIResponsesSessionService,
  OPENAI_RESPONSES_SESSION_FILENAME,
} from '@/server/gateway/modules/openai/responses/openai-responses-session.service';
import { resolveResponsesSessionScope } from '@/server/gateway/common/signature-session-scope';
import { resolveResponsesHistoryOwner } from '@/server/gateway/modules/openai/responses/responses-history-owner';
import {
  createAccount,
  createGateway,
  createLease,
  createUpstream,
} from './proxy-real-path.harness';
import { responsesIdentityFixture } from './responses-identity.fixture';
import { FileContentStore } from '@/server/gateway/modules/files/file-content-store.service';
import { FilesService } from '@/server/gateway/modules/files/files.service';

const headers = { authorization: 'Bearer synthetic-durable-owner' };
const image =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2Z8AAAAASUVORK5CYII=';
let folder: string | undefined;
const stores: OpenAIResponsesSessionService[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) {
    await store.flush();
    store.onModuleDestroy();
  }
  vi.restoreAllMocks();
  if (folder) {
    if (
      path.dirname(path.resolve(folder)) !== path.resolve(os.tmpdir()) ||
      !path.basename(folder).startsWith('agm-initial-identity-')
    ) {
      throw new Error('Unsafe fixture cleanup');
    }
    fs.rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    folder = undefined;
  }
});
function isolatedDefault() {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-initial-identity-'));
  vi.spyOn(paths, 'getProxyStateDir').mockReturnValue(folder);
  vi.spyOn(settings, 'isDurableStoreTestEnvironment').mockReturnValue(false);
  return folder;
}
function createStore() {
  if (!folder) {
    throw new Error('Missing isolated identity fixture directory');
  }
  const store = new OpenAIResponsesSessionService(
    undefined,
    new FilesService(
      new FileContentStore({
        rootDirectory: path.join(folder, 'public-files'),
        sweepIntervalMs: 0,
      }),
    ),
  );
  stores.push(store);
  return store;
}
function operations(store: OpenAIResponsesSessionService) {
  const gateway = createGateway(
    createUpstream({}),
    createLease([createAccount('durable-identity')]),
  );
  return new OpenAIOperations(gateway.openAIService, undefined, undefined, store);
}
describe('Fresh Responses history and restart identity', () => {
  it.each([undefined, 'x'.repeat(129), 'bad\nvalue'])(
    'rejects a client-origin record without a valid routing hint: %j',
    async (routingSessionId) => {
      const directory = isolatedDefault();
      const node = {
        identity: { ...responsesIdentityFixture, origin: 'client' },
        historyOwner: resolveResponsesHistoryOwner(headers),
        routingSessionId,
        parent: null,
        model: 'gemini-3-flash',
        inputDelta: [],
        responseOutput: [],
        toolCallItems: [],
      };
      fs.writeFileSync(
        path.join(directory, OPENAI_RESPONSES_SESSION_FILENAME),
        JSON.stringify({
          version: 1,
          entries: [{ key: 'resp_invalid_hint', updatedAt: Date.now(), value: { node } }],
        }),
      );
      expect(createStore().get('resp_invalid_hint')).toBeNull();
    },
  );
  it.each([false, true])(
    'resets unsupported active records and preserves bounded identity across restart, explicit=%s',
    async (explicit) => {
      const directory = isolatedDefault();
      const activePath = path.join(directory, OPENAI_RESPONSES_SESSION_FILENAME);
      const inactivePath = path.join(directory, 'openai-responses-sessions.v2.json');
      const oldActive = JSON.stringify({
        version: 1,
        entries: [
          {
            key: 'resp_old',
            updatedAt: Date.now(),
            value: {
              historyOwner: resolveResponsesHistoryOwner(headers),
              model: 'gemini-3-flash',
              inputItems: [],
            },
          },
        ],
      });
      const oldInactive = JSON.stringify({
        version: 1,
        entries: [
          {
            key: 'resp_inactive_file',
            updatedAt: Date.now(),
            value: {
              historyOwner: resolveResponsesHistoryOwner(headers),
              model: 'gemini-3-flash',
              inputItems: [],
            },
          },
        ],
      });
      fs.writeFileSync(activePath, oldActive);
      fs.writeFileSync(inactivePath, oldInactive);
      const writer = createStore();
      expect(writer.get('resp_old')).toBeNull();
      expect(writer.get('resp_inactive_file')).toBeNull();
      await writer.flush();
      expect(JSON.parse(fs.readFileSync(activePath, 'utf8')).entries).toEqual([]);
      expect(fs.readFileSync(inactivePath, 'utf8')).toBe(oldInactive);
      const first = await operations(writer).prepareResponsesRequest(
        {
          model: 'gemini-3-flash',
          input: [
            {
              type: 'message',
              role: 'user',
              content: [
                { type: 'input_text', text: 'Describe image' },
                { type: 'input_image', image_url: `data:image/png;base64,${image}` },
              ],
            },
          ],
        },
        { headers: explicit ? { ...headers, 'x-session-id': 'image-task' } : headers },
      );
      if (!first) {
        throw new Error('Expected preparation');
      }
      await writer.saveDeltaWithMedia(first.responseId, {
        ...first.session,
        inputDelta: first.session.inputItems,
        parent: first.parent,
        responseOutput: [{ type: 'message', role: 'assistant', content: 'Answer' }],
        routingSessionId: first.routingSessionId,
      });
      await writer.flush();
      const serialized = fs.readFileSync(
        path.join(directory, OPENAI_RESPONSES_SESSION_FILENAME),
        'utf8',
      );
      expect(serialized).toContain(first.session.identity.initialTaskFingerprint);
      expect(serialized).toContain('__agm_responses_media_reference');
      expect(serialized).not.toContain(image);
      expect(serialized).not.toContain('synthetic-durable-owner');
      const restarted = createStore();
      const restored = await operations(restarted).prepareResponsesRequest(
        { previous_response_id: first.responseId, input: 'Continue' },
        { headers },
      );
      if (!restored) {
        throw new Error('Expected owned restoration');
      }
      expect(restored.session.identity).toEqual(first.session.identity);
      expect(restored.routingSessionId).toBe(first.routingSessionId);
      expect(JSON.stringify(restored.request.messages)).toContain(image);
      expect(
        resolveResponsesSessionScope(
          restored.request,
          restored.routingSessionId,
          headers,
          undefined,
          restored.session.identity,
        ),
      ).toEqual(
        resolveResponsesSessionScope(
          first.request,
          first.routingSessionId,
          headers,
          undefined,
          first.session.identity,
        ),
      );
      expect(
        await operations(restarted).prepareResponsesRequest(
          { previous_response_id: 'resp_old', input: 'Continue' },
          { headers },
        ),
      ).toBeNull();
      expect(
        await operations(restarted).prepareResponsesRequest(
          { previous_response_id: first.responseId, input: 'Continue' },
          { headers: { authorization: 'Bearer other-owner' } },
        ),
      ).toBeNull();
      await restarted.flush();
      expect(
        JSON.parse(fs.readFileSync(activePath, 'utf8')).entries.map(
          (entry: { key: string }) => entry.key,
        ),
      ).toEqual([first.responseId]);
      expect(fs.readFileSync(inactivePath, 'utf8')).toBe(oldInactive);
    },
  );
  it.each([
    undefined,
    { ...responsesIdentityFixture, version: 2 },
    { ...responsesIdentityFixture, origin: 'unknown' },
    { ...responsesIdentityFixture, initialTaskFingerprint: 'short' },
  ])(
    'rejects invalid metadata in the active file without falling back to an older file: %j',
    async (identity) => {
      const directory = isolatedDefault();
      const node = {
        identity,
        historyOwner: resolveResponsesHistoryOwner(headers),
        parent: null,
        model: 'gemini-3-flash',
        inputDelta: [],
        responseOutput: [],
        toolCallItems: [],
        routingSessionId: 'root',
      };
      const old = JSON.stringify({
        version: 1,
        entries: [
          {
            key: 'resp_invalid',
            updatedAt: Date.now(),
            value: { node: { ...node, identity: responsesIdentityFixture } },
          },
        ],
      });
      fs.writeFileSync(path.join(directory, 'openai-responses-sessions.v2.json'), old);
      fs.writeFileSync(
        path.join(directory, OPENAI_RESPONSES_SESSION_FILENAME),
        JSON.stringify({
          version: 1,
          entries: [{ key: 'resp_invalid', updatedAt: Date.now(), value: { node } }],
        }),
      );
      const store = createStore();
      expect(store.get('resp_invalid')).toBeNull();
      expect(
        await operations(store).prepareResponsesRequest(
          { previous_response_id: 'resp_invalid', input: 'Continue' },
          { headers },
        ),
      ).toBeNull();
      await store.flush();
      expect(
        fs.readFileSync(path.join(directory, 'openai-responses-sessions.v2.json'), 'utf8'),
      ).toBe(old);
    },
  );
});

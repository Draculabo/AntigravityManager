import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileContentStore } from '@/server/gateway/modules/files/file-content-store.service';
import { FilesService } from '@/server/gateway/modules/files/files.service';
import { OpenAIResponsesMediaStore } from '@/server/gateway/modules/openai/responses/openai-responses-media-store';
import { OpenAIResponsesSessionService } from '@/server/gateway/modules/openai/responses/openai-responses-session.service';
import { OpenAIOperations } from '@/server/gateway/modules/openai/openai-operations.service';
import { PIXEL_PNG, PIXEL_GIF } from '../fixtures/image-content';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import * as serverConfig from '@/server/server-config';
import {
  createAccount,
  createGateway,
  createLease,
  createUpstream,
  geminiTextResponse,
} from './proxy-real-path.harness';

vi.mock('@/server/gateway/common/utils/request-user-agent', async (original) => ({
  ...(await original<
    typeof import('@/server/gateway/common/utils/request-user-agent')
  >()),
  resolveRequestUserAgent: vi.fn(async () => 'antigravity/test'),
}));

let directory: string | undefined;
const stores: OpenAIResponsesSessionService[] = [];
const files: FileContentStore[] = [];
function createColdOwner(root: string) {
  const publicFiles = new FileContentStore({
    rootDirectory: path.join(root, 'public-files'),
    sweepIntervalMs: 0,
  });
  files.push(publicFiles);
  const media = new FilesService(publicFiles).createPrivateContentStore({
    rootDirectory: path.join(root, 'private-media'),
  });
  const store = new OpenAIResponsesSessionService({
    filePath: path.join(root, 'sessions.json'),
    mediaStore: new OpenAIResponsesMediaStore(media),
  });
  stores.push(store);
  const upstream = createUpstream({ generate: geminiTextResponse('both images') });
  const gateway = createGateway(upstream, createLease([createAccount('cold-media')]));
  return {
    store,
    upstream,
    gateway,
    operations: new OpenAIOperations(gateway.openAIService, undefined, undefined, store),
  };
}
afterEach(async () => {
  for (const store of stores.splice(0)) {
    await store.flush();
    store.onModuleDestroy();
  }
  for (const file of files.splice(0)) {
    file.onModuleDestroy();
  }
  if (directory) {
    const resolved = path.resolve(directory);
    if (
      path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolved).startsWith('agm-image-cold-')
    ) {
      throw new Error('Unexpected fixture cleanup directory');
    }
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    directory = undefined;
  }
});

describe('Responses image originals across disk-owner restart', () => {
  it('reopens private bytes and the session, preserves both images in the actual send and enforces history ownership', async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-image-cold-'));
    const root = directory;
    const headers = { authorization: 'Bearer synthetic-cold-media-owner' };
    const writer = createColdOwner(root);
    const input = [
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_image',
            image_url: `data:image/png;base64,${PIXEL_PNG.toString('base64')}`,
          },
        ],
      },
      { type: 'message', role: 'assistant', content: 'First image received.' },
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_image',
            image_url: `data:image/gif;base64,${PIXEL_GIF.toString('base64')}`,
          },
        ],
      },
    ];
    const prepared = await writer.operations.prepareResponsesRequest(
      { model: 'gemini-3-flash', input },
      { headers },
    );
    if (!prepared) {
      throw new Error('Expected a prepared initial request');
    }
    await writer.store.saveDeltaWithMedia(prepared.responseId, {
      ...prepared.session,
      routingSessionId: prepared.routingSessionId,
      inputDelta: prepared.session.inputItems,
      responseOutput: [{ type: 'message', role: 'assistant', content: 'Second image received.' }],
    });
    await writer.store.flush();
    writer.store.onModuleDestroy();
    const persisted = await fs.readFile(path.join(root, 'sessions.json'), 'utf8');
    expect(persisted).toContain('__agm_responses_media_reference');
    expect(persisted).not.toContain(PIXEL_PNG.toString('base64'));
    expect(persisted).not.toContain('synthetic-cold-media-owner');

    const restarted = createColdOwner(root);
    await expect(
      restarted.operations.prepareResponsesRequest(
        { previous_response_id: prepared.responseId, input: 'Compare both images.' },
        { headers: { authorization: 'Bearer another-synthetic-owner' } },
      ),
    ).resolves.toBeNull();
    const [first, second] = await Promise.all(
      [0, 1].map(() =>
        restarted.operations.prepareResponsesRequest(
          { previous_response_id: prepared.responseId, input: 'Compare both images.' },
          { headers },
        ),
      ),
    );
    expect(first?.request.messages).toEqual(second?.request.messages);
    if (!first) {
      throw new Error('Expected restored request');
    }
    await restarted.gateway.openAIService.handleChatCompletions(first.request);
    expect(
      restarted.upstream.calls[0].body.request.contents
        .flatMap((content) => content.parts)
        .filter((part) => part.inlineData),
    ).toEqual([
      { inlineData: { mimeType: 'image/png', data: PIXEL_PNG.toString('base64') } },
      { inlineData: { mimeType: 'image/gif', data: PIXEL_GIF.toString('base64') } },
    ]);
  });

  it('restores exact image-bearing parallel tool output and sends both private originals after restart', async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-image-cold-'));
    const headers = { authorization: 'Bearer synthetic-tool-media-owner' };
    const firstOutput = ` { "screenshot": "data:image/png;base64,${PIXEL_PNG.toString('base64')}", "note": "first" } `;
    const secondOutput = `second ![capture](data:image/gif;base64,${PIXEL_GIF.toString('base64')}) complete`;
    const input = [
      { type: 'message', role: 'user', content: 'Capture both.' },
      { type: 'function_call', call_id: 'call_a', name: 'capture_a', arguments: '{}' },
      { type: 'function_call', call_id: 'call_b', name: 'capture_b', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_a', output: firstOutput },
      { type: 'function_call_output', call_id: 'call_b', output: secondOutput },
    ];
    const writer = createColdOwner(directory);
    const prepared = await writer.operations.prepareResponsesRequest(
      { model: 'gemini-3-flash', input },
      { headers },
    );
    if (!prepared) {
      throw new Error('Missing initial tool request');
    }
    await writer.store.saveDeltaWithMedia(prepared.responseId, {
      ...prepared.session,
      routingSessionId: prepared.routingSessionId,
      inputDelta: prepared.session.inputItems,
      responseOutput: [{ type: 'message', role: 'assistant', content: 'Captured both.' }],
    });
    await writer.store.flush();
    writer.store.onModuleDestroy();
    const persisted = await fs.readFile(path.join(directory, 'sessions.json'), 'utf8');
    expect(persisted).toContain('json-text');
    expect(persisted).not.toContain(PIXEL_PNG.toString('base64'));
    expect(persisted).not.toContain(PIXEL_GIF.toString('base64'));
    const restarted = createColdOwner(directory);
    const retained = restarted.store.get(prepared.responseId);
    if (!retained) {
      throw new Error('Missing retained private references');
    }
    await expect(
      restarted.operations.prepareResponsesRequest(
        { model: 'gemini-3-flash', input: retained.inputItems },
        { headers },
      ),
    ).rejects.toMatchObject({ status: 400 });
    const restored = await restarted.store.restoreInputMedia(prepared.responseId);
    expect(restored?.session.inputItems).toEqual([
      ...input,
      { type: 'message', role: 'assistant', content: 'Captured both.' },
    ]);
    const next = await restarted.operations.prepareResponsesRequest(
      { previous_response_id: prepared.responseId, input: 'Compare both captures.' },
      { headers },
    );
    if (!next) {
      throw new Error('Missing cold continuation');
    }
    await restarted.gateway.openAIService.handleChatCompletions(next.request);
    const parts = restarted.upstream.calls[0].body.request.contents.flatMap(
      (content) => content.parts,
    );
    expect(parts.filter((part) => part.inlineData)).toEqual([
      { inlineData: { mimeType: 'image/png', data: PIXEL_PNG.toString('base64') } },
      { inlineData: { mimeType: 'image/gif', data: PIXEL_GIF.toString('base64') } },
    ]);
    expect(
      parts.filter((part) => part.functionResponse).map((part) => part.functionResponse?.name),
    ).toEqual(['capture_a', 'capture_b']);
    const config = vi.spyOn(serverConfig, 'getServerConfig').mockReturnValue({
      ...DEFAULT_APP_CONFIG.proxy,
      image_scheduler: {
        ...DEFAULT_APP_CONFIG.proxy.image_scheduler,
        send_window_enabled: true,
        send_window_strategy: 'count',
        send_window_count: 1,
      },
    });
    try {
      const limited = await restarted.operations.prepareResponsesRequest(
        { previous_response_id: prepared.responseId, input: 'Compare both captures.' },
        { headers },
      );
      if (!limited) {
        throw new Error('Missing limited continuation');
      }
      await restarted.gateway.openAIService.handleChatCompletions(limited.request);
      expect(
        restarted.upstream.calls[1].body.request.contents
          .flatMap((content) => content.parts)
          .filter((part) => part.inlineData),
      ).toEqual([{ inlineData: { mimeType: 'image/gif', data: PIXEL_GIF.toString('base64') } }]);
      config.mockReturnValue(DEFAULT_APP_CONFIG.proxy);
      const reopened = await restarted.operations.prepareResponsesRequest(
        { previous_response_id: prepared.responseId, input: 'Compare both captures.' },
        { headers },
      );
      if (!reopened) {
        throw new Error('Missing unwindowed continuation');
      }
      await restarted.gateway.openAIService.handleChatCompletions(reopened.request);
      expect(
        restarted.upstream.calls[2].body.request.contents
          .flatMap((content) => content.parts)
          .filter((part) => part.inlineData),
      ).toEqual(parts.filter((part) => part.inlineData));
      expect(restarted.store.get(prepared.responseId)).toEqual(retained);
      await restarted.store.flush();
      restarted.store.onModuleDestroy();
      const afterWindow = createColdOwner(directory);
      expect(
        (await afterWindow.store.restoreInputMedia(prepared.responseId))?.session.inputItems,
      ).toEqual(restored?.session.inputItems);
    } finally {
      config.mockRestore();
    }
    await expect(
      restarted.operations.prepareResponsesRequest(
        { previous_response_id: prepared.responseId, input: 'Compare both captures.' },
        { headers: { authorization: 'Bearer different-owner' } },
      ),
    ).resolves.toBeNull();
  });
});

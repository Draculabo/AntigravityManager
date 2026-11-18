import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import {
  OpenAIResponsesMediaStore,
  ResponsesMediaUnavailableError,
} from '@/server/gateway/modules/openai/responses/openai-responses-media-store';
import type { PrivateContentStore } from '@/server/gateway/modules/files/files.service';

describe('OpenAIResponsesMediaStore', () => {
  let contents = new Map<string, Buffer>();
  let store: OpenAIResponsesMediaStore;

  afterEach(() => {
    store?.dispose();
    contents.clear();
  });

  function createStore(): OpenAIResponsesMediaStore {
    const contentStore: PrivateContentStore = {
      dispose: () => undefined,
      get: async (id) => {
        const value = contents.get(id);
        if (!value) {
          throw new Error('missing content');
        }
        return Buffer.from(value);
      },
      put: async (bytes) => {
        const id = createHash('sha256').update(bytes).digest('hex').slice(0, 32);
        contents.set(id, Buffer.from(bytes));
        return id;
      },
    };
    store = new OpenAIResponsesMediaStore(contentStore);
    return store;
  }

  it('stores and restores image and audio protocol media without changing surrounding data', async () => {
    const mediaStore = createStore();
    const input = [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_image', image_url: 'data:image/png;base64,AQ==' },
          { type: 'input_audio', input_audio: { data: 'Ag==', format: 'wav' } },
        ],
      },
    ];

    const stored = await mediaStore.externalize(input);
    expect(JSON.stringify(stored)).not.toMatch(/data:(?:image|audio)\//u);
    expect(stored).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'message',
          content: expect.arrayContaining([
            expect.objectContaining({
              type: 'input_image',
              image_url: expect.objectContaining({
                __agm_responses_media_reference: 1,
                encoding: 'data-url',
              }),
            }),
          ]),
        }),
      ]),
    );
    await expect(mediaStore.restore(stored)).resolves.toEqual(input);
  });

  it('externalizes tool-result media but preserves data URLs inside tool-call arguments', async () => {
    const mediaStore = createStore();
    const input = [
      {
        type: 'function_call',
        name: 'inspect',
        arguments: '{"example":"data:image/png;base64,AQ=="}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_image',
        output: [
          {
            type: 'input_image',
            image_url: 'data:image/png;base64,Ag==',
          },
        ],
      },
    ];

    const stored = await mediaStore.externalize(input);
    expect(stored[0]).toEqual(input[0]);
    expect(JSON.stringify(stored[1])).not.toContain('data:image/');
    await expect(mediaStore.restore(stored)).resolves.toEqual(input);
  });

  it('reports expired or missing media as HTTP 410', async () => {
    const mediaStore = createStore();
    const [stored] = await mediaStore.externalize([
      { type: 'input_image', image_url: 'data:image/png;base64,AQ==' },
    ]);
    contents.clear();

    await expect(mediaStore.restore([stored])).rejects.toBeInstanceOf(
      ResponsesMediaUnavailableError,
    );
    await expect(mediaStore.restore([stored])).rejects.toMatchObject({ status: 410 });
  });

  it('rejects noncanonical Base64 before storing it', async () => {
    const mediaStore = createStore();

    await expect(
      mediaStore.externalize([{ type: 'input_image', image_url: 'data:image/png;base64,AQ=' }]),
    ).rejects.toThrow('Invalid inline Responses media base64 data');
    expect(contents.size).toBe(0);
  });
});

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  OpenAIResponsesMediaStore,
  containsInlineResponsesMedia,
  hasInvalidResponsesMediaReference,
} from '@/server/gateway/modules/openai/responses/openai-responses-media-store';
import { PIXEL_PNG } from '../fixtures/image-content';

const uri = `data:image/png;base64,${PIXEL_PNG.toString('base64')}`;
function fixture() {
  const contents = new Map<string, Buffer>();
  const store = new OpenAIResponsesMediaStore({
    dispose: () => undefined,
    get: async (id) => {
      const bytes = contents.get(id);
      if (!bytes) {
        throw new Error('Missing fixture content');
      }
      return Buffer.from(bytes);
    },
    put: async (bytes) => {
      const id = createHash('sha256').update(bytes).digest('hex').slice(0, 32);
      contents.set(id, Buffer.from(bytes));
      return id;
    },
  });
  return { store, contents };
}

describe('Responses private image-bearing tool text', () => {
  it.each([
    ` \n${uri}\t`,
    `before ![capture](${uri}) after`,
    ` { "image": "${uri}", "note":"中文\\n" } `,
  ])('externalizes a recognized image while restoring exact original text: %#', async (output) => {
    const { store } = fixture();
    const input = [{ type: 'function_call_output', call_id: 'call_a', output }];
    const saved = await store.externalize(input);
    expect(JSON.stringify(saved)).not.toContain(PIXEL_PNG.toString('base64'));
    expect(saved).not.toEqual(input);
    await expect(store.restore(saved)).resolves.toEqual(input);
    expect(input[0].output).toBe(output);
  });

  it('preserves ordinary text, invalid candidates, examples, arguments and metadata', async () => {
    const { store, contents } = fixture();
    const input = [
      { type: 'function_call', call_id: 'a', arguments: JSON.stringify({ image: uri }) },
      {
        type: 'function_call_output',
        call_id: 'a',
        output: `log: ${uri}`,
        metadata: { image: uri },
      },
      {
        type: 'function_call_output',
        call_id: 'b',
        output: `\`\`\`js\n![example](${uri})\n\`\`\``,
      },
      { type: 'function_call_output', call_id: 'c', output: 'data:image/png;base64,AQ==' },
      { type: 'message', role: 'user', content: uri },
    ];
    await expect(store.externalize(input)).resolves.toEqual(input);
    expect(contents.size).toBe(0);
  });

  it('handles typed tool text blocks without changing sibling data', async () => {
    const { store } = fixture();
    const input = [
      {
        type: 'function_call_output',
        call_id: 'a',
        output: [
          { type: 'input_text', text: uri, metadata: 'keep' },
          { type: 'input_text', text: 'done' },
        ],
      },
    ];
    const saved = await store.externalize(input);
    expect(JSON.stringify(saved)).not.toContain(PIXEL_PNG.toString('base64'));
    await expect(store.restore(saved)).resolves.toEqual(input);
  });

  it.each([
    { type: 'input_image', image_url: uri },
    { content: [{ type: 'input_image', image_url: uri }] },
    { content: [{ type: 'input_text', text: uri }] },
  ])('externalizes a single or wrapped supported tool output: %#', async (output) => {
    const { store } = fixture();
    const input = [{ type: 'function_call_output', call_id: 'a', output }];
    const saved = await store.externalize(input);
    expect(JSON.stringify(saved)).not.toContain(PIXEL_PNG.toString('base64'));
    await expect(store.restore(saved)).resolves.toEqual(input);
  });

  it('does not interpret typed examples in tool text-block metadata as media slots', async () => {
    const { store, contents } = fixture();
    const input = [
      {
        type: 'function_call_output',
        call_id: 'a',
        output: [
          {
            type: 'input_text',
            text: 'ordinary',
            metadata: { example: { type: 'input_image', image_url: uri } },
          },
        ],
      },
    ];
    await expect(store.externalize(input)).resolves.toEqual(input);
    expect(contents.size).toBe(0);
  });

  it('reports missing private text as 410 and rejects client reference injection', async () => {
    const { store, contents } = fixture();
    const saved = await store.externalize([
      { type: 'function_call_output', call_id: 'a', output: uri },
    ]);
    await expect(store.externalize(saved)).rejects.toThrow('Client supplied');
    contents.clear();
    await expect(store.restore(saved)).rejects.toMatchObject({ status: 410 });
  });

  it('splits a legitimate image-bearing text larger than the private per-file limit', async () => {
    const { store, contents } = fixture();
    const output = `${'x'.repeat(21 * 1024 * 1024)} ![capture](${uri})`;
    const input = [{ type: 'function_call_output', call_id: 'a', output }];
    const saved = await store.externalize(input);
    expect(contents.size).toBe(2);
    expect([...contents.values()].every((value) => value.length <= 16 * 1024 * 1024)).toBe(true);
    await expect(store.restore(saved)).resolves.toEqual(input);
  });

  it('does not accept malformed or misplaced tool-text references', async () => {
    const { store } = fixture();
    const malformed = {
      __agm_responses_media_reference: 2,
      encoding: 'json-text',
      ids: [],
      bytes: 1,
      sha256: 'a'.repeat(64),
    };
    const input = [{ type: 'function_call_output', call_id: 'a', output: malformed }];
    expect(hasInvalidResponsesMediaReference(input)).toBe(true);
    await expect(store.restore(input)).rejects.toMatchObject({ status: 410 });
    const saved = await store.externalize([
      { type: 'function_call_output', call_id: 'a', output: uri },
    ]);
    const item = saved[0];
    if (!item || typeof item !== 'object' || !('output' in item)) {
      throw new Error('Missing saved tool output');
    }
    await expect(
      store.restore([{ type: 'input_image', image_url: item.output }]),
    ).rejects.toMatchObject({ status: 410 });
    expect(
      containsInlineResponsesMedia([{ type: 'function_call_output', call_id: 'a', output: uri }]),
    ).toBe(true);
    expect(containsInlineResponsesMedia(saved)).toBe(false);
  });

  it('rejects altered chunk bytes and preserves lone surrogates on a valid roundtrip', async () => {
    const { store, contents } = fixture();
    const input = [
      { type: 'function_call_output', call_id: 'a', output: `\ud800 ![capture](${uri})` },
    ];
    const saved = await store.externalize(input);
    await expect(store.restore(saved)).resolves.toEqual(input);
    for (const bytes of contents.values()) {
      bytes[0] ^= 1;
    }
    await expect(store.restore(saved)).rejects.toMatchObject({ status: 410 });
  });

  it('retains the existing wrapped image URL contract after private restoration', async () => {
    const { store } = fixture();
    const input = [{ type: 'image_url', image_url: { url: uri, detail: 'high' } }];
    await expect(store.restore(await store.externalize(input))).resolves.toEqual(input);
  });

  it('refuses oversized image-bearing tool text before writing private chunks', async () => {
    const { store, contents } = fixture();
    const output = ' '.repeat(64 * 1024 * 1024) + uri;
    await expect(
      store.externalize([{ type: 'function_call_output', call_id: 'a', output }]),
    ).rejects.toThrow('64 MiB');
    expect(contents.size).toBe(0);
  });
});

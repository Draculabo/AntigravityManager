import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { parseGenerationInputImages } from '@/server/gateway/modules/openai/media/image-input-validation';
import { validateResponsesInputImageLimits } from '@/server/gateway/modules/openai/responses/openai-responses-inline-media';
import { extractToolResultImages } from '@/modules/proxy-gateway/antigravity/MarkdownImageParts';
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

// Existing one-pixel PNG fixture; mutations preserve Base64 while removing container evidence.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
  'base64',
);
const invalidImages = [
  ['unknown binary', Buffer.from([0x80, 0x81, 0x82, 0x83])],
  ['header only', png.subarray(0, 8)],
  ['missing PNG end', png.subarray(0, -12)],
] as const;

describe('strict image admission at protocol boundaries', () => {
  it.each(['chat', 'messages'] as const)(
    'counts extracted tool images before leasing on %s',
    async (protocol) => {
      const lease = createLease([createAccount('strict-tool-media')]);
      const upstream = createUpstream({ generate: geminiTextResponse('ok') });
      const gateway = createGateway(upstream, lease);
      const text = Array.from(
        { length: 17 },
        () => `![pixel](data:image/png;base64,${png.toString('base64')})`,
      ).join('\n');
      const result =
        protocol === 'chat'
          ? gateway.openAIService.handleChatCompletions({
              model: 'gemini-3-flash',
              messages: [
                { role: 'user', content: 'Inspect the returned images.' },
                {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      type: 'function',
                      id: 'screen',
                      function: { name: 'screen', arguments: '{}' },
                    },
                  ],
                },
                { role: 'tool', tool_call_id: 'screen', content: text },
              ],
            })
          : gateway.anthropicService.handleAnthropicMessages({
              model: 'gemini-3-flash',
              messages: [
                { role: 'user', content: 'Inspect the returned images.' },
                {
                  role: 'assistant',
                  content: [{ type: 'tool_use', id: 'screen', name: 'screen', input: {} }],
                },
                {
                  role: 'user',
                  content: [{ type: 'tool_result', tool_use_id: 'screen', content: text }],
                },
              ],
            });
      await expect(result).rejects.toThrow('Too many input images: maximum is 16');
      expect(lease.getNextToken).not.toHaveBeenCalled();
      expect(upstream.calls).toEqual([]);
    },
  );

  it.each(invalidImages)('rejects %s in generation and Responses image slots', (_label, bytes) => {
    const url = `data:image/png;base64,${bytes.toString('base64')}`;
    expect(() => parseGenerationInputImages(url)).toThrow(/image/i);
    expect(() =>
      validateResponsesInputImageLimits([{ type: 'input_image', image_url: url }]),
    ).toThrow(/image/i);
  });

  it.each(['chat', 'messages', 'gemini', 'gemini-stream', 'gemini-count'] as const)(
    'rejects unknown binary before account selection on %s',
    async (protocol) => {
      const data = invalidImages[0][1].toString('base64');
      const lease = createLease([createAccount('strict-media')]);
      const upstream = createUpstream({ generate: geminiTextResponse('ok') });
      const gateway = createGateway(upstream, lease);
      const gemini = {
        contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data } }] }],
      };
      const result =
        protocol === 'chat'
          ? gateway.openAIService.handleChatCompletions({
              model: 'gemini-3-flash',
              messages: [
                {
                  role: 'user',
                  content: [{ type: 'image_url', image_url: `data:image/png;base64,${data}` }],
                },
              ],
            })
          : protocol === 'messages'
            ? gateway.anthropicService.handleAnthropicMessages({
                model: 'gemini-3-flash',
                messages: [
                  {
                    role: 'user',
                    content: [
                      { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
                    ],
                  },
                ],
              })
            : protocol === 'gemini'
              ? gateway.geminiService.handleGeminiGenerateContent('gemini-3-flash', gemini)
              : protocol === 'gemini-stream'
                ? gateway.geminiService.handleGeminiStreamGenerateContent('gemini-3-flash', gemini)
                : gateway.geminiService.handleGeminiCountTokens('gemini-3-flash', gemini);
      await expect(result).rejects.toBeInstanceOf(BadRequestException);
      expect(lease.getNextToken).not.toHaveBeenCalled();
      expect(upstream.calls).toEqual([]);
      expect(upstream.countTokensCalls).toEqual([]);
    },
  );

  it('keeps invalid tool-text candidates and ordinary tool arguments unchanged', () => {
    const text = `![sample](data:image/png;base64,${png.subarray(0, 8).toString('base64')})`;
    expect(extractToolResultImages(text)).toEqual({ text, media: [] });
    expect(() =>
      validateResponsesInputImageLimits([
        {
          type: 'function_call',
          arguments: { type: 'input_image', image_url: 'data:image/png;base64,not-base64' },
        },
      ]),
    ).not.toThrow();
  });

  it('preserves a valid image with its original bytes while correcting its MIME', () => {
    expect(parseGenerationInputImages(`data:image/jpeg;base64,${png.toString('base64')}`)).toEqual([
      { data: png.toString('base64'), mimeType: 'image/png' },
    ]);
  });
});

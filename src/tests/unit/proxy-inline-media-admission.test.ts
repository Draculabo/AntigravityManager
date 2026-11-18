import { afterEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import {
  admitAnthropicInlineMedia,
  admitOpenAIInlineMedia,
} from '@/server/gateway/common/inline-media-admission';
import type {
  AnthropicContent,
  OpenAIContentPart,
} from '@/server/gateway/common/interfaces/request-interfaces';
import {
  MAX_INPUT_IMAGE_BYTES,
  MAX_TOTAL_INPUT_IMAGE_BYTES,
} from '@/server/gateway/modules/openai/media/image-input-validation';
import { proxyModelAvailabilityStore } from '@/server/gateway/shared/services/model-availability.service';
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

afterEach(() => proxyModelAvailabilityStore.clearAccount('media-test'));

describe('inline media admission before account selection', () => {
  it('keeps signed assistant Markdown literal while still validating actual media blocks', async () => {
    const signature = 'opaque-signed-history-value';
    const text = ' \n![literal](data:image/png;base64,AB==)\t ';
    const content: AnthropicContent[] = [
      { type: 'thinking', thinking: 'Original reasoning.\n ', signature },
      { type: 'text', text },
    ];
    const request = {
      model: 'gemini-3-flash',
      messages: [
        { role: 'user', content: 'Continue.' },
        { role: 'assistant', content },
      ],
      max_tokens: 128,
    };
    const before = structuredClone(request);
    expect(admitAnthropicInlineMedia(request)).toEqual(request);
    const upstream = createUpstream({ generate: geminiTextResponse('ok') });
    const service = createGateway(
      upstream,
      createLease([createAccount('media-test')]),
    ).anthropicService;
    await service.handleAnthropicMessages(request);
    expect(upstream.calls[0].body.request.contents[1].parts).toEqual([
      {
        text: 'Original reasoning.\n ',
        thought: true,
        thoughtSignature: signature,
        thought_signature: signature,
      },
      { text },
    ]);
    expect(request).toEqual(before);
    expect(() =>
      admitAnthropicInlineMedia({
        ...request,
        messages: [
          {
            role: 'assistant',
            content: [
              ...content,
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AB==' } },
            ],
          },
        ],
      }),
    ).toThrow('invalid base64');
    expect(() =>
      admitAnthropicInlineMedia({
        ...request,
        messages: [{ role: 'assistant', content: [{ type: 'text', text }] }],
      }),
    ).toThrow('invalid base64');
  });
  it('keeps Markdown in system prompts and tool-result prose outside the image budget', () => {
    const prose = '![literal](data:image/png;base64,AB==)';
    const openAI = {
      model: 'gemini-3-flash',
      messages: [
        { role: 'system', content: prose },
        { role: 'tool', tool_call_id: 'read-1', content: [{ type: 'text' as const, text: prose }] },
      ],
    };
    expect(admitOpenAIInlineMedia(openAI)).toEqual(openAI);
    const anthropic = {
      model: 'gemini-3-flash',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result' as const,
              tool_use_id: 'read-1',
              content: [{ type: 'text' as const, text: prose }],
            },
          ],
        },
      ],
    };
    expect(admitAnthropicInlineMedia(anthropic)).toEqual(anthropic);
  });
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==';
  const image = (data: string, mime = 'image/png'): AnthropicContent => ({
    type: 'image',
    source: { type: 'base64', media_type: mime, data },
  });

  it.each([false, true])(
    'normalizes valid Chat images without mutating the request (stream=%s)',
    async (stream) => {
      const lease = createLease([createAccount('media-test')]);
      const response = geminiTextResponse('ok');
      const upstream = createUpstream({ generate: response, streamFrames: [{ response }] });
      const gateway = createGateway(upstream, lease);
      const request = {
        model: 'gemini-3-flash',
        stream,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image_url' as const,
                image_url: { url: `data:image/jpeg;base64,${png}`, detail: 'high' as const },
              },
            ],
          },
        ],
      };
      const before = structuredClone(request);
      await gateway.openAIService.handleChatCompletions(request);
      expect(request).toEqual(before);
      expect(upstream.calls[0].body.request.contents[0].parts).toEqual([
        { inlineData: { mimeType: 'image/png', data: png } },
      ]);
    },
  );

  it('admits a nested tool-result image and PDF with complete bytes preserved', async () => {
    const lease = createLease([createAccount('media-test')]);
    const upstream = createUpstream({ generate: geminiTextResponse('ok') });
    const pdf = Buffer.from('%PDF-1.7\nfixture').toString('base64');
    await createGateway(upstream, lease).anthropicService.handleAnthropicMessages({
      model: 'gemini-3-flash',
      messages: [
        { role: 'user', content: 'Read the files.' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'read-1', name: 'read', input: {} }],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'read-1',
              content: [
                image(png, 'image/jpeg'),
                {
                  type: 'document',
                  source: { type: 'base64', media_type: 'application/pdf', data: pdf },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(upstream.calls[0].body.request.contents[2].parts).toEqual([
      { functionResponse: { id: 'read-1', name: 'read', response: { result: '' } } },
      { inlineData: { mimeType: 'image/png', data: png } },
      { inlineData: { mimeType: 'application/pdf', data: pdf } },
    ]);
  });

  it('rejects malformed images on count_tokens without selecting an account', async () => {
    const lease = createLease([createAccount('media-test')]);
    const upstream = createUpstream({ countTokens: { totalTokens: 1 } });
    await expect(
      createGateway(upstream, lease).anthropicService.handleAnthropicCountTokens({
        model: 'gemini-3-flash',
        messages: [{ role: 'user', content: [image('@@@')] }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(lease.getNextToken).not.toHaveBeenCalled();
    expect(upstream.countTokensCalls).toEqual([]);
  });

  it.each([
    { type: 'image_url', image_url: 'data:image/png,AAAA' },
    { type: 'image_url', image_url: 'data:audio/wav;base64,AAAA' },
    { type: 'image_url', image_url: 'data:image/png;base64,AB==' },
    { type: 'audio_url', audio_url: { url: 'data:audio/wav;base64,@@@' } },
    { type: 'audio_url', audio_url: { url: '  data:audio/wav;base64,@@@  ' } },
    { type: 'video_url', video_url: { url: 'data:video/mp4;base64,' } },
    { type: 'video_url', video_url: { url: 'data:video/mp4,AAAA' } },
    { type: 'video_url', video_url: { url: 'not-base64' } },
  ] satisfies OpenAIContentPart[])('rejects malformed OpenAI media $type', (part) => {
    expect(() =>
      admitOpenAIInlineMedia({
        model: 'gemini-3-flash',
        messages: [{ role: 'user', content: [part] }],
      }),
    ).toThrow(BadRequestException);
  });

  it.each(['image', 'document', 'audio', 'video'] as const)(
    'rejects malformed Anthropic %s',
    (type) => {
      const block: AnthropicContent = {
        type,
        source: {
          type: 'base64',
          media_type: type === 'document' ? 'application/pdf' : `${type}/unknown`,
          data: '@@@',
        },
      };
      expect(() =>
        admitAnthropicInlineMedia({
          model: 'gemini-3-flash',
          messages: [{ role: 'user', content: [block] }],
        }),
      ).toThrow(BadRequestException);
    },
  );

  it('preserves remote URLs and text-like document MIME labels', () => {
    const request = {
      model: 'gemini-3-flash',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url' as const, image_url: 'https://example.test/a.png' },
            { type: 'audio_url' as const, audio_url: { url: 'https://example.test/a.wav' } },
            { type: 'video_url' as const, video_url: { url: 'https://example.test/a.mp4' } },
          ],
        },
      ],
    };
    expect(admitOpenAIInlineMedia(request)).toEqual(request);
    const document = {
      model: 'gemini-3-flash',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document' as const,
              source: {
                type: 'base64' as const,
                media_type: 'application/xml',
                data: Buffer.from('<root/>').toString('base64'),
              },
            },
          ],
        },
      ],
    };
    expect(admitAnthropicInlineMedia(document)).toEqual(document);
  });

  it('validates recognized Markdown images using the same request-wide budget', () => {
    expect(() =>
      admitOpenAIInlineMedia({
        model: 'gemini-3-flash',
        messages: [{ role: 'user', content: '![bad](data:image/png;base64,AB==)' }],
      }),
    ).toThrow(BadRequestException);
    expect(
      admitAnthropicInlineMedia({
        model: 'gemini-3-flash',
        messages: [
          { role: 'user', content: `Before ![pixel](data:image/jpeg;base64,${png}) after` },
        ],
      }).messages[0].content,
    ).toBe(`Before ![pixel](data:image/png;base64,${png}) after`);
  });

  it.each([
    ['image count', () => Array.from({ length: 17 }, () => image(png))],
    [
      'individual image size',
      () => [image(Buffer.alloc(MAX_INPUT_IMAGE_BYTES + 1).toString('base64'))],
    ],
    [
      'total image size',
      () =>
        Array.from({ length: 2 }, () =>
          image(Buffer.alloc(MAX_TOTAL_INPUT_IMAGE_BYTES / 2 + 1).toString('base64')),
        ),
    ],
  ] as const)('enforces existing limits for %s', (_label, blocks) => {
    expect(() =>
      admitAnthropicInlineMedia({
        model: 'gemini-3-flash',
        messages: [{ role: 'user', content: blocks() }],
      }),
    ).toThrow(BadRequestException);
  });
  it.each(['', '@@@', 'aGVsbG8='])(
    'rejects invalid OpenAI image data %j before leasing',
    async (data) => {
      const lease = createLease([createAccount('media-test')]);
      const upstream = createUpstream({ generate: geminiTextResponse('ok') });
      const gateway = createGateway(upstream, lease);
      await expect(
        gateway.openAIService.handleChatCompletions({
          model: 'gemini-3-flash',
          messages: [
            {
              role: 'user',
              content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } }],
            },
          ],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(lease.getNextToken).not.toHaveBeenCalled();
      expect(upstream.calls).toEqual([]);
    },
  );

  it.each(['', '@@@', 'aGVsbG8='])(
    'rejects invalid Anthropic tool-result image %j before leasing',
    async (data) => {
      const lease = createLease([createAccount('media-test')]);
      const upstream = createUpstream({ generate: geminiTextResponse('ok') });
      const gateway = createGateway(upstream, lease);
      await expect(
        gateway.anthropicService.handleAnthropicMessages({
          model: 'gemini-3-flash',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'read-image',
                  content: [
                    { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
                  ],
                },
              ],
            },
          ],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(lease.getNextToken).not.toHaveBeenCalled();
      expect(upstream.calls).toEqual([]);
    },
  );
});

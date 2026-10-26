import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import type { GeminiInternalRequest } from '@/modules/proxy-gateway/antigravity/types';
import { GeminiClient } from '@/modules/proxy-gateway/server/modules/gemini/gemini-client.service';
import { Upstream4xxCaptureService } from '@/modules/proxy-gateway/server/common/upstream-4xx-capture.service';
import { thoughtStoreService } from '@/modules/proxy-gateway/thought-store/thought-store.service';
import { setServerConfig } from '@/server/server-config';

const axiosMock = vi.hoisted(() => ({
  post: vi.fn(),
  create: vi.fn(() => ({ get: vi.fn(), post: vi.fn() })),
  isAxiosError: vi.fn(() => false),
}));
vi.mock('axios', () => ({ default: axiosMock, ...axiosMock }));

const claude = Buffer.from([0x08, 0x04, 0x12, ...Array<number>(80).fill(0x7f)]).toString('base64');
const gemini = Buffer.from([0x12, ...Array<number>(80).fill(0x7f)]).toString('base64');
const placeholder = 'skip_thought_signature_validator';

function requestFor(model: string, signature: string): GeminiInternalRequest {
  return {
    model,
    project: 'synthetic-project',
    requestId: 'synthetic-request',
    userAgent: 'synthetic-test',
    request: {
      contents: [
        { role: 'user', parts: [{ text: 'hello' }] },
        {
          role: 'model',
          parts: [
            { functionCall: { id: 'call-1', name: 'read', args: {} }, thoughtSignature: signature },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call-1',
                name: 'read',
                response: { result: 'controlled result' },
              },
            },
          ],
        },
      ],
    },
  };
}

describe('physical target signature format gates', () => {
  beforeEach(() => {
    axiosMock.post.mockReset();
    axiosMock.isAxiosError.mockReturnValue(false);
    vi.stubEnv('PROXY_CONTEXT_CACHE_ENABLED', 'false');
    vi.stubEnv('PROXY_INTERNAL_BASE_URLS', '');
    vi.stubEnv('ANTIGRAVITY_INTERNAL_BASE_URLS', '');
    setServerConfig(DEFAULT_APP_CONFIG.proxy);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each([
    { model: 'gemini-3-flash', signature: claude, family: 'gemini' },
    { model: 'claude-sonnet-4-6', signature: gemini, family: 'claude' },
    { model: 'claude-sonnet-4-6', signature: placeholder, family: 'claude' },
  ])(
    'rejects incompatible input before history preparation for $family',
    async ({ model, signature, family }) => {
      const prepare = vi.spyOn(thoughtStoreService, 'prepareInternalRequest').mockResolvedValue();
      const client = new GeminiClient(new Upstream4xxCaptureService());
      const request = requestFor(model, signature);
      const before = structuredClone(request);
      axiosMock.post.mockResolvedValue({ status: 200, headers: {}, data: { candidates: [] } });

      await expect(client.generateInternal(request, 'synthetic-token')).rejects.toMatchObject({
        message: `Thought signature format at contents[1].parts[0] is incompatible with target model family ${family}.`,
      });
      expect(prepare).not.toHaveBeenCalled();
      expect(axiosMock.post).not.toHaveBeenCalled();
      expect(request).toEqual(before);
    },
  );

  it.each(['streamGenerateInternal', 'streamGenerate', 'generate', 'warmupInternal'] as const)(
    'rejects Claude placeholders at the alternate %s entry before dispatch',
    async (operation) => {
      const prepare = vi.spyOn(thoughtStoreService, 'prepareInternalRequest').mockResolvedValue();
      const client = new GeminiClient(new Upstream4xxCaptureService());
      const request = requestFor('claude-sonnet-4-6', placeholder);
      axiosMock.post.mockResolvedValue({ status: 200, headers: {}, data: Readable.from([]) });
      const result =
        operation === 'generate' || operation === 'streamGenerate'
          ? client[operation](request.model, request.request, 'synthetic-token')
          : client[operation](request, 'synthetic-token');
      const settled = result.then((value) => {
        if (value instanceof Readable) {
          value.destroy();
        }
        return value;
      });
      await expect(settled).rejects.toMatchObject({
        message:
          'Thought signature format at contents[1].parts[0] is incompatible with target model family claude.',
      });
      expect(prepare).not.toHaveBeenCalled();
      expect(axiosMock.post).not.toHaveBeenCalled();
    },
  );

  it('fails closed when a recognized signature has no registered target family', async () => {
    const prepare = vi.spyOn(thoughtStoreService, 'prepareInternalRequest').mockResolvedValue();
    const client = new GeminiClient(new Upstream4xxCaptureService());
    const request = requestFor('custom-unknown-model', claude);
    await expect(client.generateInternal(request, 'synthetic-token')).rejects.toMatchObject({
      message:
        'Thought signature format at contents[1].parts[0] is incompatible with target model family unknown.',
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  it.each([
    { model: 'gemini-3-flash', signature: placeholder },
    { model: 'gemini-3-flash', signature: gemini },
    { model: 'claude-sonnet-4-6', signature: claude },
    { model: 'claude-sonnet-4-6', signature: 'future-opaque-provider-signature' },
    { model: 'custom-unknown-model', signature: 'future-opaque-provider-signature' },
  ])(
    'preserves target-compatible or unknown signature for $model',
    async ({ model, signature }) => {
      vi.spyOn(thoughtStoreService, 'prepareInternalRequest').mockResolvedValue();
      const client = new GeminiClient(new Upstream4xxCaptureService());
      const request = requestFor(model, signature);
      axiosMock.post.mockResolvedValue({
        status: 200,
        headers: {},
        data: { response: { candidates: [{ content: { parts: [] } }] } },
      });
      await client.generateInternal(request, 'synthetic-token');
      const sent = JSON.parse(axiosMock.post.mock.calls[0]?.[1]);
      const signatureSent =
        sent.request.contents[1].parts[0].thoughtSignature ??
        sent.request.contents[1].parts[0].thought_signature;
      if (model.startsWith('claude-') && signature === claude) {
        expect(signatureSent).toBe(Buffer.from(claude, 'utf8').toString('base64'));
      } else {
        expect(signatureSent).toBe(signature);
      }
    },
  );
});

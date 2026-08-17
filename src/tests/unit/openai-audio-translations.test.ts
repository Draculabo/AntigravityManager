import { afterEach, describe, expect, it, vi } from 'vitest';

import { OpenAIController } from '@/modules/proxy-gateway/server/modules/openai/openai.controller';
import { proxyModelAvailabilityStore } from '@/modules/proxy-gateway/server/shared/services/model-availability.service';
import {
  createAccount,
  createGateway,
  createLease,
  createReply,
  createUpstream,
  geminiTextResponse,
} from './proxy-real-path.harness';

/**
 * `POST /v1/audio/translations`. OpenAI's distinction from transcriptions is narrow:
 * transcriptions return the speech in its own language, translations return English.
 */

vi.mock(
  '@/modules/proxy-gateway/server/common/utils/request-user-agent',
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    resolveRequestUserAgent: async () => 'antigravity-parity-harness/0.0.0',
  }),
);

const MULTIPART_REQUEST = {
  headers: { 'content-type': 'multipart/form-data; boundary=----parity' },
} as never;

function audioBody(overrides: Record<string, unknown> = {}) {
  return {
    file: { data: Buffer.from('fake audio').toString('base64'), mimeType: 'audio/mpeg' },
    ...overrides,
  };
}

describe('OpenAI audio translations', () => {
  afterEach(() => {
    proxyModelAvailabilityStore.clearAccount('acc-1');
  });

  it('answers with the English text the model returned', async () => {
    const upstream = createUpstream({ generate: geminiTextResponse('The weather is fine.') });
    const lease = createLease([createAccount('acc-1')]);
    const controller = new OpenAIController(createGateway(upstream, lease).openAIService);
    const reply = createReply();

    await controller.audioTranslations(audioBody() as never, MULTIPART_REQUEST, reply as never);

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.body).toEqual({ text: 'The weather is fine.' });
  });

  it('asks for English and sends the audio in the same request', async () => {
    const upstream = createUpstream({ generate: geminiTextResponse('ok') });
    const lease = createLease([createAccount('acc-1')]);
    const controller = new OpenAIController(createGateway(upstream, lease).openAIService);

    await controller.audioTranslations(
      audioBody() as never,
      MULTIPART_REQUEST,
      createReply() as never,
    );

    const sent = JSON.stringify(upstream.calls[0]?.body);
    expect(sent).toContain('English');
    expect(sent).toContain('inlineData');
    expect(upstream.calls).toHaveLength(1);
  });

  it('carries the caller prompt as guidance, not as the whole instruction', async () => {
    const upstream = createUpstream({ generate: geminiTextResponse('ok') });
    const lease = createLease([createAccount('acc-1')]);
    const controller = new OpenAIController(createGateway(upstream, lease).openAIService);

    await controller.audioTranslations(
      audioBody({ prompt: 'keep the medical terms' }) as never,
      MULTIPART_REQUEST,
      createReply() as never,
    );

    const sent = JSON.stringify(upstream.calls[0]?.body);
    expect(sent).toContain('keep the medical terms');
    expect(sent).toContain('English');
  });

  it('refuses a request with no audio in it', async () => {
    const upstream = createUpstream({ generate: geminiTextResponse('unreachable') });
    const lease = createLease([createAccount('acc-1')]);
    const controller = new OpenAIController(createGateway(upstream, lease).openAIService);
    const reply = createReply();

    await controller.audioTranslations({} as never, MULTIPART_REQUEST, reply as never);

    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.body).toMatchObject({ error: { type: 'invalid_request_error' } });
    expect(upstream.calls).toHaveLength(0);
  });

  it('refuses a request that is not multipart, the same way transcriptions does', async () => {
    const upstream = createUpstream({ generate: geminiTextResponse('unreachable') });
    const lease = createLease([createAccount('acc-1')]);
    const controller = new OpenAIController(createGateway(upstream, lease).openAIService);
    const reply = createReply();

    await controller.audioTranslations(
      audioBody() as never,
      { headers: { 'content-type': 'application/json' } } as never,
      reply as never,
    );

    expect(reply.status).toHaveBeenCalledWith(400);
    expect(upstream.calls).toHaveLength(0);
  });
});

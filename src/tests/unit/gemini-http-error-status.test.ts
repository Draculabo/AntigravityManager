import type { FastifyReply } from 'fastify';
import { BadRequestException, HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { UpstreamRequestError } from '@/server/gateway/common/exceptions/upstream-request.exception';
import { GeminiController } from '@/server/gateway/modules/gemini/gemini.controller';
import type { GeminiService } from '@/server/gateway/modules/gemini/gemini.service';

async function requestFailure(action: string, error: Error) {
  const service = {
    handleGeminiGenerateContent: vi.fn().mockRejectedValue(error),
    handleGeminiStreamGenerateContent: vi.fn().mockRejectedValue(error),
    handleGeminiCountTokensWithSource: vi.fn().mockRejectedValue(error),
  };
  const reply = {
    status: vi.fn(() => reply),
    send: vi.fn(() => reply),
    header: vi.fn(() => reply),
  };
  const controller = new GeminiController(service as unknown as GeminiService);
  await controller.modelAction(
    `gemini-3-flash:${action}`,
    { contents: [{ role: 'user', parts: [{ text: 'controlled failure' }] }] },
    reply as unknown as FastifyReply,
  );
  return reply;
}

describe.each(['generateContent', 'streamGenerateContent', 'countTokens'])(
  'Gemini %s HTTP error status',
  (action) => {
    it.each([
      [400, 'INVALID_ARGUMENT'],
      [401, 'UNAUTHENTICATED'],
      [403, 'PERMISSION_DENIED'],
      [404, 'NOT_FOUND'],
      [408, 'DEADLINE_EXCEEDED'],
      [429, 'RESOURCE_EXHAUSTED'],
      [500, 'INTERNAL'],
      [502, 'INTERNAL'],
      [503, 'UNAVAILABLE'],
      [504, 'DEADLINE_EXCEEDED'],
    ] as const)(
      'preserves upstream HTTP %i independently of message text',
      async (code, status) => {
        const message = 'Controlled upstream rejection mentioning unrelated quota 429';
        const reply = await requestFailure(
          action,
          new UpstreamRequestError({ status: code, message }),
        );
        expect(reply.status.mock.calls).toEqual([[code]]);
        expect(reply.send.mock.calls).toEqual([[{ error: { code, status, message } }]]);
      },
    );

    it.each([undefined, 0, 200, 302, 399, 600, 429.5, NaN, Infinity])(
      'rejects invalid upstream error status %s as a bad gateway',
      async (status) => {
        const message = 'Controlled upstream protocol failure mentioning quota 429';
        const reply = await requestFailure(action, new UpstreamRequestError({ status, message }));
        expect(reply.status.mock.calls).toEqual([[502]]);
        expect(reply.send.mock.calls).toEqual([
          [{ error: { code: 502, status: 'INTERNAL', message } }],
        ]);
      },
    );

    it('preserves local validation and account admission exceptions', async () => {
      const invalid = await requestFailure(
        action,
        new BadRequestException('Controlled invalid request'),
      );
      expect(invalid.status.mock.calls).toEqual([[400]]);
      expect(invalid.send.mock.calls).toEqual([
        [
          {
            error: {
              code: 400,
              status: 'INVALID_ARGUMENT',
              message: 'Controlled invalid request',
            },
          },
        ],
      ]);
      const admission = await requestFailure(
        action,
        new HttpException('Controlled account admission', 503),
      );
      expect(admission.status.mock.calls).toEqual([[503]]);
      expect(admission.send.mock.calls).toEqual([
        [
          {
            error: {
              code: 503,
              status: 'UNAVAILABLE',
              message: 'Controlled account admission',
            },
          },
        ],
      ]);
    });

    it('retains internal error status for an unclassified local exception', async () => {
      const reply = await requestFailure(
        action,
        new Error('Controlled local failure mentioning 429'),
      );
      expect(reply.status.mock.calls).toEqual([[500]]);
      expect(reply.send.mock.calls).toEqual([
        [
          {
            error: {
              code: 500,
              status: 'INTERNAL',
              message: 'Controlled local failure mentioning 429',
            },
          },
        ],
      ]);
    });
  },
);

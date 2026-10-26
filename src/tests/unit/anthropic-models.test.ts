import { describe, expect, it, vi } from 'vitest';

import { AnthropicController } from '@/modules/proxy-gateway/server/modules/anthropic/anthropic.controller';

function createReply() {
  const reply = {
    body: undefined as unknown,
    send: vi.fn((body: unknown) => {
      reply.body = body;
      return reply;
    }),
    status: vi.fn(() => reply),
  };
  return reply;
}

describe('Anthropic model discovery', () => {
  it('publishes the Claude-compatible list shape from the shared model directory', () => {
    const controller = new AnthropicController({} as never, undefined, {
      getAllCollectedModels: () => new Set(['claude-sonnet-4-6-thinking']),
      getAllRawQuotaModels: () => new Set(['claude-sonnet-4-6-thinking']),
    } as never);

    const payload = controller.listClaudeModels();

    expect(payload.object).toBe('list');
    expect(payload.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'claude-sonnet-4-6-thinking',
          object: 'model',
          owned_by: 'antigravity',
        }),
      ]),
    );
  });

  it('returns Anthropic metadata for a known model and a typed 404 for an unknown one', () => {
    const controller = new AnthropicController({} as never, undefined, {
      getAllCollectedModels: () => new Set(['claude-sonnet-4-6-thinking']),
      getAllRawQuotaModels: () => new Set(['claude-sonnet-4-6-thinking']),
    } as never);
    const known = createReply();
    const unknown = createReply();

    controller.retrieveClaudeModel('claude-sonnet-4-6-thinking', known as never);
    controller.retrieveClaudeModel('missing-model', unknown as never);

    expect(known.status).toHaveBeenCalledWith(200);
    expect(known.body).toMatchObject({
      type: 'model',
      id: 'claude-sonnet-4-6-thinking',
      display_name: 'claude-sonnet-4-6-thinking',
    });
    expect(unknown.status).toHaveBeenCalledWith(404);
    expect(unknown.body).toMatchObject({
      type: 'error',
      error: { type: 'not_found_error', message: 'model: missing-model' },
    });
  });
});

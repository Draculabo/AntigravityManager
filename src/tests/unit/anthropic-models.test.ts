import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import * as serverConfig from '@/server/server-config';

import { AnthropicController } from '@/server/gateway/modules/anthropic/anthropic.controller';
afterEach(() => vi.restoreAllMocks());

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

    expect(payload).toMatchObject({
      has_more: false,
      first_id: payload.data[0]?.id,
      last_id: payload.data.at(-1)?.id,
    });
    expect(payload.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'claude-sonnet-4-6-thinking',
          type: 'model',
          display_name: 'claude-sonnet-4-6-thinking',
        }),
      ]),
    );
  });

  it('uses the same complete model metadata in the list and retrieve result', () => {
    const controller = new AnthropicController({} as never);
    for (const listed of controller.listClaudeModels().data) {
      const reply = createReply();
      controller.retrieveClaudeModel(listed.id, reply as never);
      expect(reply.body).toEqual(listed);
    }
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

  it('returns an explicit empty page and exact-first, unique-folded retrieval', () => {
    vi.spyOn(serverConfig, 'getServerConfig').mockReturnValue({
      ...DEFAULT_APP_CONFIG.proxy,
      only_raw_quota_models: true,
    });
    const ids = new Set<string>();
    const controller = new AnthropicController({} as never, undefined, {
      getAllRawQuotaModels: () => ids,
    } as never);
    expect(controller.listClaudeModels()).toEqual({
      data: [],
      first_id: null,
      has_more: false,
      last_id: null,
    });
    ids.add('case-model');
    const folded = createReply();
    controller.retrieveClaudeModel('CASE-MODEL', folded as never);
    expect(folded.body).toEqual({
      type: 'model',
      id: 'case-model',
      display_name: 'case-model',
      created_at: '1970-01-01T00:00:00Z',
    });
    ids.add('CASE-MODEL');
    const exact = createReply();
    controller.retrieveClaudeModel('CASE-MODEL', exact as never);
    expect(exact.body).toMatchObject({ id: 'CASE-MODEL' });
    const ambiguous = createReply();
    controller.retrieveClaudeModel('Case-Model', ambiguous as never);
    expect(ambiguous.status).toHaveBeenCalledWith(404);
  });
});

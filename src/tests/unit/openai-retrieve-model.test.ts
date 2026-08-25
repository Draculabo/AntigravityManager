import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OpenAIOperations } from '@/modules/proxy-gateway/server/modules/openai/openai-operations.service';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { setServerConfig } from '@/server/server-config';

/**
 * `GET /v1/models/{id}`. An OpenAI SDK calls it through `client.models.retrieve()`, and a
 * client that has just read `GET /v1/models` expects the same entry back for anything in that
 * list.
 */

function createReply() {
  const reply: Record<string, unknown> & { body?: unknown } = {};
  reply.status = vi.fn(() => reply);
  reply.send = vi.fn((payload: unknown) => {
    reply.body = payload;
    return reply;
  });
  return reply;
}

function createController(models: string[]) {
  const accountLeaseService = {
    getAllCollectedModels: vi.fn(() => models),
    getAllRawQuotaModels: vi.fn(() => models),
  };
  return new OpenAIOperations({} as never, accountLeaseService as never);
}

describe('OpenAI retrieve model', () => {
  beforeEach(() => {
    setServerConfig({ ...DEFAULT_APP_CONFIG.proxy });
  });

  it('answers with the same entry the model list carries', () => {
    const controller = createController(['gemini-3-flash']);
    const listReply = createReply();
    controller.listModels(listReply as never);
    const listed = (listReply.body as { data: Array<{ id: string }> }).data.find(
      (entry) => entry.id === 'gemini-3-flash',
    );

    const reply = createReply();
    controller.retrieveModel('gemini-3-flash', reply as never);

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.body).toEqual(listed);
    expect(reply.body).toMatchObject({ id: 'gemini-3-flash', object: 'model' });
  });

  it('answers a model it does not serve with model_not_found, not the framework 404', () => {
    const controller = createController(['gemini-3-flash']);
    const reply = createReply();

    controller.retrieveModel('gpt-4o', reply as never);

    expect(reply.status).toHaveBeenCalledWith(404);
    expect(reply.body).toEqual({
      error: {
        code: 'model_not_found',
        message: "The model 'gpt-4o' does not exist or you do not have access to it.",
        param: 'model',
        type: 'invalid_request_error',
      },
    });
  });

  it('substitutes no near match for an id it does not serve', () => {
    const controller = createController(['gemini-3-flash']);
    const reply = createReply();

    controller.retrieveModel('gemini-3-flash-preview', reply as never);

    expect(reply.status).toHaveBeenCalledWith(404);
    expect(JSON.stringify(reply.body)).not.toContain('"id"');
  });
});

import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { BatchRunnerService } from '@/modules/proxy-gateway/server/modules/batch/batch-runner.service';
import { BatchService } from '@/modules/proxy-gateway/server/modules/batch/batch.service';
import {
  BatchJobError,
  type BatchJobRecord,
} from '@/modules/proxy-gateway/server/modules/batch/batch-job.types';
import { toOpenAIBatchObject } from '@/modules/proxy-gateway/server/modules/batch/openai-batch-resource';
import { toAnthropicMessageBatch } from '@/modules/proxy-gateway/server/modules/batch/anthropic-batch-resource';
import { batchTestHeaders, createBatchHttpApp } from '../helpers/batch-http-app';

const bareId = '0'.repeat(24);
const surfaces = [
  {
    path: '/v1/batches',
    id: `batch_${bareId}`,
    authBody: {
      error: {
        code: 'invalid_api_key',
        message: 'API key validation failed',
        param: null,
        type: 'invalid_request_error',
      },
    },
    unknownBody: {
      error: { code: null, message: 'Batch request failed', param: null, type: 'server_error' },
    },
    handlerBody: {
      error: { code: null, message: 'handler rejected', param: null, type: 'server_error' },
    },
  },
  {
    path: '/v1/messages/batches',
    id: `msgbatch_${bareId}`,
    authBody: {
      type: 'error',
      error: { message: 'API key validation failed', type: 'authentication_error' },
    },
    unknownBody: {
      type: 'error',
      error: { message: 'File request failed', type: 'api_error' },
    },
    handlerBody: {
      type: 'error',
      error: { message: 'handler rejected', type: 'api_error' },
    },
  },
  {
    path: '/v1beta/batches',
    id: bareId,
    authBody: {
      error: { code: 401, message: 'API key validation failed', status: 'UNAUTHENTICATED' },
    },
    unknownBody: {
      error: { code: 500, message: 'Batch request failed', status: 'UNKNOWN' },
    },
    handlerBody: {
      error: { code: 500, message: 'handler rejected', status: 'UNKNOWN' },
    },
  },
] as const;

function createService() {
  return new BatchService(new BatchRunnerService({ maxConcurrency: 1 }));
}

describe('Batch protocol errors through the Nest HTTP pipeline', () => {
  it.each(surfaces)('preserves guard denials on $path', async ({ path, authBody }) => {
    const batches = createService();
    const spies = [
      vi.spyOn(batches, 'listOpenAI'),
      vi.spyOn(batches, 'listAnthropic'),
      vi.spyOn(batches, 'listGemini'),
    ];
    const app = await createBatchHttpApp(batches);
    for (const headers of [{}, { authorization: 'Bearer incorrect-key' }]) {
      const response = await app.inject({ method: 'GET', url: path, headers });
      expect({ status: response.statusCode, body: response.json() }).toEqual({
        status: 401,
        body: authBody,
      });
    }
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it.each(surfaces)('preserves non-Error fallbacks on $path', async ({ path, id, unknownBody }) => {
    const batches = createService();
    vi.spyOn(batches, 'get').mockImplementation(() => {
      throw 'unexpected rejection';
    });
    const app = await createBatchHttpApp(batches);
    const response = await app.inject({
      method: 'GET',
      url: `${path}/${id}`,
      headers: batchTestHeaders,
    });
    expect({ status: response.statusCode, body: response.json() }).toEqual({
      status: 500,
      body: unknownBody,
    });
  });

  it.each(surfaces)(
    'maps handler HTTP exceptions through the existing dialect on $path',
    async ({ path, id, handlerBody }) => {
      const batches = createService();
      vi.spyOn(batches, 'get').mockImplementation(() => {
        throw new BadRequestException('handler rejected');
      });
      const app = await createBatchHttpApp(batches);
      const response = await app.inject({
        method: 'GET',
        url: `${path}/${id}`,
        headers: batchTestHeaders,
      });
      expect({ status: response.statusCode, body: response.json() }).toEqual({
        status: 500,
        body: handlerBody,
      });
    },
  );

  it('maps asynchronous input-file failures before creating an OpenAI batch', async () => {
    const batches = createService();
    vi.spyOn(batches, 'readOpenAIInput').mockRejectedValue(
      BatchJobError.invalid('input file rejected', 'input_file_id'),
    );
    const create = vi.spyOn(batches, 'create');
    const app = await createBatchHttpApp(batches);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/batches',
      headers: batchTestHeaders,
      payload: {
        endpoint: '/v1/chat/completions',
        completion_window: '24h',
        input_file_id: 'file-synthetic',
      },
    });
    expect({ status: response.statusCode, body: response.json() }).toEqual({
      status: 400,
      body: {
        error: {
          code: 'invalid_request',
          message: 'input file rejected',
          param: 'input_file_id',
          type: 'invalid_request_error',
        },
      },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it.each(['openai', 'anthropic'] as const)(
    'preserves HTTP 200 for %s create and cancel',
    async (dialect) => {
      const job: BatchJobRecord = {
        id: bareId,
        dialect,
        endpoint: dialect === 'openai' ? '/v1/chat/completions' : '/v1/messages',
        status: 'validating',
        requests: [],
        createdAtMs: 1_000,
        expiresAtMs: 2_000,
      };
      const batches = createService();
      vi.spyOn(batches, 'create').mockReturnValue(job);
      vi.spyOn(batches, 'cancel').mockReturnValue(job);
      vi.spyOn(batches, 'readOpenAIInput').mockResolvedValue(
        JSON.stringify({ custom_id: 'line-1', body: { model: 'synthetic', messages: [] } }),
      );
      const app = await createBatchHttpApp(batches);
      const path = dialect === 'openai' ? '/v1/batches' : '/v1/messages/batches';
      const body = dialect === 'openai' ? toOpenAIBatchObject(job) : toAnthropicMessageBatch(job);
      const payload =
        dialect === 'openai'
          ? { endpoint: job.endpoint, completion_window: '24h', input_file_id: 'file-synthetic' }
          : { requests: [{ custom_id: 'line-1', params: { model: 'synthetic', messages: [] } }] };
      for (const request of [{ url: path, payload }, { url: `${path}/${body.id}/cancel` }]) {
        const response = await app.inject({
          method: 'POST',
          headers: batchTestHeaders,
          ...request,
        });
        expect({ status: response.statusCode, body: response.json() }).toEqual({
          status: 200,
          body,
        });
      }
    },
  );
});

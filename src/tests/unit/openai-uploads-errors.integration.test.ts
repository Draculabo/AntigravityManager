import { BadRequestException } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { describe, expect, it, vi } from 'vitest';

import { FILE_UPLOAD_MULTIPART_LIMITS } from '@/modules/proxy-gateway/server/modules/files/file-upload-request';
import { OpenAIUploadError } from '@/modules/proxy-gateway/server/modules/uploads/openai-uploads.types';
import {
  createFilesHttpApp,
  fileMultipartPayload,
  filesTestHeaders,
  type FilesHttpOperations,
  type UploadsHttpOperations,
} from '../helpers/files-http-app';

const entries = [
  {
    operation: 'create',
    url: '/v1/uploads',
    payload: { bytes: 5, filename: 'hello.txt', mime_type: 'text/plain', purpose: 'user_data' },
  },
  { operation: 'addPart', url: '/v1/uploads/upload_test/parts' },
  {
    operation: 'complete',
    url: '/v1/uploads/upload_test/complete',
    payload: { part_ids: ['part_test'] },
  },
  { operation: 'cancel', url: '/v1/uploads/upload_test/cancel' },
] as const;
const fallback = {
  error: { code: null, message: 'Upload request failed', param: null, type: 'server_error' },
};

function createOperations(error: unknown) {
  const fail = () => {
    throw error;
  };
  const uploads = {
    create: vi.fn<UploadsHttpOperations['create']>(fail),
    addPart: vi.fn<UploadsHttpOperations['addPart']>(fail),
    complete: vi.fn<UploadsHttpOperations['complete']>().mockRejectedValue(error),
    cancel: vi.fn<UploadsHttpOperations['cancel']>(fail),
  };
  const files = {
    create: vi.fn<FilesHttpOperations['create']>(),
    list: vi.fn<FilesHttpOperations['list']>(),
    stat: vi.fn<FilesHttpOperations['stat']>(),
    content: vi.fn<FilesHttpOperations['content']>(),
    remove: vi.fn<FilesHttpOperations['remove']>(),
  };
  return { files, uploads };
}

function send(
  app: NestFastifyApplication,
  entry: (typeof entries)[number],
  headers: { authorization?: string } = filesTestHeaders,
) {
  if (entry.operation === 'addPart') {
    const part = fileMultipartPayload(
      [],
      { bytes: Buffer.from('hello'), filename: 'part.txt', mimeType: 'text/plain' },
      'data',
    );
    return app.inject({
      method: 'POST',
      url: entry.url,
      ...part,
      headers: { 'content-type': part.headers['content-type'], ...headers },
    });
  }
  return app.inject({
    method: 'POST',
    url: entry.url,
    headers,
    ...('payload' in entry ? { payload: entry.payload } : {}),
  });
}

describe('OpenAI Uploads HTTP errors', () => {
  describe.each(entries)('$operation', (entry) => {
    it.each([undefined, 'Bearer wrong-key'])(
      'preserves guard denial for %s without invoking operations',
      async (authorization) => {
        const { files, uploads } = createOperations(new Error('Must not run'));
        const app = await createFilesHttpApp(files, uploads);
        const reply = await send(app, entry, authorization ? { authorization } : {});
        expect({ status: reply.statusCode, body: reply.json() }).toEqual({
          status: 401,
          body: {
            error: {
              code: 'invalid_api_key',
              message: 'API key validation failed',
              param: null,
              type: 'invalid_request_error',
            },
          },
        });
        for (const operation of Object.values(uploads)) {
          expect(operation).not.toHaveBeenCalled();
        }
      },
    );

    it('preserves non-Error fallbacks', async () => {
      const { files, uploads } = createOperations('untyped rejection');
      const app = await createFilesHttpApp(files, uploads);
      const reply = await send(app, entry);
      expect({ status: reply.statusCode, body: reply.json() }).toEqual({
        status: 500,
        body: fallback,
      });
      expect(uploads[entry.operation]).toHaveBeenCalledOnce();
    });

    it('preserves complete operation error envelopes', async () => {
      const { files, uploads } = createOperations(
        new OpenAIUploadError('upload_not_found', 'Missing upload', 404, 'upload_id'),
      );
      const app = await createFilesHttpApp(files, uploads);
      const reply = await send(app, entry);
      expect({ status: reply.statusCode, body: reply.json() }).toEqual({
        status: 404,
        body: {
          error: {
            code: 'upload_not_found',
            message: 'Missing upload',
            param: 'upload_id',
            type: 'invalid_request_error',
          },
        },
      });
    });

    it('normalizes transport size errors only for multipart part uploads', async () => {
      const { files, uploads } = createOperations({ code: 'FST_REQ_FILE_TOO_LARGE' });
      const app = await createFilesHttpApp(files, uploads);
      const reply = await send(app, entry);
      const expected =
        entry.operation === 'addPart'
          ? {
              status: 413,
              body: {
                error: {
                  code: 'invalid_request',
                  message: `Uploaded file exceeds the ${FILE_UPLOAD_MULTIPART_LIMITS.fileSize} byte limit`,
                  param: 'file',
                  type: 'invalid_request_error',
                },
              },
            }
          : { status: 500, body: fallback };
      expect({ status: reply.statusCode, body: reply.json() }).toEqual(expected);
    });

    it('maps HTTP exceptions through the operation mapper', async () => {
      const { files, uploads } = createOperations(new BadRequestException('Operation failed'));
      const app = await createFilesHttpApp(files, uploads);
      const reply = await send(app, entry);
      expect({ status: reply.statusCode, body: reply.json() }).toEqual({
        status: 500,
        body: {
          error: { code: null, message: 'Operation failed', param: null, type: 'server_error' },
        },
      });
    });
  });

  it('rejects missing multipart data before resolving the upload session', async () => {
    const { files, uploads } = createOperations(OpenAIUploadError.notFound('missing'));
    const app = await createFilesHttpApp(files, uploads);
    const reply = await app.inject({
      method: 'POST',
      url: '/v1/uploads/missing/parts',
      ...fileMultipartPayload([], null, 'data'),
    });
    expect({ status: reply.statusCode, body: reply.json() }).toEqual({
      status: 400,
      body: {
        error: {
          code: 'invalid_request',
          message: 'A file part is required',
          param: 'file',
          type: 'invalid_request_error',
        },
      },
    });
    expect(uploads.addPart).not.toHaveBeenCalled();
  });
});

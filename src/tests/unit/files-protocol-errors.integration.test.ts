import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { FileStoreError } from '@/modules/proxy-gateway/server/modules/files/file-store.types';
import { FILE_UPLOAD_MULTIPART_LIMITS } from '@/modules/proxy-gateway/server/modules/files/file-upload-request';
import {
  createFilesHttpApp,
  fileMultipartPayload,
  filesTestHeaders,
  type FilesHttpOperations,
} from '../helpers/files-http-app';

const message = 'File request failed';
const authMessage = 'API key validation failed';
const anthropicHeaders = {
  'anthropic-version': '2023-06-01',
  'anthropic-beta': 'files-api-2025-04-14',
};
const surfaces = [
  {
    dialect: 'openai',
    url: '/v1/files',
    headers: {},
    uploadUrl: '/v1/files',
    fallback: { error: { code: null, message, param: null, type: 'server_error' } },
    auth: {
      error: {
        code: 'invalid_api_key',
        message: authMessage,
        param: null,
        type: 'invalid_request_error',
      },
    },
    sizeError: {
      error: {
        code: 'file_too_large',
        message: `Uploaded file exceeds the ${FILE_UPLOAD_MULTIPART_LIMITS.fileSize} byte limit`,
        param: 'file',
        type: 'invalid_request_error',
      },
    },
    storeError: {
      error: { code: 'not_found', message: 'Gone', param: null, type: 'invalid_request_error' },
    },
  },
  {
    dialect: 'anthropic',
    url: '/v1/files',
    headers: anthropicHeaders,
    uploadUrl: '/v1/files',
    fallback: { type: 'error', error: { type: 'api_error', message } },
    auth: { type: 'error', error: { type: 'authentication_error', message: authMessage } },
    sizeError: {
      type: 'error',
      error: {
        type: 'request_too_large',
        message: `Uploaded file exceeds the ${FILE_UPLOAD_MULTIPART_LIMITS.fileSize} byte limit`,
      },
    },
    storeError: { type: 'error', error: { type: 'not_found_error', message: 'Gone' } },
  },
  {
    dialect: 'gemini',
    url: '/v1beta/files',
    headers: {},
    uploadUrl: '/upload/v1beta/files',
    fallback: { error: { code: 500, message, status: 'INTERNAL' } },
    auth: { error: { code: 401, message: authMessage, status: 'UNAUTHENTICATED' } },
    sizeError: {
      error: {
        code: 413,
        message: `Uploaded file exceeds the ${FILE_UPLOAD_MULTIPART_LIMITS.fileSize} byte limit`,
        status: 'FAILED_PRECONDITION',
      },
    },
    storeError: { error: { code: 404, message: 'Gone', status: 'NOT_FOUND' } },
  },
];

function createOperations(error: unknown) {
  return {
    create: vi.fn<FilesHttpOperations['create']>().mockRejectedValue(error),
    list: vi.fn<FilesHttpOperations['list']>().mockRejectedValue(error),
    stat: vi.fn<FilesHttpOperations['stat']>().mockRejectedValue(error),
    content: vi.fn<FilesHttpOperations['content']>().mockRejectedValue(error),
    remove: vi.fn<FilesHttpOperations['remove']>().mockRejectedValue(error),
  };
}

describe('Files HTTP protocol errors', () => {
  describe.each(surfaces)('$dialect', (surface) => {
    it.each([undefined, 'Bearer wrong-key'])(
      'preserves guard denials before operations for %s',
      async (authorization) => {
        const files = createOperations(new Error('Must not run'));
        const app = await createFilesHttpApp(files);
        const reply = await app.inject({
          url: surface.url,
          headers: { ...surface.headers, ...(authorization ? { authorization } : {}) },
        });
        expect({ status: reply.statusCode, body: reply.json() }).toEqual({
          status: 401,
          body: surface.auth,
        });
        expect(files.list).not.toHaveBeenCalled();
      },
    );

    it('preserves non-Error fallbacks across list, get and delete', async () => {
      const files = createOperations('untyped rejection');
      const app = await createFilesHttpApp(files);
      for (const request of [
        { method: 'GET' as const, url: surface.url },
        { method: 'GET' as const, url: `${surface.url}/missing` },
        { method: 'DELETE' as const, url: `${surface.url}/missing` },
      ]) {
        const reply = await app.inject({
          ...request,
          headers: { ...filesTestHeaders, ...surface.headers },
        });
        expect({ status: reply.statusCode, body: reply.json() }).toEqual({
          status: 500,
          body: surface.fallback,
        });
      }
    });

    it('preserves complete store error envelopes', async () => {
      const app = await createFilesHttpApp(
        createOperations(new FileStoreError('not_found', 'Gone', 404)),
      );
      const reply = await app.inject({
        url: `${surface.url}/missing`,
        headers: { ...filesTestHeaders, ...surface.headers },
      });
      expect({ status: reply.statusCode, body: reply.json() }).toEqual({
        status: 404,
        body: surface.storeError,
      });
    });

    it('normalizes transport size failures only on upload', async () => {
      const files = createOperations({ code: 'FST_REQ_FILE_TOO_LARGE' });
      const app = await createFilesHttpApp(files);
      const upload = fileMultipartPayload([['purpose', 'user_data']], {
        bytes: Buffer.from('hello'),
        filename: 'hello.txt',
        mimeType: 'text/plain',
      });
      const reply = await app.inject({
        method: 'POST',
        url: surface.uploadUrl,
        ...upload,
        headers: { ...upload.headers, ...surface.headers },
      });
      expect({ status: reply.statusCode, body: reply.json() }).toEqual({
        status: 413,
        body: surface.sizeError,
      });
      expect(files.create).toHaveBeenCalledOnce();
      const listed = await app.inject({
        url: surface.url,
        headers: { ...filesTestHeaders, ...surface.headers },
      });
      expect({ status: listed.statusCode, body: listed.json() }).toEqual({
        status: 500,
        body: surface.fallback,
      });
    });

    it('maps handler HTTP exceptions through the existing dialect mapper', async () => {
      const app = await createFilesHttpApp(createOperations(new BadRequestException(message)));
      const reply = await app.inject({
        url: surface.url,
        headers: { ...filesTestHeaders, ...surface.headers },
      });
      expect({ status: reply.statusCode, body: reply.json() }).toEqual({
        status: 500,
        body: surface.fallback,
      });
    });
  });

  it.each([
    { method: 'GET' as const, url: '/v1/files' },
    { method: 'GET' as const, url: '/v1/files/missing' },
    { method: 'GET' as const, url: '/v1/files/missing/content' },
    { method: 'DELETE' as const, url: '/v1/files/missing' },
  ])('checks Anthropic beta before $method $url operations', async (request) => {
    const files = createOperations(new Error('Must not run'));
    const app = await createFilesHttpApp(files);
    const reply = await app.inject({
      ...request,
      headers: { ...filesTestHeaders, 'anthropic-version': '2023-06-01' },
    });
    expect({ status: reply.statusCode, body: reply.json() }).toEqual({
      status: 400,
      body: {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message:
            "The Files API requires the 'files-api-2025-04-14' beta. Send 'anthropic-beta: files-api-2025-04-14'.",
        },
      },
    });
    for (const operation of Object.values(files)) {
      expect(operation).not.toHaveBeenCalled();
    }
  });

  it('keeps the Gemini uploadType failure ahead of file parsing', async () => {
    const files = createOperations(new Error('Must not run'));
    const app = await createFilesHttpApp(files);
    const reply = await app.inject({
      method: 'POST',
      url: '/upload/v1beta/files?uploadType=resumable',
      headers: { ...filesTestHeaders, 'content-type': 'image/png' },
      payload: Buffer.from('hello'),
    });
    expect({ status: reply.statusCode, body: reply.json() }).toEqual({
      status: 400,
      body: {
        error: {
          code: 400,
          message: 'uploadType=resumable is not implemented; use media or multipart',
          status: 'INVALID_ARGUMENT',
        },
      },
    });
    expect(files.create).not.toHaveBeenCalled();
  });

  it('keeps the manual download error response without binary headers', async () => {
    const app = await createFilesHttpApp(
      createOperations(new FileStoreError('not_found', 'Gone', 404)),
    );
    const reply = await app.inject({ url: '/v1/files/missing/content', headers: filesTestHeaders });
    expect({ status: reply.statusCode, body: reply.json() }).toEqual({
      status: 404,
      body: surfaces[0].storeError,
    });
    expect(reply.headers['content-type']).toBe('application/json; charset=utf-8');
  });
});

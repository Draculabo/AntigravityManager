import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ClientFilesController } from '@/modules/proxy-gateway/server/modules/files/client-files.controller';
import { FileContentStore } from '@/modules/proxy-gateway/server/modules/files/file-content-store.service';
import { FilesService } from '@/modules/proxy-gateway/server/modules/files/files.service';
import type { FileStoreOptions } from '@/modules/proxy-gateway/server/modules/files/file-store.types';
import { OpenAIUploadsController } from '@/modules/proxy-gateway/server/modules/uploads/openai-uploads.controller';
import { OpenAIUploadsService } from '@/modules/proxy-gateway/server/modules/uploads/openai-uploads.service';
import {
  OpenAIUploadsStore,
  revivePersistedOpenAIUpload,
} from '@/modules/proxy-gateway/server/modules/uploads/openai-uploads.store';
import {
  DEFAULT_OPENAI_UPLOAD_MAX_PENDING,
  type OpenAIUploadsStoreOptions,
} from '@/modules/proxy-gateway/server/modules/uploads/openai-uploads.types';

const chunkA = Buffer.from('hello ');
const chunkB = Buffer.from('world!');
const fullBytes = Buffer.concat([chunkA, chunkB]);

function createReplyMock() {
  const reply: Record<string, unknown> = {};
  reply.status = vi.fn(() => reply);
  reply.header = vi.fn(() => reply);
  reply.send = vi.fn(() => reply);
  return reply;
}

function sent(reply: Record<string, unknown>): unknown {
  return (reply.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
}

function statusOf(reply: Record<string, unknown>): unknown {
  return (reply.status as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
}

/** A multipart request shaped the way `@fastify/multipart` hands one over. */
function createPartRequest(bytes: Buffer) {
  return {
    headers: { 'content-type': 'multipart/form-data; boundary=----agmuploads' },
    async *parts() {
      yield {
        fieldname: 'data',
        file: { resume: () => undefined, truncated: false },
        filename: 'part.bin',
        mimetype: 'application/octet-stream',
        toBuffer: async () => bytes,
        type: 'file' as const,
      };
    },
  };
}

describe('OpenAI Uploads protocol', () => {
  const roots: string[] = [];

  beforeEach(() => {
    roots.length = 0;
  });

  afterEach(() => {
    for (const root of roots) {
      rmSync(root, { force: true, maxRetries: 5, recursive: true, retryDelay: 20 });
    }
  });

  function createSurfaces(
    options: FileStoreOptions = {},
    uploadOptions: OpenAIUploadsStoreOptions = {},
  ) {
    const rootDirectory = options.rootDirectory ?? mkdtempSync(join(tmpdir(), 'agm-uploads-'));
    if (!options.rootDirectory) {
      roots.push(rootDirectory);
    }
    const store = new FileContentStore({ sweepIntervalMs: 0, ...options, rootDirectory });
    const filesService = new FilesService(store);
    const uploadsService = new OpenAIUploadsService(filesService, uploadOptions);
    return {
      files: new ClientFilesController(filesService),
      uploads: new OpenAIUploadsController(uploadsService),
      uploadsService,
      rootDirectory,
      store,
      filesService,
    };
  }

  async function createUpload(
    uploads: OpenAIUploadsController,
    overrides: Record<string, unknown> = {},
  ) {
    const reply = createReplyMock();
    await uploads.create(
      {
        bytes: fullBytes.length,
        filename: 'assembled.txt',
        mime_type: 'text/plain',
        purpose: 'user_data',
        ...overrides,
      },
      reply as never,
    );
    return { body: sent(reply) as { id: string; status: string }, status: statusOf(reply) };
  }

  async function addPart(uploads: OpenAIUploadsController, uploadId: string, bytes: Buffer) {
    const reply = createReplyMock();
    await uploads.addPart(uploadId, createPartRequest(bytes) as never, reply as never);
    return { body: sent(reply) as { id: string }, status: statusOf(reply) };
  }

  async function complete(uploads: OpenAIUploadsController, uploadId: string, partIds: string[]) {
    const reply = createReplyMock();
    await uploads.complete(uploadId, { part_ids: partIds }, reply as never);
    return { body: sent(reply) as { id: string; bytes: number }, status: statusOf(reply) };
  }

  it('assembles parts in the order part_ids asks for and stores one ordinary file', async () => {
    const { files, uploads } = createSurfaces();
    const created = await createUpload(uploads);
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ object: 'upload', status: 'pending' });

    // Posted backwards on purpose: assembly order must follow part_ids, not arrival order.
    const partB = await addPart(uploads, created.body.id, chunkB);
    const partA = await addPart(uploads, created.body.id, chunkA);

    const completed = await complete(uploads, created.body.id, [partA.body.id, partB.body.id]);

    expect(completed.status).toBe(200);
    expect(completed.body).toMatchObject({ object: 'file', bytes: fullBytes.length });

    const content = createReplyMock();
    await files.content(completed.body.id, { headers: {} } as never, content as never);
    expect(sent(content)).toEqual(fullBytes);
  });

  it('rejects completion when the assembled bytes do not match the declared count', async () => {
    const { uploads } = createSurfaces();
    const created = await createUpload(uploads);
    const part = await addPart(uploads, created.body.id, chunkA);

    const completed = await complete(uploads, created.body.id, [part.body.id]);

    expect(completed.status).toBe(400);
    expect(JSON.stringify(completed.body)).toContain('bytes');
  });

  it('answers an expired upload with an error instead of silently accepting parts', async () => {
    vi.useFakeTimers();
    try {
      const { uploads, uploadsService } = createSurfaces();
      const createdForPart = await createUpload(uploads);
      const createdForComplete = await createUpload(uploads);
      vi.setSystemTime(Date.now() + 61 * 60 * 1000);

      const partReply = createReplyMock();
      await uploads.addPart(
        createdForPart.body.id,
        createPartRequest(chunkA) as never,
        partReply as never,
      );
      expect(statusOf(partReply)).toBe(404);
      expect(sent(partReply)).toMatchObject({
        error: {
          code: 'upload_expired',
          param: 'upload_id',
        },
      });

      const completeReply = createReplyMock();
      await uploads.complete(
        createdForComplete.body.id,
        { part_ids: ['part_x'] },
        completeReply as never,
      );
      expect(statusOf(completeReply)).toBe(404);
      expect(sent(completeReply)).toMatchObject({
        error: {
          code: 'upload_expired',
          param: 'upload_id',
        },
      });

      expect(uploadsService.get(createdForPart.body.id)).toBeNull();
      expect(uploadsService.get(createdForComplete.body.id)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels an upload and releases its parts so they cannot be completed later', async () => {
    const { uploads, uploadsService } = createSurfaces();
    const created = await createUpload(uploads);
    const part = await addPart(uploads, created.body.id, chunkA);

    const cancelReply = createReplyMock();
    await uploads.cancel(created.body.id, cancelReply as never);
    expect(statusOf(cancelReply)).toBe(200);
    expect(sent(cancelReply)).toMatchObject({ status: 'cancelled' });

    expect(uploadsService.get(created.body.id)).toBeNull();

    const completed = await complete(uploads, created.body.id, [part.body.id]);
    expect(completed.status).toBe(404);
  });

  it('refuses a part whose bytes would exceed the declared upload size', async () => {
    const { uploads } = createSurfaces();
    const created = await createUpload(uploads, { bytes: 3 });

    const reply = await addPart(uploads, created.body.id, fullBytes);
    expect(reply.status).toBe(400);
  });

  it('refuses a purpose this proxy could never serve', async () => {
    const { uploads } = createSurfaces();
    const reply = createReplyMock();

    await uploads.create(
      {
        bytes: fullBytes.length,
        filename: 'x.bin',
        mime_type: 'application/octet-stream',
        purpose: 'fine-tune',
      },
      reply as never,
    );

    expect(statusOf(reply)).toBe(400);
  });

  it('reports a declared size over the per-file ceiling as 413', async () => {
    const { uploads } = createSurfaces({ maxFileBytes: 4 });
    const reply = createReplyMock();

    await uploads.create(
      {
        bytes: 128,
        filename: 'big.bin',
        mime_type: 'application/octet-stream',
        purpose: 'user_data',
      },
      reply as never,
    );

    expect(statusOf(reply)).toBe(413);
  });

  it('caps the number of incomplete uploads held at once', async () => {
    const { uploads } = createSurfaces();

    for (let index = 0; index < DEFAULT_OPENAI_UPLOAD_MAX_PENDING; index += 1) {
      const reply = await createUpload(uploads, { filename: `f${index}.bin` });
      expect(reply.status).toBe(200);
    }

    const overflow = createReplyMock();
    await uploads.create(
      {
        bytes: 1,
        filename: 'overflow.bin',
        mime_type: 'application/octet-stream',
        purpose: 'user_data',
      },
      overflow as never,
    );
    expect(statusOf(overflow)).toBe(429);
  });

  it('never lets an upload_id or part_id string reach the filesystem', async () => {
    const { uploads } = createSurfaces();

    const reply = createReplyMock();
    await uploads.addPart('../../../secrets', createPartRequest(chunkA) as never, reply as never);
    expect(statusOf(reply)).toBe(404);
  });

  it('survives process restart with file-backed durable storage', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'agm-uploads-durable-'));
    roots.push(tempDir);
    const filePath = join(tempDir, 'proxy-uploads.json');
    const fileStoreRoot = join(tempDir, 'proxy-files');

    const fileStore = new FileContentStore({ sweepIntervalMs: 0, rootDirectory: fileStoreRoot });
    const filesService = new FilesService(fileStore);

    // First instance: create upload and add part A
    const uploads1 = new OpenAIUploadsService(filesService, { filePath });
    const controller1 = new OpenAIUploadsController(uploads1);

    const created = await createUpload(controller1);
    expect(created.status).toBe(200);

    const partA = await addPart(controller1, created.body.id, chunkA);
    expect(partA.status).toBe(200);

    await uploads1.flush();
    expect(existsSync(filePath)).toBe(true);

    // Simulate process restart: instantiate new service over same state file
    const uploads2 = new OpenAIUploadsService(filesService, { filePath });
    const controller2 = new OpenAIUploadsController(uploads2);

    // Add part B on the restarted instance
    const partB = await addPart(controller2, created.body.id, chunkB);
    expect(partB.status).toBe(200);

    // Complete the upload on the restarted instance
    const completed = await complete(controller2, created.body.id, [partA.body.id, partB.body.id]);
    expect(completed.status).toBe(200);
    expect(completed.body).toMatchObject({ object: 'file', bytes: fullBytes.length });

    await uploads2.flush();

    // Verify the file content is intact in FilesService
    const clientFiles = new ClientFilesController(filesService);
    const contentReply = createReplyMock();
    await clientFiles.content(completed.body.id, { headers: {} } as never, contentReply as never);
    expect(sent(contentReply)).toEqual(fullBytes);

    // After completion, the pending session is deleted from the durable store
    expect(uploads2.get(created.body.id)).toBeNull();
  });

  it('preserves incomplete uploads across graceful shutdown and allows completion upon restart', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'agm-uploads-shutdown-'));
    roots.push(tempDir);
    const filePath = join(tempDir, 'proxy-uploads.json');
    const fileStoreRoot = join(tempDir, 'proxy-files');

    const fileStore = new FileContentStore({ sweepIntervalMs: 0, rootDirectory: fileStoreRoot });
    const filesService = new FilesService(fileStore);

    // Initial instance: create upload and add part A
    const uploads1 = new OpenAIUploadsService(filesService, { filePath });
    const controller1 = new OpenAIUploadsController(uploads1);

    const created = await createUpload(controller1);
    expect(created.status).toBe(200);

    const partA = await addPart(controller1, created.body.id, chunkA);
    expect(partA.status).toBe(200);

    // Graceful module destruction: must flush writes and NOT wipe pending records
    await uploads1.onModuleDestroy();
    expect(existsSync(filePath)).toBe(true);

    // Reopen same store on fresh service instance
    const uploads2 = new OpenAIUploadsService(filesService, { filePath });
    const controller2 = new OpenAIUploadsController(uploads2);

    // Resume session: add part B and complete
    const partB = await addPart(controller2, created.body.id, chunkB);
    expect(partB.status).toBe(200);

    const completed = await complete(controller2, created.body.id, [partA.body.id, partB.body.id]);
    expect(completed.status).toBe(200);
    expect(completed.body).toMatchObject({ object: 'file', bytes: fullBytes.length });

    await uploads2.onModuleDestroy();

    // Verify file content is intact in FilesService
    const clientFiles = new ClientFilesController(filesService);
    const contentReply = createReplyMock();
    await clientFiles.content(completed.body.id, { headers: {} } as never, contentReply as never);
    expect(sent(contentReply)).toEqual(fullBytes);
  });

  it('drops malformed or corrupted records from disk upon revival', () => {
    expect(revivePersistedOpenAIUpload(null)).toBeNull();
    expect(revivePersistedOpenAIUpload({})).toBeNull();
    expect(
      revivePersistedOpenAIUpload({
        id: 'invalid_prefix',
        bytes: 10,
        filename: 'a.txt',
        purpose: 'user_data',
        mimeType: 'text/plain',
        createdAtMs: 1000,
        expiresAtMs: 2000,
        parts: [],
      }),
    ).toBeNull();

    // Valid revival
    const valid = revivePersistedOpenAIUpload({
      id: 'upload_123',
      bytes: 6,
      filename: 'a.txt',
      purpose: 'user_data',
      mimeType: 'text/plain',
      createdAtMs: 1000,
      expiresAtMs: 2000,
      parts: [
        {
          id: 'part_456',
          bytesBase64: chunkA.toString('base64'),
          createdAtMs: 1100,
        },
      ],
    });
    expect(valid).not.toBeNull();
    expect(valid?.id).toBe('upload_123');
    expect(valid?.parts).toHaveLength(1);

    // Part bytes exceeding declared upload bytes
    const overflow = revivePersistedOpenAIUpload({
      id: 'upload_123',
      bytes: 2,
      filename: 'a.txt',
      purpose: 'user_data',
      mimeType: 'text/plain',
      createdAtMs: 1000,
      expiresAtMs: 2000,
      parts: [
        {
          id: 'part_456',
          bytesBase64: chunkA.toString('base64'), // 6 bytes > 2 bytes
          createdAtMs: 1100,
        },
      ],
    });
    expect(overflow).toBeNull();

    // Malformed base64: non-base64 characters
    expect(
      revivePersistedOpenAIUpload({
        id: 'upload_123',
        bytes: 6,
        filename: 'a.txt',
        purpose: 'user_data',
        mimeType: 'text/plain',
        createdAtMs: 1000,
        expiresAtMs: 2000,
        parts: [
          {
            id: 'part_456',
            bytesBase64: 'invalid!base64',
            createdAtMs: 1100,
          },
        ],
      }),
    ).toBeNull();

    // Malformed base64: wrong length / missing padding
    expect(
      revivePersistedOpenAIUpload({
        id: 'upload_123',
        bytes: 6,
        filename: 'a.txt',
        purpose: 'user_data',
        mimeType: 'text/plain',
        createdAtMs: 1000,
        expiresAtMs: 2000,
        parts: [
          {
            id: 'part_456',
            bytesBase64: 'abc',
            createdAtMs: 1100,
          },
        ],
      }),
    ).toBeNull();

    // Malformed base64: invalid padding
    expect(
      revivePersistedOpenAIUpload({
        id: 'upload_123',
        bytes: 6,
        filename: 'a.txt',
        purpose: 'user_data',
        mimeType: 'text/plain',
        createdAtMs: 1000,
        expiresAtMs: 2000,
        parts: [
          {
            id: 'part_456',
            bytesBase64: '====',
            createdAtMs: 1100,
          },
        ],
      }),
    ).toBeNull();

    // Malformed base64: empty string
    expect(
      revivePersistedOpenAIUpload({
        id: 'upload_123',
        bytes: 6,
        filename: 'a.txt',
        purpose: 'user_data',
        mimeType: 'text/plain',
        createdAtMs: 1000,
        expiresAtMs: 2000,
        parts: [
          {
            id: 'part_456',
            bytesBase64: '',
            createdAtMs: 1100,
          },
        ],
      }),
    ).toBeNull();

    // Non-canonical base64: non-canonical padding bits (ZE== decodes to 0x64 but canonical is ZA==)
    expect(
      revivePersistedOpenAIUpload({
        id: 'upload_123',
        bytes: 6,
        filename: 'a.txt',
        purpose: 'user_data',
        mimeType: 'text/plain',
        createdAtMs: 1000,
        expiresAtMs: 2000,
        parts: [
          {
            id: 'part_456',
            bytesBase64: 'ZE==',
            createdAtMs: 1100,
          },
        ],
      }),
    ).toBeNull();
  });

  it('implements bounded in-memory storage when no path is provided', () => {
    const store = new OpenAIUploadsStore({ maxPendingUploads: 2, ttlMs: 10_000 });
    expect(store.size).toBe(0);

    const now = Date.now();
    const partsMap = new Map();
    partsMap.set('part_1', { id: 'part_1', bytes: chunkA, createdAtMs: now });

    store.save({
      id: 'upload_1',
      bytes: 6,
      filename: '1.txt',
      purpose: 'user_data',
      mimeType: 'text/plain',
      createdAtMs: now,
      expiresAtMs: now + 10_000,
      parts: partsMap,
    });

    expect(store.size).toBe(1);
    expect(store.get('upload_1')?.filename).toBe('1.txt');
    expect(store.get('not_an_upload_id')).toBeNull();

    store.save({
      id: 'upload_2',
      bytes: 6,
      filename: '2.txt',
      purpose: 'user_data',
      mimeType: 'text/plain',
      createdAtMs: now,
      expiresAtMs: now + 10_000,
      parts: new Map(),
    });

    store.save({
      id: 'upload_3',
      bytes: 6,
      filename: '3.txt',
      purpose: 'user_data',
      mimeType: 'text/plain',
      createdAtMs: now,
      expiresAtMs: now + 10_000,
      parts: new Map(),
    });

    // maxPendingUploads is 2, so oldest (upload_1) was evicted
    expect(store.size).toBe(2);
    expect(store.get('upload_1')).toBeNull();
    expect(store.get('upload_2')).not.toBeNull();
    expect(store.get('upload_3')).not.toBeNull();

    expect(store.delete('upload_2')).toBe(true);
    expect(store.size).toBe(1);
    store.clear();
    expect(store.size).toBe(0);
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ClientFilesController } from '@/modules/proxy-gateway/server/modules/files/client-files.controller';
import { FileContentStore } from '@/modules/proxy-gateway/server/modules/files/file-content-store.service';
import { FileResourceKernel } from '@/modules/proxy-gateway/server/modules/files/file-resource.kernel';
import type { FileStoreOptions } from '@/modules/proxy-gateway/server/modules/files/file-store.types';
import { OpenAIUploadsController } from '@/modules/proxy-gateway/server/modules/uploads/openai-uploads.controller';
import { OpenAIUploadsService } from '@/modules/proxy-gateway/server/modules/uploads/openai-uploads.service';
import { DEFAULT_OPENAI_UPLOAD_MAX_PENDING } from '@/modules/proxy-gateway/server/modules/uploads/openai-uploads.types';

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
      // Windows keeps a handle for a moment after the last write resolves.
      rmSync(root, { force: true, maxRetries: 5, recursive: true, retryDelay: 20 });
    }
  });

  function createSurfaces(options: FileStoreOptions = {}) {
    const rootDirectory = options.rootDirectory ?? mkdtempSync(join(tmpdir(), 'agm-uploads-'));
    if (!options.rootDirectory) {
      roots.push(rootDirectory);
    }
    const store = new FileContentStore({ sweepIntervalMs: 0, ...options, rootDirectory });
    const uploadsService = new OpenAIUploadsService(store);
    return {
      files: new ClientFilesController(new FileResourceKernel(store)),
      uploads: new OpenAIUploadsController(uploadsService),
      uploadsService,
      rootDirectory,
      store,
    };
  }

  function createUpload(uploads: OpenAIUploadsController, overrides: Record<string, unknown> = {}) {
    const reply = createReplyMock();
    uploads.create(
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
    const created = createUpload(uploads);
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
    const created = createUpload(uploads);
    const part = await addPart(uploads, created.body.id, chunkA);

    const completed = await complete(uploads, created.body.id, [part.body.id]);

    expect(completed.status).toBe(400);
    expect(JSON.stringify(completed.body)).toContain('bytes');
  });

  it('answers an expired upload with an error instead of silently accepting parts', async () => {
    // A frozen clock jump rather than vi.advanceTimersByTime: advancing fake timers would
    // also fire the service's own periodic sweep, which independently evicts expired
    // entries and would mask a broken expiry check in requirePending itself.
    vi.useFakeTimers();
    try {
      const { uploads, uploadsService } = createSurfaces();
      const created = createUpload(uploads);
      vi.setSystemTime(Date.now() + 61 * 60 * 1000);

      const partReply = createReplyMock();
      await uploads.addPart(
        created.body.id,
        createPartRequest(chunkA) as never,
        partReply as never,
      );
      expect(statusOf(partReply)).toBe(404);

      const completeReply = createReplyMock();
      await uploads.complete(created.body.id, { part_ids: ['part_x'] }, completeReply as never);
      expect(statusOf(completeReply)).toBe(404);

      // requirePending also evicts the expired entry from the in-memory map.
      expect(Reflect.get(uploadsService, 'uploads').has(created.body.id)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels an upload and releases its parts so they cannot be completed later', async () => {
    const { uploads, uploadsService } = createSurfaces();
    const created = createUpload(uploads);
    const part = await addPart(uploads, created.body.id, chunkA);

    const cancelReply = createReplyMock();
    uploads.cancel(created.body.id, cancelReply as never);
    expect(statusOf(cancelReply)).toBe(200);
    expect(sent(cancelReply)).toMatchObject({ status: 'cancelled' });

    expect(Reflect.get(uploadsService, 'uploads').has(created.body.id)).toBe(false);

    const completed = await complete(uploads, created.body.id, [part.body.id]);
    expect(completed.status).toBe(404);
  });

  it('refuses a part whose bytes would exceed the declared upload size', async () => {
    const { uploads } = createSurfaces();
    const created = createUpload(uploads, { bytes: 3 });

    const reply = await addPart(uploads, created.body.id, fullBytes);
    expect(reply.status).toBe(400);
  });

  it('refuses a purpose this proxy could never serve', async () => {
    const { uploads } = createSurfaces();
    const reply = createReplyMock();

    uploads.create(
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

    uploads.create(
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

  it('caps the number of incomplete uploads held at once', () => {
    const { uploads } = createSurfaces();

    for (let index = 0; index < DEFAULT_OPENAI_UPLOAD_MAX_PENDING; index += 1) {
      const reply = createUpload(uploads, { filename: `f${index}.bin` });
      expect(reply.status).toBe(200);
    }

    const overflow = createReplyMock();
    uploads.create(
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
});

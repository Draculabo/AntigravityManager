import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { FileContentStore } from '@/modules/proxy-gateway/server/modules/files/file-content-store.service';
import { FilesService } from '@/modules/proxy-gateway/server/modules/files/files.service';
import type { FileStoreOptions } from '@/modules/proxy-gateway/server/modules/files/file-store.types';
import { OpenAIUploadsService } from '@/modules/proxy-gateway/server/modules/uploads/openai-uploads.service';
import {
  DEFAULT_OPENAI_UPLOAD_MAX_PENDING,
  type OpenAIUploadsStoreOptions,
} from '@/modules/proxy-gateway/server/modules/uploads/openai-uploads.types';
import {
  createFilesHttpApp,
  fileMultipartPayload,
  filesTestHeaders,
  type UploadsHttpOperations,
} from '../helpers/files-http-app';

const chunkA = Buffer.from('hello ');
const chunkB = Buffer.from('world!');
const fullBytes = Buffer.concat([chunkA, chunkB]);

/** Uses actual multipart bytes with the Uploads protocol's data field. */
function createPartRequest(bytes: Buffer) {
  return fileMultipartPayload(
    [],
    { bytes, filename: 'part.bin', mimeType: 'application/octet-stream' },
    'data',
  );
}

describe('OpenAI Uploads protocol', () => {
  const roots: string[] = [];
  const apps: NestFastifyApplication[] = [];
  async function createApp(files: FilesService, uploads?: UploadsHttpOperations) {
    const app = await createFilesHttpApp(files, uploads);
    apps.push(app);
    return app;
  }

  beforeEach(() => {
    roots.length = 0;
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    for (const root of roots) {
      rmSync(root, { force: true, maxRetries: 5, recursive: true, retryDelay: 20 });
    }
  });

  async function createSurfaces(
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
    const app = await createApp(filesService, uploadsService);
    return {
      files: app,
      uploads: app,
      uploadsService,
      rootDirectory,
      store,
      filesService,
    };
  }

  async function createUpload(
    uploads: NestFastifyApplication,
    overrides: Record<string, unknown> = {},
  ) {
    const reply = await uploads.inject({
      method: 'POST',
      url: '/v1/uploads',
      headers: filesTestHeaders,
      payload: {
        bytes: fullBytes.length,
        filename: 'assembled.txt',
        mime_type: 'text/plain',
        purpose: 'user_data',
        ...overrides,
      },
    });
    return { body: reply.json<{ id: string; status: string }>(), status: reply.statusCode };
  }

  async function addPart(uploads: NestFastifyApplication, uploadId: string, bytes: Buffer) {
    const reply = await uploads.inject({
      method: 'POST',
      url: '/v1/uploads/' + encodeURIComponent(uploadId) + '/parts',
      ...createPartRequest(bytes),
    });
    return { body: reply.json<{ id: string }>(), status: reply.statusCode };
  }

  async function complete(uploads: NestFastifyApplication, uploadId: string, partIds: string[]) {
    const reply = await uploads.inject({
      method: 'POST',
      url: '/v1/uploads/' + encodeURIComponent(uploadId) + '/complete',
      headers: filesTestHeaders,
      payload: { part_ids: partIds },
    });
    return { body: reply.json<{ id: string; bytes: number }>(), status: reply.statusCode };
  }

  it('assembles parts in the order part_ids asks for and stores one ordinary file', async () => {
    const { files, uploads } = await createSurfaces();
    const created = await createUpload(uploads);
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ object: 'upload', status: 'pending' });

    // Posted backwards on purpose: assembly order must follow part_ids, not arrival order.
    const partB = await addPart(uploads, created.body.id, chunkB);
    const partA = await addPart(uploads, created.body.id, chunkA);

    const completed = await complete(uploads, created.body.id, [partA.body.id, partB.body.id]);

    expect(completed.status).toBe(200);
    expect(completed.body).toMatchObject({ object: 'file', bytes: fullBytes.length });

    const content = await files.inject({
      url: '/v1/files/' + encodeURIComponent(completed.body.id) + '/content',
      headers: filesTestHeaders,
    });
    expect(content.rawPayload).toEqual(fullBytes);
  });

  it('rejects completion when the assembled bytes do not match the declared count', async () => {
    const { uploads } = await createSurfaces();
    const created = await createUpload(uploads);
    const part = await addPart(uploads, created.body.id, chunkA);

    const completed = await complete(uploads, created.body.id, [part.body.id]);

    expect(completed.status).toBe(400);
    expect(JSON.stringify(completed.body)).toContain('bytes');
  });

  it('answers an expired upload with an error instead of silently accepting parts', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { uploads, uploadsService } = await createSurfaces();
      const createdForPart = await createUpload(uploads);
      const createdForComplete = await createUpload(uploads);
      vi.setSystemTime(Date.now() + 61 * 60 * 1000);

      const partReply = await uploads.inject({
        method: 'POST',
        url: '/v1/uploads/' + encodeURIComponent(createdForPart.body.id) + '/parts',
        ...createPartRequest(chunkA),
      });
      expect(partReply.statusCode).toBe(404);
      expect(partReply.json()).toMatchObject({
        error: {
          code: 'upload_expired',
          param: 'upload_id',
        },
      });

      const completeReply = await uploads.inject({
        method: 'POST',
        url: '/v1/uploads/' + encodeURIComponent(createdForComplete.body.id) + '/complete',
        headers: filesTestHeaders,
        payload: { part_ids: ['part_x'] },
      });
      expect(completeReply.statusCode).toBe(404);
      expect(completeReply.json()).toMatchObject({
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
    const { uploads, uploadsService } = await createSurfaces();
    const created = await createUpload(uploads);
    const part = await addPart(uploads, created.body.id, chunkA);

    const cancelReply = await uploads.inject({
      method: 'POST',
      url: '/v1/uploads/' + encodeURIComponent(created.body.id) + '/cancel',
      headers: filesTestHeaders,
    });
    expect(cancelReply.statusCode).toBe(200);
    expect(cancelReply.json()).toMatchObject({ status: 'cancelled' });

    expect(uploadsService.get(created.body.id)).toBeNull();

    const completed = await complete(uploads, created.body.id, [part.body.id]);
    expect(completed.status).toBe(404);
  });

  it('refuses a part whose bytes would exceed the declared upload size', async () => {
    const { uploads } = await createSurfaces();
    const created = await createUpload(uploads, { bytes: 3 });

    const reply = await addPart(uploads, created.body.id, fullBytes);
    expect(reply.status).toBe(400);
  });

  it('refuses a purpose this proxy could never serve', async () => {
    const { uploads } = await createSurfaces();

    const reply = await uploads.inject({
      method: 'POST',
      url: '/v1/uploads',
      headers: filesTestHeaders,
      payload: {
        bytes: fullBytes.length,
        filename: 'x.bin',
        mime_type: 'application/octet-stream',
        purpose: 'fine-tune',
      },
    });

    expect(reply.statusCode).toBe(400);
  });

  it('reports a declared size over the per-file ceiling as 413', async () => {
    const { uploads } = await createSurfaces({ maxFileBytes: 4 });

    const reply = await uploads.inject({
      method: 'POST',
      url: '/v1/uploads',
      headers: filesTestHeaders,
      payload: {
        bytes: 128,
        filename: 'big.bin',
        mime_type: 'application/octet-stream',
        purpose: 'user_data',
      },
    });

    expect(reply.statusCode).toBe(413);
  });

  it('caps the number of incomplete uploads held at once', async () => {
    const { uploads } = await createSurfaces();

    for (let index = 0; index < DEFAULT_OPENAI_UPLOAD_MAX_PENDING; index += 1) {
      const reply = await createUpload(uploads, { filename: `f${index}.bin` });
      expect(reply.status).toBe(200);
    }

    const overflow = await uploads.inject({
      method: 'POST',
      url: '/v1/uploads',
      headers: filesTestHeaders,
      payload: {
        bytes: 1,
        filename: 'overflow.bin',
        mime_type: 'application/octet-stream',
        purpose: 'user_data',
      },
    });
    expect(overflow.statusCode).toBe(429);
  });

  it('never lets an upload_id or part_id string reach the filesystem', async () => {
    const { uploads } = await createSurfaces();

    const reply = await uploads.inject({
      method: 'POST',
      url: '/v1/uploads/' + encodeURIComponent('../../../secrets') + '/parts',
      ...createPartRequest(chunkA),
    });
    expect(reply.statusCode).toBe(404);
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
    const controller1 = await createApp(filesService, uploads1);

    const created = await createUpload(controller1);
    expect(created.status).toBe(200);

    const partA = await addPart(controller1, created.body.id, chunkA);
    expect(partA.status).toBe(200);

    await uploads1.flush();
    expect(existsSync(filePath)).toBe(true);

    // Simulate process restart: instantiate new service over same state file
    const uploads2 = new OpenAIUploadsService(filesService, { filePath });
    const controller2 = await createApp(filesService, uploads2);

    // Add part B on the restarted instance
    const partB = await addPart(controller2, created.body.id, chunkB);
    expect(partB.status).toBe(200);

    // Complete the upload on the restarted instance
    const completed = await complete(controller2, created.body.id, [partA.body.id, partB.body.id]);
    expect(completed.status).toBe(200);
    expect(completed.body).toMatchObject({ object: 'file', bytes: fullBytes.length });

    await uploads2.flush();

    // Verify the file content is intact in FilesService
    const clientFiles = await createApp(filesService);

    const contentReply = await clientFiles.inject({
      url: '/v1/files/' + encodeURIComponent(completed.body.id) + '/content',
      headers: filesTestHeaders,
    });
    expect(contentReply.rawPayload).toEqual(fullBytes);

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
    const controller1 = await createApp(filesService, uploads1);

    const created = await createUpload(controller1);
    expect(created.status).toBe(200);

    const partA = await addPart(controller1, created.body.id, chunkA);
    expect(partA.status).toBe(200);

    // Graceful module destruction: must flush writes and NOT wipe pending records
    await uploads1.onModuleDestroy();
    expect(existsSync(filePath)).toBe(true);

    // Reopen same store on fresh service instance
    const uploads2 = new OpenAIUploadsService(filesService, { filePath });
    const controller2 = await createApp(filesService, uploads2);

    // Resume session: add part B and complete
    const partB = await addPart(controller2, created.body.id, chunkB);
    expect(partB.status).toBe(200);

    const completed = await complete(controller2, created.body.id, [partA.body.id, partB.body.id]);
    expect(completed.status).toBe(200);
    expect(completed.body).toMatchObject({ object: 'file', bytes: fullBytes.length });

    await uploads2.onModuleDestroy();

    // Verify file content is intact in FilesService
    const clientFiles = await createApp(filesService);

    const contentReply = await clientFiles.inject({
      url: '/v1/files/' + encodeURIComponent(completed.body.id) + '/content',
      headers: filesTestHeaders,
    });
    expect(contentReply.rawPayload).toEqual(fullBytes);
  });
});

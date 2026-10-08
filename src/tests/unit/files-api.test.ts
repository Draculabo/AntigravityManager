import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FileContentStore } from '@/modules/proxy-gateway/server/modules/files/file-content-store.service';
import { FilesService } from '@/modules/proxy-gateway/server/modules/files/files.service';
import type { FileStoreOptions } from '@/modules/proxy-gateway/server/modules/files/file-store.types';
import {
  createFilesHttpApp,
  fileMultipartPayload,
  filesTestHeaders,
  type MultipartFile,
} from '../helpers/files-http-app';

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(24, 9),
]);
const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(16, 4)]);
const ANTHROPIC_HEADERS = {
  ...filesTestHeaders,
  'anthropic-version': '2023-06-01',
  'anthropic-beta': 'files-api-2025-04-14',
};

describe('local files API', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      // Windows keeps a handle for a moment after the last write resolves.
      rmSync(root, { force: true, maxRetries: 5, recursive: true, retryDelay: 20 });
    }
  });

  async function createSurfaces(options: FileStoreOptions = {}) {
    const rootDirectory = options.rootDirectory ?? mkdtempSync(join(tmpdir(), 'agm-files-'));
    if (!options.rootDirectory) {
      roots.push(rootDirectory);
    }
    const store = new FileContentStore({ sweepIntervalMs: 0, ...options, rootDirectory });
    const files = new FilesService(store);
    return { app: await createFilesHttpApp(files), files, rootDirectory, store };
  }

  async function uploadOpenAI(app: NestFastifyApplication, file: MultipartFile) {
    const reply = await app.inject({
      method: 'POST',
      url: '/v1/files',
      ...fileMultipartPayload([['purpose', 'user_data']], file),
    });
    return { body: reply.json<{ id: string }>(), status: reply.statusCode };
  }

  it('serves an uploaded file back to the surface that stored it', async () => {
    const { app } = await createSurfaces();
    const uploaded = await uploadOpenAI(app, {
      bytes: png,
      filename: 'shot.png',
      mimeType: 'image/png',
    });
    const metadata = await app.inject({
      url: `/v1/files/${uploaded.body.id}`,
      headers: filesTestHeaders,
    });
    const content = await app.inject({
      url: `/v1/files/${uploaded.body.id}/content`,
      headers: filesTestHeaders,
    });
    expect(uploaded.status).toBe(200);
    expect(uploaded.body).toMatchObject({
      object: 'file',
      bytes: png.length,
      filename: 'shot.png',
      purpose: 'user_data',
      status: 'processed',
    });
    expect(uploaded.body.id).toMatch(/^file-[0-9a-f]{32}$/u);
    expect(metadata.json()).toMatchObject({ id: uploaded.body.id });
    expect(content.rawPayload).toEqual(png);
    expect({
      type: content.headers['content-type'],
      length: content.headers['content-length'],
    }).toEqual({ type: 'image/png', length: String(png.length) });
  });

  it('answers the dialect the request asked for, at the same path', async () => {
    const { app } = await createSurfaces();
    const upload = fileMultipartPayload([], {
      bytes: pdf,
      filename: 'contract.pdf',
      mimeType: 'application/pdf',
    });
    const reply = await app.inject({
      method: 'POST',
      url: '/v1/files',
      ...upload,
      headers: { ...upload.headers, ...ANTHROPIC_HEADERS },
    });
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({
      type: 'file',
      filename: 'contract.pdf',
      mime_type: 'application/pdf',
      size_bytes: pdf.length,
      downloadable: true,
    });
    expect(reply.json<{ id: string }>().id).toMatch(/^file_[0-9a-f]{32}$/u);
  });

  it('names the beta an Anthropic client has to send instead of guessing', async () => {
    const { app } = await createSurfaces();
    const upload = fileMultipartPayload([], {
      bytes: pdf,
      filename: 'c.pdf',
      mimeType: 'application/pdf',
    });
    const reply = await app.inject({
      method: 'POST',
      url: '/v1/files',
      ...upload,
      headers: { ...upload.headers, 'anthropic-version': '2023-06-01' },
    });
    expect(reply.statusCode).toBe(400);
    expect(reply.body).toContain('files-api-2025-04-14');
  });

  it('stores identical bytes once and hands back the same handle', async () => {
    const { app, rootDirectory } = await createSurfaces();
    const first = await uploadOpenAI(app, {
      bytes: png,
      filename: 'first.png',
      mimeType: 'image/png',
    });
    const second = await uploadOpenAI(app, {
      bytes: png,
      filename: 'second.png',
      mimeType: 'image/png',
    });
    expect(second.body.id).toBe(first.body.id);
    const shards = readdirSync(join(rootDirectory, 'blobs'));
    expect(shards).toHaveLength(1);
    expect(readdirSync(join(rootDirectory, 'blobs', shards[0]))).toHaveLength(1);
  });

  it('corrects a mislabelled upload at the door, not at generation time', async () => {
    const { app } = await createSurfaces();
    const uploaded = await uploadOpenAI(app, {
      bytes: png,
      filename: 'not-really.txt',
      mimeType: 'text/plain',
    });
    const reply = await app.inject({
      url: `/v1/files/${uploaded.body.id}`,
      headers: ANTHROPIC_HEADERS,
    });
    expect(reply.json()).toMatchObject({ mime_type: 'image/png' });
  });

  it('refuses a handle it never issued without letting the string reach the disk', async () => {
    const { app, rootDirectory } = await createSurfaces();
    for (const id of ['../../../secrets', 'file-not-a-real-handle']) {
      const reply = await app.inject({
        url: `/v1/files/${encodeURIComponent(id)}`,
        headers: filesTestHeaders,
      });
      expect(reply.statusCode).toBe(404);
    }
    // The handle is matched before the store opens or lists any directory.
    expect(readdirSync(rootDirectory)).toEqual([]);
  });

  it('reports a file over the per-file ceiling as 413, not as a generic failure', async () => {
    const { app } = await createSurfaces({ maxFileBytes: 64 });
    const uploaded = await uploadOpenAI(app, {
      bytes: Buffer.alloc(128, 1),
      filename: 'big.bin',
      mimeType: 'application/octet-stream',
    });
    expect(uploaded.status).toBe(413);
  });

  it('refuses a purpose this proxy could never serve', async () => {
    const { app } = await createSurfaces();
    const reply = await app.inject({
      method: 'POST',
      url: '/v1/files',
      ...fileMultipartPayload([['purpose', 'fine-tune']], {
        bytes: png,
        filename: 'shot.png',
        mimeType: 'image/png',
      }),
    });
    expect(reply.statusCode).toBe(400);
    expect(reply.body).toContain('fine-tune');
  });

  it('accepts Google’s simple upload and answers with a files/ resource', async () => {
    const { app } = await createSurfaces();
    const reply = await app.inject({
      method: 'POST',
      url: '/upload/v1beta/files',
      headers: { ...filesTestHeaders, 'content-type': 'image/png' },
      payload: png,
    });
    const listed = await app.inject({ url: '/v1beta/files', headers: filesTestHeaders });
    const resource = reply.json<{ file: { name: string; sizeBytes: string } }>();
    expect(reply.statusCode).toBe(200);
    expect(resource.file.name).toMatch(/^files\/[0-9a-f]{32}$/u);
    expect(resource.file.sizeBytes).toBe(String(png.length));
    expect(listed.body).toContain(resource.file.name);
  });

  it.each([
    [
      'nested metadata',
      { file: ['not-an-object'], displayName: 'Ignored name' },
      'multipart-name.png',
    ],
    [
      'preferred display-name metadata',
      { file: { display_name: 42, displayName: 'Ignored name' } },
      'preferred-name-fallback.png',
    ],
  ])(
    'uses the multipart filename when Gemini %s is malformed',
    async (_label, metadata, filename) => {
      const { app } = await createSurfaces();
      const reply = await app.inject({
        method: 'POST',
        url: '/upload/v1beta/files',
        ...fileMultipartPayload([['metadata', JSON.stringify(metadata)]], {
          bytes: png,
          filename,
          mimeType: 'image/png',
        }),
      });
      expect(reply.statusCode).toBe(200);
      expect(reply.json()).toMatchObject({ file: { displayName: filename } });
    },
  );

  it('preserves each client dialect list envelope and shared cursor semantics', async () => {
    const { app } = await createSurfaces();
    await uploadOpenAI(app, { bytes: png, filename: 'shot.png', mimeType: 'image/png' });
    await uploadOpenAI(app, { bytes: pdf, filename: 'contract.pdf', mimeType: 'application/pdf' });
    const firstPage = await app.inject({ url: '/v1/files?limit=1', headers: filesTestHeaders });
    const firstBody = firstPage.json<{ data: Array<{ id: string }> }>();
    expect(firstPage.json()).toEqual({
      object: 'list',
      data: [expect.objectContaining({ id: expect.stringMatching(/^file-[0-9a-f]{32}$/u) })],
      has_more: true,
    });
    const secondPage = await app.inject({
      url: `/v1/files?limit=1&after=${firstBody.data[0].id}`,
      headers: ANTHROPIC_HEADERS,
    });
    const secondBody = secondPage.json<{ data: Array<{ id: string }> }>();
    expect(secondPage.json()).toEqual({
      data: [expect.objectContaining({ id: expect.stringMatching(/^file_[0-9a-f]{32}$/u) })],
      has_more: true,
      first_id: secondBody.data[0].id,
      last_id: secondBody.data[0].id,
    });
  });

  it('uses the shared page token and delete behavior on the Gemini surface', async () => {
    const { app } = await createSurfaces();
    const first = await uploadOpenAI(app, {
      bytes: png,
      filename: 'shot.png',
      mimeType: 'image/png',
    });
    await uploadOpenAI(app, { bytes: pdf, filename: 'contract.pdf', mimeType: 'application/pdf' });
    const firstPage = await app.inject({
      url: '/v1beta/files?pageSize=1',
      headers: filesTestHeaders,
    });
    const firstBody = firstPage.json<{ files: Array<{ name: string }>; nextPageToken: string }>();
    expect(firstBody.files).toHaveLength(1);
    expect(firstBody.nextPageToken).toMatch(/^[0-9a-f]{32}$/u);
    const secondPage = await app.inject({
      url: `/v1beta/files?pageSize=1&pageToken=${firstBody.nextPageToken}`,
      headers: filesTestHeaders,
    });
    expect(secondPage.json<{ files: unknown[] }>().files).toHaveLength(1);
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1beta/files/${first.body.id}`,
      headers: filesTestHeaders,
    });
    expect({ status: deleted.statusCode, body: deleted.json() }).toEqual({ status: 200, body: {} });
    const afterDelete = await app.inject({
      url: `/v1/files/${first.body.id}`,
      headers: filesTestHeaders,
    });
    expect(afterDelete.statusCode).toBe(404);
  });

  it('lets one surface read what another one uploaded', async () => {
    const { app } = await createSurfaces();
    const uploaded = await uploadOpenAI(app, {
      bytes: pdf,
      filename: 'shared.pdf',
      mimeType: 'application/pdf',
    });
    const handle = uploaded.body.id.replace(/^file-/u, '');
    const reply = await app.inject({ url: `/v1beta/files/${handle}`, headers: filesTestHeaders });
    expect(reply.statusCode).toBe(200);
    expect(reply.body).toContain(handle);
  });

  it('routes both controller families through the same Files service', async () => {
    const { app, files } = await createSurfaces();
    const uploaded = await uploadOpenAI(app, {
      bytes: pdf,
      filename: 'shared.pdf',
      mimeType: 'application/pdf',
    });
    const stat = vi.spyOn(files, 'stat');
    const viaClient = await app.inject({
      url: `/v1/files/${uploaded.body.id}`,
      headers: filesTestHeaders,
    });
    const viaGemini = await app.inject({
      url: `/v1beta/files/${uploaded.body.id}`,
      headers: filesTestHeaders,
    });
    expect(stat.mock.calls).toEqual([[uploaded.body.id], [uploaded.body.id]]);
    expect(viaClient.statusCode).toBe(200);
    expect(viaGemini.statusCode).toBe(200);
  });

  it('reports an expired handle as expired and stops serving its content', async () => {
    const { app } = await createSurfaces({ ttlMs: 1 });
    const uploaded = await uploadOpenAI(app, {
      bytes: png,
      filename: 'brief.png',
      mimeType: 'image/png',
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const reply = await app.inject({
      url: `/v1/files/${uploaded.body.id}/content`,
      headers: filesTestHeaders,
    });
    expect(reply.statusCode).toBe(404);
  });

  it('forgets a deleted file on every surface', async () => {
    const { app } = await createSurfaces();
    const uploaded = await uploadOpenAI(app, {
      bytes: png,
      filename: 'doomed.png',
      mimeType: 'image/png',
    });
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/files/${uploaded.body.id}`,
      headers: filesTestHeaders,
    });
    const afterDelete = await app.inject({
      url: `/v1beta/files/${uploaded.body.id.replace(/^file-/u, '')}`,
      headers: filesTestHeaders,
    });
    expect(deleted.json()).toMatchObject({ deleted: true, object: 'file' });
    expect(afterDelete.statusCode).toBe(404);
  });

  it('serves uploads made before a restart', async () => {
    const first = await createSurfaces();
    const uploaded = await uploadOpenAI(first.app, {
      bytes: pdf,
      filename: 'kept.pdf',
      mimeType: 'application/pdf',
    });
    const restarted = await createSurfaces({ rootDirectory: first.rootDirectory });
    const reply = await restarted.app.inject({
      url: `/v1/files/${uploaded.body.id}/content`,
      headers: filesTestHeaders,
    });
    expect(reply.statusCode).toBe(200);
    expect(reply.rawPayload).toEqual(pdf);
  });
});

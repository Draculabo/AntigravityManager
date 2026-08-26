import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ClientFilesController } from '@/modules/proxy-gateway/server/modules/files/client-files.controller';
import { FileContentStore } from '@/modules/proxy-gateway/server/modules/files/file-content-store.service';
import { FilesService } from '@/modules/proxy-gateway/server/modules/files/files.service';
import { GeminiFilesController } from '@/modules/proxy-gateway/server/modules/files/gemini-files.controller';
import type { FileStoreOptions } from '@/modules/proxy-gateway/server/modules/files/file-store.types';

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(24, 9),
]);
const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(16, 4)]);

const OPENAI_UPLOAD_FIELDS: Array<[string, string]> = [['purpose', 'user_data']];
const ANTHROPIC_HEADERS = {
  'anthropic-version': '2023-06-01',
  'anthropic-beta': 'files-api-2025-04-14',
};

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
function createMultipartRequest(
  fields: Array<[string, string]>,
  file: { bytes: Buffer; filename: string; mimeType: string } | null,
  headers: Record<string, string> = {},
) {
  return {
    headers: { 'content-type': 'multipart/form-data; boundary=----agmfiles', ...headers },
    async *parts() {
      for (const [fieldname, value] of fields) {
        yield { fieldname, type: 'field' as const, value, valueTruncated: false };
      }
      if (file) {
        yield {
          fieldname: 'file',
          file: { resume: () => undefined, truncated: false },
          filename: file.filename,
          mimetype: file.mimeType,
          toBuffer: async () => file.bytes,
          type: 'file' as const,
        };
      }
    },
  };
}

/** Google's simple upload: the body is the file and the header names its type. */
function createRawRequest(mimeType: string, bytes: Buffer, headers: Record<string, string> = {}) {
  return { body: bytes, headers: { 'content-type': mimeType, ...headers } };
}

describe('local files API', () => {
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
    const rootDirectory = options.rootDirectory ?? mkdtempSync(join(tmpdir(), 'agm-files-'));
    if (!options.rootDirectory) {
      roots.push(rootDirectory);
    }
    const store = new FileContentStore({ sweepIntervalMs: 0, ...options, rootDirectory });
    const files = new FilesService(store);
    return {
      client: new ClientFilesController(files),
      files,
      gemini: new GeminiFilesController(files),
      rootDirectory,
      store,
    };
  }

  async function uploadOpenAI(
    client: ClientFilesController,
    file: { bytes: Buffer; filename: string; mimeType: string },
  ) {
    const reply = createReplyMock();
    await client.upload(
      createMultipartRequest(OPENAI_UPLOAD_FIELDS, file) as never,
      reply as never,
    );
    return { body: sent(reply) as { id: string }, status: statusOf(reply) };
  }

  it('serves an uploaded file back to the surface that stored it', async () => {
    const { client } = createSurfaces();
    const uploaded = await uploadOpenAI(client, {
      bytes: png,
      filename: 'shot.png',
      mimeType: 'image/png',
    });
    const metadata = createReplyMock();
    const content = createReplyMock();

    await client.get(
      uploaded.body.id,
      createMultipartRequest([], null) as never,
      metadata as never,
    );
    await client.content(
      uploaded.body.id,
      createMultipartRequest([], null) as never,
      content as never,
    );

    expect(uploaded.status).toBe(200);
    expect(uploaded.body).toMatchObject({
      object: 'file',
      bytes: png.length,
      filename: 'shot.png',
      purpose: 'user_data',
      status: 'processed',
    });
    expect(uploaded.body.id).toMatch(/^file-[0-9a-f]{32}$/u);
    expect(sent(metadata)).toMatchObject({ id: uploaded.body.id });
    expect(sent(content)).toEqual(png);
    expect(content.header).toHaveBeenCalledWith('Content-Type', 'image/png');
  });

  it('answers the dialect the request asked for, at the same path', async () => {
    const { client } = createSurfaces();
    const anthropic = createReplyMock();

    await client.upload(
      createMultipartRequest(
        [],
        { bytes: pdf, filename: 'contract.pdf', mimeType: 'application/pdf' },
        ANTHROPIC_HEADERS,
      ) as never,
      anthropic as never,
    );

    expect(sent(anthropic)).toMatchObject({
      type: 'file',
      filename: 'contract.pdf',
      mime_type: 'application/pdf',
      size_bytes: pdf.length,
      downloadable: true,
    });
    expect((sent(anthropic) as { id: string }).id).toMatch(/^file_[0-9a-f]{32}$/u);
  });

  it('names the beta an Anthropic client has to send instead of guessing', async () => {
    const { client } = createSurfaces();
    const reply = createReplyMock();

    await client.upload(
      createMultipartRequest(
        [],
        { bytes: pdf, filename: 'c.pdf', mimeType: 'application/pdf' },
        {
          'anthropic-version': '2023-06-01',
        },
      ) as never,
      reply as never,
    );

    expect(statusOf(reply)).toBe(400);
    expect(JSON.stringify(sent(reply))).toContain('files-api-2025-04-14');
  });

  it('stores identical bytes once and hands back the same handle', async () => {
    const { client, rootDirectory } = createSurfaces();

    const first = await uploadOpenAI(client, {
      bytes: png,
      filename: 'first.png',
      mimeType: 'image/png',
    });
    const second = await uploadOpenAI(client, {
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
    const { client } = createSurfaces();

    const uploaded = await uploadOpenAI(client, {
      bytes: png,
      filename: 'not-really.txt',
      mimeType: 'text/plain',
    });
    const anthropicView = createReplyMock();
    await client.get(
      uploaded.body.id,
      createMultipartRequest([], null, ANTHROPIC_HEADERS) as never,
      anthropicView as never,
    );

    expect(sent(anthropicView)).toMatchObject({ mime_type: 'image/png' });
  });

  it('refuses a handle it never issued without letting the string reach the disk', async () => {
    const { client, rootDirectory } = createSurfaces();
    const traversal = createReplyMock();
    const nonsense = createReplyMock();

    await client.get(
      '../../../secrets',
      createMultipartRequest([], null) as never,
      traversal as never,
    );
    await client.get(
      'file-not-a-real-handle',
      createMultipartRequest([], null) as never,
      nonsense as never,
    );

    expect(statusOf(traversal)).toBe(404);
    expect(statusOf(nonsense)).toBe(404);
    // The handle is matched against the issued pattern before anything opens
    // the store, so a client string cannot even provoke a directory listing.
    expect(readdirSync(rootDirectory)).toEqual([]);
  });

  it('reports a file over the per-file ceiling as 413, not as a generic failure', async () => {
    const { client } = createSurfaces({ maxFileBytes: 64 });
    const reply = createReplyMock();

    await client.upload(
      createMultipartRequest(OPENAI_UPLOAD_FIELDS, {
        bytes: Buffer.alloc(128, 1),
        filename: 'big.bin',
        mimeType: 'application/octet-stream',
      }) as never,
      reply as never,
    );

    expect(statusOf(reply)).toBe(413);
  });

  it('refuses a purpose this proxy could never serve', async () => {
    const { client } = createSurfaces();
    const reply = createReplyMock();

    await client.upload(
      createMultipartRequest([['purpose', 'fine-tune']], {
        bytes: png,
        filename: 'shot.png',
        mimeType: 'image/png',
      }) as never,
      reply as never,
    );

    expect(statusOf(reply)).toBe(400);
    expect(JSON.stringify(sent(reply))).toContain('fine-tune');
  });

  it('accepts Google’s simple upload and answers with a files/ resource', async () => {
    const { gemini } = createSurfaces();
    const uploaded = createReplyMock();
    const listed = createReplyMock();

    await gemini.upload(createRawRequest('image/png', png) as never, uploaded as never);
    await gemini.list(createRawRequest('image/png', png) as never, listed as never);

    const resource = sent(uploaded) as { file: { name: string; sizeBytes: string } };
    expect(resource.file.name).toMatch(/^files\/[0-9a-f]{32}$/u);
    expect(String(resource.file.sizeBytes)).toBe(String(png.length));
    expect(JSON.stringify(sent(listed))).toContain(resource.file.name);
  });

  it('preserves each client dialect list envelope and shared cursor semantics', async () => {
    const { client } = createSurfaces();
    await uploadOpenAI(client, {
      bytes: png,
      filename: 'shot.png',
      mimeType: 'image/png',
    });
    await uploadOpenAI(client, {
      bytes: pdf,
      filename: 'contract.pdf',
      mimeType: 'application/pdf',
    });

    const firstPage = createReplyMock();
    await client.list(createMultipartRequest([], null) as never, firstPage as never, '1');
    const firstBody = sent(firstPage) as {
      object: string;
      data: Array<{ id: string }>;
      has_more: boolean;
    };

    expect(firstBody).toEqual({
      object: 'list',
      data: [expect.objectContaining({ id: expect.stringMatching(/^file-[0-9a-f]{32}$/u) })],
      has_more: true,
    });

    const secondPage = createReplyMock();
    await client.list(
      createMultipartRequest([], null, ANTHROPIC_HEADERS) as never,
      secondPage as never,
      '1',
      firstBody.data[0].id,
    );
    const secondBody = sent(secondPage) as {
      data: Array<{ id: string }>;
      first_id: string | null;
      has_more: boolean;
      last_id: string | null;
    };

    expect(secondBody).toEqual({
      data: [expect.objectContaining({ id: expect.stringMatching(/^file_[0-9a-f]{32}$/u) })],
      has_more: true,
      first_id: secondBody.data[0].id,
      last_id: secondBody.data[0].id,
    });
  });

  it('uses the shared page token and delete behavior on the Gemini surface', async () => {
    const { client, gemini } = createSurfaces();
    const first = await uploadOpenAI(client, {
      bytes: png,
      filename: 'shot.png',
      mimeType: 'image/png',
    });
    await uploadOpenAI(client, {
      bytes: pdf,
      filename: 'contract.pdf',
      mimeType: 'application/pdf',
    });

    const firstPage = createReplyMock();
    await gemini.list(createRawRequest('image/png', png) as never, firstPage as never, '1');
    const firstBody = sent(firstPage) as {
      files: Array<{ name: string }>;
      nextPageToken: string;
    };
    expect(firstBody.files).toHaveLength(1);
    expect(firstBody.nextPageToken).toMatch(/^[0-9a-f]{32}$/u);

    const secondPage = createReplyMock();
    await gemini.list(
      createRawRequest('image/png', png) as never,
      secondPage as never,
      '1',
      firstBody.nextPageToken,
    );
    expect((sent(secondPage) as { files: unknown[] }).files).toHaveLength(1);

    const deleted = createReplyMock();
    await gemini.remove(first.body.id, deleted as never);
    expect(statusOf(deleted)).toBe(200);
    expect(sent(deleted)).toEqual({});

    const afterDelete = createReplyMock();
    await client.get(
      first.body.id,
      createMultipartRequest([], null) as never,
      afterDelete as never,
    );
    expect(statusOf(afterDelete)).toBe(404);
  });

  it('lets one surface read what another one uploaded', async () => {
    const { client, gemini } = createSurfaces();
    const uploaded = await uploadOpenAI(client, {
      bytes: pdf,
      filename: 'shared.pdf',
      mimeType: 'application/pdf',
    });
    const handle = uploaded.body.id.replace(/^file-/u, '');
    const viaGemini = createReplyMock();

    await gemini.get(handle, createRawRequest('image/png', png) as never, viaGemini as never);

    expect(statusOf(viaGemini)).toBe(200);
    expect(JSON.stringify(sent(viaGemini))).toContain(handle);
  });

  it('routes both controller families through the same Files service', async () => {
    const { client, files, gemini } = createSurfaces();
    const uploaded = await uploadOpenAI(client, {
      bytes: pdf,
      filename: 'shared.pdf',
      mimeType: 'application/pdf',
    });
    const stat = vi.spyOn(files, 'stat');

    const viaClient = createReplyMock();
    await client.get(
      uploaded.body.id,
      createMultipartRequest([], null) as never,
      viaClient as never,
    );
    const viaGemini = createReplyMock();
    await gemini.get(
      uploaded.body.id,
      createRawRequest('image/png', png) as never,
      viaGemini as never,
    );

    expect(stat.mock.calls).toEqual([[uploaded.body.id], [uploaded.body.id]]);
    expect(statusOf(viaClient)).toBe(200);
    expect(statusOf(viaGemini)).toBe(200);
  });

  it('reports an expired handle as expired and stops serving its content', async () => {
    const { client } = createSurfaces({ ttlMs: 1 });
    const uploaded = await uploadOpenAI(client, {
      bytes: png,
      filename: 'brief.png',
      mimeType: 'image/png',
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const reply = createReplyMock();

    await client.content(
      uploaded.body.id,
      createMultipartRequest([], null) as never,
      reply as never,
    );

    expect(statusOf(reply)).toBe(404);
  });

  it('forgets a deleted file on every surface', async () => {
    const { client, gemini } = createSurfaces();
    const uploaded = await uploadOpenAI(client, {
      bytes: png,
      filename: 'doomed.png',
      mimeType: 'image/png',
    });
    const deleted = createReplyMock();
    const afterDelete = createReplyMock();

    await client.remove(
      uploaded.body.id,
      createMultipartRequest([], null) as never,
      deleted as never,
    );
    await gemini.get(
      uploaded.body.id.replace(/^file-/u, ''),
      createRawRequest('image/png', png) as never,
      afterDelete as never,
    );

    expect(sent(deleted)).toMatchObject({ deleted: true, object: 'file' });
    expect(statusOf(afterDelete)).toBe(404);
  });

  it('serves uploads made before a restart', async () => {
    const first = createSurfaces();
    const uploaded = await uploadOpenAI(first.client, {
      bytes: pdf,
      filename: 'kept.pdf',
      mimeType: 'application/pdf',
    });

    const restarted = createSurfaces({ rootDirectory: first.rootDirectory });
    const reply = createReplyMock();
    await restarted.client.content(
      uploaded.body.id,
      createMultipartRequest([], null) as never,
      reply as never,
    );

    expect(statusOf(reply)).toBe(200);
    expect(sent(reply)).toEqual(pdf);
  });
});

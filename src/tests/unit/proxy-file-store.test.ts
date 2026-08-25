import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { FileContentStore } from '@/modules/proxy-gateway/server/modules/files/file-content-store.service';
import {
  FileStoreError,
  parseFileHandle,
  type FileStoreOptions,
} from '@/modules/proxy-gateway/server/modules/files/file-store.types';
import {
  resolveEffectiveMimeType,
  sniffMimeType,
} from '@/modules/proxy-gateway/server/modules/files/file-mime-sniff';

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 7),
]);
const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(24, 3)]);

const createdRoots: string[] = [];

function createStore(options: FileStoreOptions = {}): FileContentStore {
  const rootDirectory = options.rootDirectory ?? mkdtempSync(join(tmpdir(), 'agm-store-'));
  if (!options.rootDirectory) {
    createdRoots.push(rootDirectory);
  }
  return new FileContentStore({ sweepIntervalMs: 0, ...options, rootDirectory });
}

afterEach(async () => {
  while (createdRoots.length > 0) {
    await rm(createdRoots.pop() as string, { recursive: true, force: true });
  }
});

describe('local proxy file store', () => {
  it('round-trips put, stat, get, list and delete', async () => {
    const store = createStore();
    const record = await store.put({
      bytes: png,
      declaredMimeType: 'image/png',
      displayName: 'sample.png',
    });

    expect(record.id).toMatch(/^[0-9a-f]{32}$/u);
    expect(record.sizeBytes).toBe(png.length);
    expect(record.sha256).toBe(createHash('sha256').update(png).digest('hex'));

    await expect(store.stat(record.id)).resolves.toMatchObject({ displayName: 'sample.png' });
    const fetched = await store.get(record.id);
    expect(fetched.bytes.equals(png)).toBe(true);

    const listed = await store.list();
    expect(listed.files.map((entry) => entry.id)).toEqual([record.id]);

    await expect(store.delete(record.id)).resolves.toBe(true);
    await expect(store.stat(record.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(store.delete(record.id)).resolves.toBe(false);
  });

  it('deduplicates by content so identical bytes cost one blob', async () => {
    const store = createStore();
    const first = await store.put({ bytes: png, displayName: 'first.png' });
    const second = await store.put({ bytes: png, displayName: 'second.png' });

    expect(second.id).toBe(first.id);
    expect(second.createTimeMs).toBe(first.createTimeMs);
    expect(second.displayName).toBe('second.png');

    const listed = await store.list();
    expect(listed.files).toHaveLength(1);

    const shardRoot = join(createdRoots.at(-1) as string, 'blobs', first.sha256.slice(0, 2));
    expect(readdirSync(shardRoot)).toEqual([first.sha256]);
  });

  it('expires handles and reports the expiry rather than an empty part', async () => {
    const store = createStore({ ttlMs: 0 });
    const record = await store.put({ bytes: png, displayName: 'gone.png' });

    await expect(store.stat(record.id)).rejects.toMatchObject({
      code: 'expired',
      httpStatus: 404,
    });
    await expect(store.get(record.id)).rejects.toBeInstanceOf(FileStoreError);
    const listed = await store.list();
    expect(listed.files).toEqual([]);
  });

  it('sweeps expired entries and reclaims their blobs', async () => {
    const store = createStore({ ttlMs: 0 });
    const record = await store.put({ bytes: pdf, displayName: 'gone.pdf' });

    await expect(store.sweep()).resolves.toBe(1);
    const shardRoot = join(createdRoots.at(-1) as string, 'blobs', record.sha256.slice(0, 2));
    expect(readdirSync(shardRoot)).toEqual([]);
    await expect(store.sweep()).resolves.toBe(0);
  });

  it('rejects an oversized upload with a 413-shaped error', async () => {
    const store = createStore({ maxFileBytes: 16 });
    await expect(store.put({ bytes: png })).rejects.toMatchObject({
      code: 'file_too_large',
      httpStatus: 413,
    });
  });

  it('rejects an upload that would overflow the whole-store ceiling', async () => {
    const store = createStore({ maxStoreBytes: png.length });
    await store.put({ bytes: png });
    await expect(store.put({ bytes: pdf })).rejects.toMatchObject({
      code: 'store_full',
      httpStatus: 413,
    });
  });

  it('rejects an empty upload', async () => {
    const store = createStore();
    await expect(store.put({ bytes: Buffer.alloc(0) })).rejects.toMatchObject({
      code: 'empty_file',
    });
  });

  it('prefers the sniffed MIME type over a mislabelled declaration', async () => {
    const store = createStore();
    const record = await store.put({
      bytes: png,
      declaredMimeType: 'image/jpeg',
      displayName: 'liar.jpg',
    });

    expect(record.mimeType).toBe('image/png');
    expect(record.declaredMimeType).toBe('image/jpeg');
    expect(record.sniffedMimeType).toBe('image/png');
  });

  it('keeps a more specific text declaration that the sniffer cannot express', () => {
    expect(sniffMimeType(Buffer.from('id,name\n1,a\n'))).toBe('text/plain');
    expect(resolveEffectiveMimeType('text/csv', 'text/plain')).toBe('text/csv');
    expect(resolveEffectiveMimeType('application/pdf', 'image/png')).toBe('image/png');
    expect(resolveEffectiveMimeType(undefined, null)).toBe('application/octet-stream');
  });

  it('never lets a client-supplied string reach the filesystem', async () => {
    const store = createStore();
    for (const attempt of ['../../secret', 'files/../../secret', '..\\..\\secret', '']) {
      expect(parseFileHandle(attempt)).toBeNull();
      await expect(store.stat(attempt)).rejects.toMatchObject({ httpStatus: 400 });
    }
  });

  it('accepts every handle spelling the three surfaces hand out', async () => {
    const store = createStore();
    const record = await store.put({ bytes: png });

    for (const spelling of [
      record.id,
      `files/${record.id}`,
      `file-${record.id}`,
      `file_${record.id}`,
      `http://127.0.0.1:8045/v1beta/files/${record.id}`,
    ]) {
      expect(parseFileHandle(spelling)).toBe(record.id);
    }
  });

  it('survives a restart because the index is written atomically', async () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), 'agm-store-'));
    createdRoots.push(rootDirectory);

    const first = createStore({ rootDirectory });
    const record = await first.put({ bytes: pdf, displayName: 'kept.pdf' });
    // A rename is the only write the index ever sees, so the file on disk is
    // always a complete document.
    const raw = JSON.parse(await readFile(join(rootDirectory, 'index.json'), 'utf8'));
    expect(raw.version).toBe(1);

    const restarted = createStore({ rootDirectory });
    await expect(restarted.stat(record.id)).resolves.toMatchObject({ displayName: 'kept.pdf' });
    expect((await restarted.get(record.id)).bytes.equals(pdf)).toBe(true);
  });

  it('starts clean when the index was truncated by an abrupt kill', async () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), 'agm-store-'));
    createdRoots.push(rootDirectory);
    const first = createStore({ rootDirectory });
    await first.put({ bytes: png });

    writeFileSync(join(rootDirectory, 'index.json'), '{"version":1,"files":[{"id":"n');

    const restarted = createStore({ rootDirectory });
    await expect(restarted.list()).resolves.toMatchObject({ files: [] });
    // The blob the broken index no longer references is reclaimed, not leaked.
    const record = await restarted.put({ bytes: png });
    expect((await restarted.get(record.id)).bytes.equals(png)).toBe(true);
  });

  it('drops a handle whose content vanished underneath it', async () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), 'agm-store-'));
    createdRoots.push(rootDirectory);
    const store = createStore({ rootDirectory });
    const record = await store.put({ bytes: png });

    await rm(join(rootDirectory, 'blobs', record.sha256.slice(0, 2), record.sha256), {
      force: true,
    });

    await expect(store.get(record.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(store.stat(record.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('pages the listing with a stable token', async () => {
    const store = createStore();
    const first = await store.put({ bytes: png });
    const second = await store.put({ bytes: pdf });

    const page = await store.list({ limit: 1 });
    expect(page.files).toHaveLength(1);
    expect(page.nextPageToken).toBeDefined();

    const rest = await store.list({ limit: 10, pageToken: page.nextPageToken });
    expect([...page.files, ...rest.files].map((entry) => entry.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
  });
});

import { describe, expect, it } from 'vitest';
import {
  OpenAIUploadsStore,
  revivePersistedOpenAIUpload,
} from '@/modules/proxy-gateway/server/modules/uploads/openai-uploads.store';
const chunkA = Buffer.from('hello ');
describe('OpenAI Uploads store codecs and capacity', () => {
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

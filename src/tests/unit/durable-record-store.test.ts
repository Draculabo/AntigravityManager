import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DurableRecordStore } from '@/shared/persistence/durable-record-store';

const HOUR_MS = 60 * 60 * 1000;

describe('DurableRecordStore', () => {
  let directory = '';
  let filePath = '';

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-durable-store-'));
    filePath = path.join(directory, 'state.json');
  });

  afterEach(() => {
    // Windows keeps a handle for a moment after the last write resolves.
    fs.rmSync(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 20 });
  });

  function createStore(overrides: { maxEntries?: number; ttlMs?: number } = {}) {
    return new DurableRecordStore<{ note: string }>({
      filePath,
      maxEntries: overrides.maxEntries ?? 3,
      ttlMs: overrides.ttlMs ?? HOUR_MS,
    });
  }

  it('serves records written by a previous process', async () => {
    const writer = createStore();
    writer.set('alpha', { note: 'first' });
    await writer.flush();

    const reader = createStore();

    expect(reader.get('alpha')).toEqual({ note: 'first' });
  });

  it('writes through a temp file and leaves none behind', async () => {
    const store = createStore();
    store.set('alpha', { note: 'first' });
    store.set('beta', { note: 'second' });
    await store.flush();

    expect(fs.readdirSync(directory)).toEqual(['state.json']);
  });

  it('drops records that aged past the ttl before a restart', async () => {
    const writer = createStore({ ttlMs: HOUR_MS });
    writer.set('stale', { note: 'first' }, Date.now() - HOUR_MS - 1);
    writer.set('fresh', { note: 'second' });
    await writer.flush();

    const reader = createStore({ ttlMs: HOUR_MS });

    expect(reader.get('stale')).toBeNull();
    expect(reader.get('fresh')).toEqual({ note: 'second' });
  });

  it('evicts the least recently written record at the size ceiling', async () => {
    const base = Date.now();
    const store = createStore({ maxEntries: 2 });
    store.set('first', { note: 'a' }, base);
    store.set('second', { note: 'b' }, base + 1);
    store.set('third', { note: 'c' }, base + 2);
    await store.flush();

    const reader = createStore({ maxEntries: 2 });

    expect(reader.get('first')).toBeNull();
    expect(reader.get('second')).toEqual({ note: 'b' });
    expect(reader.get('third')).toEqual({ note: 'c' });
  });

  it('keeps a record alive while it is still being read', () => {
    const store = createStore({ ttlMs: HOUR_MS });
    const created = Date.now() - HOUR_MS + 1_000;
    store.set('alpha', { note: 'first' }, created);

    expect(store.get('alpha', created + HOUR_MS - 1)).toEqual({ note: 'first' });
    expect(store.get('alpha', created + HOUR_MS + 1)).toEqual({ note: 'first' });
  });

  it('recovers from a truncated state file instead of throwing', () => {
    fs.writeFileSync(filePath, '{"version":1,"entries":[{"key":"alpha","updated', 'utf-8');

    const store = createStore();

    expect(store.get('alpha')).toBeNull();
    expect(() => store.set('beta', { note: 'second' })).not.toThrow();
  });

  it('drops only the damaged records of an otherwise readable file', () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        entries: [
          { key: 'good', updatedAt: Date.now(), value: { note: 'kept' } },
          { key: '', updatedAt: Date.now(), value: { note: 'no key' } },
          { updatedAt: 'yesterday', value: { note: 'no timestamp' } },
          'not-a-record',
        ],
      }),
      'utf-8',
    );

    const store = createStore();

    expect(store.get('good')).toEqual({ note: 'kept' });
    expect(store.size).toBe(1);
  });

  it('never loads a record that aged out while the process was down', () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        entries: [
          { key: 'stale', updatedAt: Date.now() - HOUR_MS - 1, value: { note: 'gone' } },
          { key: 'fresh', updatedAt: Date.now(), value: { note: 'kept' } },
        ],
      }),
      'utf-8',
    );

    expect(createStore().size).toBe(1);
  });

  it('ignores a state file written by an unknown format version', () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 99,
        entries: [{ key: 'alpha', updatedAt: Date.now(), value: { note: 'first' } }],
      }),
      'utf-8',
    );

    expect(createStore().get('alpha')).toBeNull();
  });

  it('rejects values a revive function refuses', () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        entries: [
          { key: 'typed', updatedAt: Date.now(), value: { note: 'kept' } },
          { key: 'untyped', updatedAt: Date.now(), value: { unexpected: true } },
        ],
      }),
      'utf-8',
    );

    const store = new DurableRecordStore<{ note: string }>({
      filePath,
      maxEntries: 3,
      ttlMs: HOUR_MS,
      revive: (value) =>
        typeof (value as { note?: unknown })?.note === 'string'
          ? (value as { note: string })
          : null,
    });

    expect(store.get('typed')).toEqual({ note: 'kept' });
    expect(store.get('untyped')).toBeNull();
  });

  it('forgets deleted and cleared records across a restart', async () => {
    const writer = createStore();
    writer.set('alpha', { note: 'first' });
    writer.set('beta', { note: 'second' });
    writer.delete('alpha');
    await writer.flush();

    const afterDelete = createStore();
    expect(afterDelete.get('alpha')).toBeNull();
    expect(afterDelete.get('beta')).toEqual({ note: 'second' });
    await afterDelete.flush();

    const clearer = createStore();
    clearer.clear();
    await clearer.flush();

    expect(createStore().size).toBe(0);
  });

  it('reports the records it holds, least recently written first', async () => {
    const base = Date.now();
    const store = createStore();
    store.set('first', { note: 'a' }, base);
    store.set('second', { note: 'b' }, base + 1);
    store.set('stale', { note: 'c' }, base - HOUR_MS - 1);

    expect(store.entries(base + 2).map((record) => record.key)).toEqual(['first', 'second']);
    await store.flush();
  });

  it('costs one file write for a burst of updates', async () => {
    const rename = vi.spyOn(fs.promises, 'rename');
    const store = createStore({ maxEntries: 100 });
    for (let index = 0; index < 25; index += 1) {
      store.set(`key-${index}`, { note: String(index) });
    }
    await store.flush();

    const persisted = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
      entries: Array<{ key: string }>;
    };

    expect(rename).toHaveBeenCalledTimes(1);
    expect(persisted.entries).toHaveLength(25);
    rename.mockRestore();
  });

  it('keeps no file at all when no path is configured', async () => {
    const store = new DurableRecordStore<{ note: string }>({ maxEntries: 2, ttlMs: HOUR_MS });
    store.set('alpha', { note: 'first' });
    await store.flush();

    expect(store.get('alpha')).toEqual({ note: 'first' });
    expect(fs.readdirSync(directory)).toEqual([]);
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  defaultModelRouteMissJournalOptions,
  MODEL_ROUTE_MISS_JOURNAL_TTL_MS,
  ModelRouteMissJournalService,
} from '@/modules/proxy-gateway/server/shared/services/model-route-miss-journal.service';

describe('ModelRouteMissJournalService durability', () => {
  let directory = '';
  let filePath = '';

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-miss-journal-'));
    filePath = path.join(directory, 'model-route-misses.json');
  });

  afterEach(() => {
    // Windows keeps a handle for a moment after the last write resolves.
    fs.rmSync(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 20 });
  });

  function createJournal(overrides: { maxEntries?: number; ttlMs?: number } = {}) {
    return new ModelRouteMissJournalService({
      filePath,
      maxEntries: overrides.maxEntries ?? 50,
      ttlMs: overrides.ttlMs ?? MODEL_ROUTE_MISS_JOURNAL_TTL_MS,
    });
  }

  it('still reports misses recorded before the restart', async () => {
    const before = createJournal();
    before.record('models/Gemini-3.5-Flash');
    before.record('gemini-3.5-flash');
    before.record('claude-4-opus');
    await before.flush();

    const restored = createJournal()
      .getSnapshot()
      .map(({ model, count }) => ({ model, count }))
      .sort((left, right) => left.model.localeCompare(right.model));

    expect(restored).toEqual([
      { model: 'claude-4-opus', count: 1 },
      { model: 'gemini-3.5-flash', count: 2 },
    ]);
  });

  it('keeps nothing but the id, the count and the timestamp on disk', async () => {
    const journal = createJournal();
    journal.record('models/gemini-3.5-flash');
    await journal.flush();

    const stored = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
      entries: Array<{ value: Record<string, unknown> }>;
    };

    expect(Object.keys(stored.entries[0].value).sort()).toEqual(['count', 'lastSeen', 'model']);
  });

  it('clears the durable copy, not just the in-memory one', async () => {
    const before = createJournal();
    before.record('models/gemini-3.5-flash');
    before.clear();
    await before.flush();

    expect(createJournal().getSnapshot()).toEqual([]);
  });

  it('forgets misses older than the retention window', async () => {
    const before = createJournal();
    before.record('models/gemini-3.5-flash');
    await before.flush();

    const stored = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
      entries: Array<{ updatedAt: number }>;
    };
    stored.entries[0].updatedAt = Date.now() - MODEL_ROUTE_MISS_JOURNAL_TTL_MS - 1;
    fs.writeFileSync(filePath, JSON.stringify(stored), 'utf-8');

    expect(createJournal().getSnapshot()).toEqual([]);
  });

  it('survives a truncated journal file', () => {
    fs.writeFileSync(filePath, '{"version":1,"entries":[{"key":"gemini-3', 'utf-8');

    const journal = createJournal();

    expect(journal.getSnapshot()).toEqual([]);
    expect(() => journal.record('models/gemini-3.5-flash')).not.toThrow();
  });

  it('drops journal rows that lost their count or timestamp', () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        entries: [
          {
            key: 'gemini-3.5-flash',
            updatedAt: Date.now(),
            value: { model: 'gemini-3.5-flash', count: 3, lastSeen: Date.now() },
          },
          {
            key: 'broken-count',
            updatedAt: Date.now(),
            value: { model: 'broken-count', count: 'many', lastSeen: Date.now() },
          },
          {
            key: 'broken-zero-count',
            updatedAt: Date.now(),
            value: { model: 'broken-zero-count', count: 0, lastSeen: Date.now() },
          },
          {
            key: 'broken-timestamp',
            updatedAt: Date.now(),
            value: { model: 'broken-timestamp', count: 1, lastSeen: 'yesterday' },
          },
        ],
      }),
      'utf-8',
    );

    expect(createJournal().getSnapshot()).toEqual([
      expect.objectContaining({ model: 'gemini-3.5-flash', count: 3 }),
    ]);
  });

  it('writes nothing to disk when no path is configured', async () => {
    const journal = new ModelRouteMissJournalService({ maxEntries: 50, ttlMs: 1_000 });
    journal.record('models/gemini-3.5-flash');
    await journal.flush();

    expect(journal.getSnapshot()).toHaveLength(1);
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it('writes nothing outside an explicit path while the tests run', () => {
    expect(defaultModelRouteMissJournalOptions().filePath).toBeUndefined();
  });
});

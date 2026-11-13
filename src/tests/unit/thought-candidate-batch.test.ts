import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { queryThoughtCandidates } from '@/modules/proxy-gateway/thought-store/thought-candidate-query';
import { initializeThoughtStoreSchema } from '@/modules/proxy-gateway/thought-store/thought-store.database';
import { ThoughtStoreReads } from '@/modules/proxy-gateway/thought-store/thought-store-reads';
import {
  thinkingRecords,
  thinkingSessions,
  thoughtStoreSchema,
} from '@/modules/proxy-gateway/thought-store/thought-store.schema';

vi.mock('better-sqlite3', async () => {
  const { createRequire } = await import('node:module');
  return {
    default: createRequire(import.meta.url)(process.env.AGM_TEST_SQLITE_MODULE ?? 'better-sqlite3'),
  };
});

const first = 'a'.repeat(64);
const second = 'b'.repeat(64);
const third = 'c'.repeat(64);
const statements: string[] = [];
let raw: Database.Database;
let orm: ReturnType<typeof drizzle<typeof thoughtStoreSchema>>;

beforeEach(() => {
  raw = new Database(':memory:', {
    verbose(statement) {
      if (typeof statement === 'string' && /^select\b/iu.test(statement)) {
        statements.push(statement);
      }
    },
  });
  initializeThoughtStoreSchema(raw);
  orm = drizzle(raw, { schema: thoughtStoreSchema });
  orm
    .insert(thinkingSessions)
    .values([
      { sessionKey: 'current', lastAccessed: 1 },
      { sessionKey: 'neighbor', lastAccessed: 1 },
    ])
    .run();
});

afterEach(() => raw.close());

function insert(
  id: number,
  causalAnchor: string,
  overrides: Partial<typeof thinkingRecords.$inferInsert> = {},
) {
  orm
    .insert(thinkingRecords)
    .values({
      id,
      causalAnchor,
      sessionKey: 'current',
      fingerprint: `record-${id}`,
      operationId: `operation-${id}`,
      completedAt: id,
      captureState: 'complete',
      model: 'gemini-pro',
      sourceFamily: 'gemini',
      signature: 'opaque',
      signatureBytes: 6,
      partSignatures: '[]',
      toolIds: '[]',
      toolNames: '[]',
      visible: `visible-${id}`,
      createdAt: id,
      lastAccessed: id,
      ...overrides,
    })
    .run();
}

function read(anchors: string[]) {
  statements.length = 0;
  return queryThoughtCandidates(orm, new ThoughtStoreReads(orm), {
    sessionKey: 'current',
    model: 'gemini-pro',
    anchors,
  });
}

it('uses three SQLite reads while preserving anchor order, competing candidates and session/model isolation', () => {
  insert(1, first);
  insert(2, second);
  insert(3, second, { sessionKey: 'neighbor' });
  insert(4, second);
  insert(5, first, { model: 'claude-sonnet-4-6', sourceFamily: 'claude' });
  const result = read([second, first, second, third]);
  expect(
    result.map(({ id, operationId, signature, visible }) => ({
      id,
      operationId,
      signature,
      visible,
    })),
  ).toEqual(
    [2, 4, 1].map((id) => ({
      id,
      operationId: `operation-${id}`,
      signature: 'opaque',
      visible: `visible-${id}`,
    })),
  );
  expect(statements).toHaveLength(3);
});

it.each([65, 257])('rejects all %s over-budget candidates before reading bodies', (count) => {
  const anchors = [first, second, third, 'd'.repeat(64), 'e'.repeat(64)];
  for (let index = 0; index < count; index += 1) {
    insert(index + 1, count === 65 ? first : anchors[index % anchors.length]);
  }
  expect(() => read(anchors)).toThrow(/read exceeds/u);
  expect(statements).toHaveLength(1);
});

it('rejects an aggregate byte overflow without fetching candidate bodies', () => {
  insert(1, first, { thoughtBytes: 34 * 1024 * 1024 });
  insert(2, second, { thoughtBytes: 34 * 1024 * 1024 });
  expect(() => read([first, second])).toThrow(/read exceeds/u);
  expect(statements).toHaveLength(2);
});

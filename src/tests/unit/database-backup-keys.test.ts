import fs from 'fs';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as handler from '@/modules/account/persistence/antigravity-state-database';

let writes: Record<string, string> = {};
interface MockOrm {
  insert: () => {
    values: (values: { key: string; value: string }) => {
      onConflictDoUpdate: () => { run: () => { changes: number } };
    };
  };
  transaction: (fn: (tx: MockOrm) => void) => void;
}

let mockOrm: MockOrm;

vi.mock('@/shared/persistence/database/dbConnection', () => ({
  openDrizzleConnection: () => ({
    raw: { close: vi.fn() },
    orm: mockOrm,
  }),
}));

vi.mock('../../shared/platform/paths', () => ({
  getAntigravityDbPaths: () => ['mock-db'],
}));

vi.mock('../../shared/logging/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('database backup keys', () => {
  beforeEach(() => {
    writes = {};
    mockOrm = {
      insert: () => ({
        values: (values: { key: string; value: string }) => ({
          onConflictDoUpdate: () => ({
            run: () => {
              writes[values.key] = values.value;
              return { changes: 1 };
            },
          }),
        }),
      }),
      transaction: (fn: (tx: typeof mockOrm) => void) => {
        fn(mockOrm);
      },
    };
    vi.spyOn(fs, 'existsSync').mockImplementation((value) => {
      const pathValue = String(value);
      return !pathValue.endsWith('.backup');
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should restore unified oauth token key', () => {
    handler.restoreAccount({
      version: '1.0',
      account: {
        id: '1',
        name: 'Test',
        email: 'test@example.com',
        created_at: new Date().toISOString(),
        last_used: new Date().toISOString(),
      },
      data: {
        antigravityAuthStatus: '{"email":"test@example.com"}',
        'jetskiStateSync.agentManagerInitState': 'old',
        'antigravityUnifiedStateSync.oauthToken': 'unified',
      },
    });

    expect(writes['antigravityUnifiedStateSync.oauthToken']).toBe('unified');
  });
});

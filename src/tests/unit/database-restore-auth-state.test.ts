import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({ dbPath: '' }));

vi.mock('@/shared/platform/paths', () => ({
  getAntigravityDbPaths: () => [testState.dbPath],
}));

vi.mock('@/shared/logging/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { restoreAccount } from '@/shared/persistence/database/handler';

const OLD_AUTH_KEY = 'jetskiStateSync.agentManagerInitState';
const NEW_AUTH_KEY = 'antigravityUnifiedStateSync.oauthToken';

function readAuthState(): Record<string, string> {
  const db = new Database(testState.dbPath, { readonly: true });
  try {
    return Object.fromEntries(
      db.prepare('SELECT key, value FROM ItemTable').all().map((row) => {
        const item = row as { key: string; value: string };
        return [item.key, item.value];
      }),
    );
  } finally {
    db.close();
  }
}

describe('database authentication state restore', () => {
  let tempDir = '';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-auth-restore-'));
    testState.dbPath = path.join(tempDir, 'state.vscdb');

    const db = new Database(testState.dbPath);
    try {
      db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
    } finally {
      db.close();
    }
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('removes new-format credentials when restoring an old-format backup', () => {
    const db = new Database(testState.dbPath);
    try {
      db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
        NEW_AUTH_KEY,
        'account-a-new-format',
      );
    } finally {
      db.close();
    }

    restoreAccount({
      version: '1.0',
      account: {
        id: 'account-b',
        name: 'Account B',
        email: 'b@example.com',
        created_at: new Date().toISOString(),
        last_used: new Date().toISOString(),
      },
      data: {
        [OLD_AUTH_KEY]: 'account-b-old-format',
      },
    });

    expect(readAuthState()).toEqual({
      [OLD_AUTH_KEY]: 'account-b-old-format',
    });
  });

  it('removes old-format credentials when restoring a new-format backup', () => {
    const db = new Database(testState.dbPath);
    try {
      db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
        OLD_AUTH_KEY,
        'account-a-old-format',
      );
    } finally {
      db.close();
    }

    restoreAccount({
      version: '1.0',
      account: {
        id: 'account-b',
        name: 'Account B',
        email: 'b@example.com',
        created_at: new Date().toISOString(),
        last_used: new Date().toISOString(),
      },
      data: {
        [NEW_AUTH_KEY]: 'account-b-new-format',
      },
    });

    expect(readAuthState()).toEqual({
      [NEW_AUTH_KEY]: 'account-b-new-format',
    });
  });
});

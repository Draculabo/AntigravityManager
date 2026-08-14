import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
  dbPath: '',
  versionDetectionFails: false,
}));

vi.mock('@/shared/platform/paths', () => ({
  getAntigravityDbPaths: () => [testState.dbPath],
}));

vi.mock('@/modules/antigravity-runtime/utils/antigravityVersion', () => ({
  getAntigravityVersion: () => {
    if (testState.versionDetectionFails) {
      throw new Error('version unavailable');
    }
    return { shortVersion: '1.0.0' };
  },
  isCredentialStoreVersion: () => false,
  isNewVersion: () => false,
}));

vi.mock('@/shared/logging/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { CredentialStoreInjectionAdapter } from '@/modules/cloud-account/persistence/credential-store-injection-adapter';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { ProtobufUtils } from '@/shared/serialization/protobuf';

const LEGACY_AUTH_KEY = 'jetskiStateSync.agentManagerInitState';
const UNIFIED_AUTH_KEYS = [
  'antigravityUnifiedStateSync.oauthToken',
  'antigravityUnifiedStateSync.userStatus',
  'antigravityUnifiedStateSync.enterprisePreferences',
] as const;

const account: CloudAccount = {
  id: 'account-b',
  provider: 'google',
  email: 'b@example.com',
  name: 'Account B',
  token: {
    access_token: 'access-b',
    refresh_token: 'refresh-b',
    expires_in: 3600,
    expiry_timestamp: 2_000_000_000,
    token_type: 'Bearer',
    email: 'b@example.com',
  },
  created_at: 1_000_000_000,
  last_used: 1_000_000_000,
};

function writeItem(key: string, value: string): void {
  const db = new Database(testState.dbPath);
  try {
    db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)').run(key, value);
  } finally {
    db.close();
  }
}

function readItem(key: string): string | null {
  const db = new Database(testState.dbPath, { readonly: true });
  try {
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  } finally {
    db.close();
  }
}

describe('credential store SQLite auth format injection', () => {
  let tempDir = '';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-auth-injection-'));
    testState.dbPath = path.join(tempDir, 'state.vscdb');
    testState.versionDetectionFails = false;

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

  it('removes unified authentication state when injecting the legacy format', () => {
    for (const key of UNIFIED_AUTH_KEYS) {
      writeItem(key, `stale-${key}`);
    }

    CredentialStoreInjectionAdapter.injectCloudToken(account, 'ide');

    for (const key of UNIFIED_AUTH_KEYS) {
      expect(readItem(key)).toBeNull();
    }
    expect(readItem('antigravityAuthStatus')).toContain(account.email);
  });

  it('preserves unified authentication state when capability detection requires dual format', () => {
    testState.versionDetectionFails = true;

    const oauthInfo = ProtobufUtils.createOAuthInfo(
      'access-a',
      'refresh-a',
      2_000_000_000,
      false,
      undefined,
      'a@example.com',
    );
    writeItem(
      'antigravityUnifiedStateSync.oauthToken',
      ProtobufUtils.createUnifiedStateEntry('oauthTokenInfoSentinelKey', oauthInfo),
    );
    writeItem(
      LEGACY_AUTH_KEY,
      Buffer.from(
        ProtobufUtils.createOAuthTokenInfo('access-a', 'refresh-a', 2_000_000_000),
      ).toString('base64'),
    );

    CredentialStoreInjectionAdapter.injectCloudToken(account, 'ide');

    expect(readItem('antigravityUnifiedStateSync.oauthToken')).not.toBeNull();
    expect(readItem(LEGACY_AUTH_KEY)).not.toBeNull();
  });
});

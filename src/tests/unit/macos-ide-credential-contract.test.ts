// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildMacOSIdeCredentialPayload,
  writeMacOSKeychainPayload,
  syncMacOSIdeCredentialFiles,
} from '@/modules/antigravity-runtime/credentials/macosCredentialStore';
import { readClientAccountToken } from '@/modules/antigravity-runtime/credentials/antigravityCredentialStore';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));
vi.mock('@/shared/logging/logger', () => ({ logger: { warn: vi.fn() } }));
const platform = process.platform;
const credentials = {
  email: 'fixture@example.invalid',
  name: 'Fixture',
  token: {
    access_token: 'synthetic-access',
    refresh_token: 'synthetic-refresh',
    expiry_timestamp: 1900000000,
    id_token: 'synthetic-id',
  },
};
// The credential contract places account metadata beside the nested OAuth token.
const expected = {
  token: {
    access_token: 'synthetic-access',
    token_type: 'Bearer',
    refresh_token: 'synthetic-refresh',
    expiry: '2030-03-17T17:46:40.000000Z',
    expires_in: 3599,
  },
  auth_method: 'consumer',
  id_token_email: 'fixture@example.invalid',
  id_token: 'synthetic-id',
};
let directory: string;
let gemini: string;
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(gemini, name), 'utf8'));

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-mac-credentials-'));
  gemini = path.join(directory, '.gemini');
  vi.spyOn(os, 'homedir').mockReturnValue(directory);
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  vi.mocked(spawnSync)
    .mockReset()
    .mockReturnValue({
      pid: 1,
      status: 0,
      signal: null,
      output: [],
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    });
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  vi.restoreAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('Mac IDE credential contract', () => {
  it('returns complete native credentials needed by local snapshots and current-account reads', async () => {
    const value = `go-keyring-base64:${Buffer.from(JSON.stringify(expected)).toString('base64')}`;
    vi.mocked(spawnSync).mockReturnValueOnce({
      pid: 1,
      status: 0,
      signal: null,
      output: [],
      stdout: Buffer.from(value),
      stderr: Buffer.alloc(0),
    });
    expect(await readClientAccountToken('ide')).toEqual({
      accessToken: 'synthetic-access',
      refreshToken: 'synthetic-refresh',
      expiryTimestamp: 1900000000,
      idToken: 'synthetic-id',
    });
    expect(spawnSync).toHaveBeenCalledExactlyOnceWith('security', [
      'find-generic-password',
      '-s',
      'gemini',
      '-a',
      'antigravity',
      '-w',
    ]);
  });
  it('searches credential files in order when Keychain lookup fails', async () => {
    syncMacOSIdeCredentialFiles(credentials, JSON.stringify(expected));
    vi.mocked(spawnSync).mockReturnValue({
      pid: 1,
      status: 44,
      signal: null,
      output: [],
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    });
    expect(await readClientAccountToken('ide')).toEqual({
      accessToken: 'synthetic-access',
      refreshToken: 'synthetic-refresh',
      expiryTimestamp: 1900000000,
      idToken: 'synthetic-id',
    });
    fs.mkdirSync(path.join(gemini, 'antigravity-cli'));
    fs.writeFileSync(
      path.join(gemini, 'antigravity-cli/antigravity-oauth-token'),
      JSON.stringify({ token: { access_token: 'cli-access', refresh_token: 'cli-refresh' } }),
    );
    expect(await readClientAccountToken('ide')).toEqual({
      accessToken: 'cli-access',
      refreshToken: 'cli-refresh',
    });
  });
  it('matches Keychain argv and all IDE cache fields using isolated real files', () => {
    const cliFile = path.join(gemini, 'antigravity-cli/antigravity-oauth-token');
    fs.mkdirSync(path.dirname(cliFile), { recursive: true });
    fs.writeFileSync(cliFile, 'preserved-agy-session');
    const payload = buildMacOSIdeCredentialPayload(credentials);
    expect(JSON.parse(payload)).toEqual(expected);
    writeMacOSKeychainPayload(payload);
    syncMacOSIdeCredentialFiles(credentials, payload);
    expect(vi.mocked(spawnSync).mock.calls).toEqual([
      ['security', ['delete-generic-password', '-s', 'gemini', '-a', 'antigravity']],
      [
        'security',
        [
          'add-generic-password',
          '-s',
          'gemini',
          '-a',
          'antigravity',
          '-w',
          `go-keyring-base64:${Buffer.from(JSON.stringify(expected)).toString('base64')}`,
          '-A',
        ],
      ],
    ]);
    expect(read('jetski-standalone-oauth-token')).toEqual(expected);
    expect(read('oauth_creds.json')).toEqual({
      access_token: 'synthetic-access',
      refresh_token: 'synthetic-refresh',
      token_type: 'Bearer',
      expiry_date: 1900000000000,
      id_token: 'synthetic-id',
      scope:
        'https://www.googleapis.com/auth/userinfo.email openid https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.profile',
    });
    expect(read('google_accounts.json')).toEqual({ active: 'fixture@example.invalid', old: [] });
    expect(fs.readFileSync(cliFile, 'utf8')).toBe('preserved-agy-session');
  });
  it('continues Google-file synchronization when the standalone destination cannot be replaced', () => {
    fs.mkdirSync(path.join(gemini, 'jetski-standalone-oauth-token'), { recursive: true });
    syncMacOSIdeCredentialFiles(credentials, buildMacOSIdeCredentialPayload(credentials));
    expect(fs.statSync(path.join(gemini, 'jetski-standalone-oauth-token')).isDirectory()).toBe(
      true,
    );
    expect(read('oauth_creds.json').refresh_token).toBe('synthetic-refresh');
    expect(read('google_accounts.json')).toEqual({ active: 'fixture@example.invalid', old: [] });
  });
  it('omits an unavailable ID token and uses the same expiry for native and file fallback', () => {
    const token = {
      access_token: 'access',
      refresh_token: 'refresh',
      expiry_timestamp: 1800000000,
    };
    const input = { ...credentials, token };
    const payload = buildMacOSIdeCredentialPayload(input);
    expect(JSON.parse(payload)).toEqual({
      token: {
        access_token: 'access',
        token_type: 'Bearer',
        refresh_token: 'refresh',
        expiry: '2027-01-15T08:00:00.000000Z',
        expires_in: 3599,
      },
      auth_method: 'consumer',
      id_token_email: 'fixture@example.invalid',
    });
    syncMacOSIdeCredentialFiles(input, payload);
    expect(read('jetski-standalone-oauth-token')).toEqual(JSON.parse(payload));
    expect(read('oauth_creds.json')).not.toHaveProperty('id_token');
    if (platform !== 'win32') {
      for (const name of [
        'jetski-standalone-oauth-token',
        'oauth_creds.json',
        'google_accounts.json',
      ]) {
        expect(fs.statSync(path.join(gemini, name)).mode & 0o777).toBe(0o600);
      }
    }
  });
});

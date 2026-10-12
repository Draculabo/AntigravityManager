import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeAgyCliToken } from '@/modules/antigravity-runtime/credentials/agyCliTokenStore';

const PAYLOAD = JSON.stringify({
  token: {
    access_token: 'access-1',
    token_type: 'Bearer',
    refresh_token: 'refresh-1',
    expiry: '2026-08-13T20:39:51.237000Z',
  },
  auth_method: 'consumer',
});

describe('writeAgyCliToken', () => {
  let workDir: string;
  let localTarget: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-token-'));
    localTarget = path.join(workDir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
    vi.spyOn(os, 'homedir').mockReturnValue(workDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('writes and confirms only the current environment CLI session', () => {
    const otherEnvironmentTarget = path.join(workDir, 'wsl-session', 'antigravity-oauth-token');
    fs.mkdirSync(path.dirname(otherEnvironmentTarget), { recursive: true });
    fs.writeFileSync(otherEnvironmentTarget, 'other-account');

    writeAgyCliToken(PAYLOAD);

    expect(fs.readFileSync(localTarget, 'utf-8')).toBe(PAYLOAD);
    expect(fs.readFileSync(otherEnvironmentTarget, 'utf-8')).toBe('other-account');
  });

  it('atomically replaces an existing local session', () => {
    fs.mkdirSync(path.dirname(localTarget), { recursive: true });
    fs.writeFileSync(localTarget, 'previous-account');

    writeAgyCliToken(PAYLOAD);

    expect(fs.readFileSync(localTarget, 'utf-8')).toBe(PAYLOAD);
    expect(fs.readdirSync(path.dirname(localTarget))).toEqual(['antigravity-oauth-token']);
  });

  it('fails the switch and preserves the previous session when replacement fails', () => {
    fs.mkdirSync(path.dirname(localTarget), { recursive: true });
    fs.writeFileSync(localTarget, 'previous-account');
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('replace failed');
    });

    expect(() => writeAgyCliToken(PAYLOAD)).toThrow('replace failed');
    expect(fs.readFileSync(localTarget, 'utf-8')).toBe('previous-account');
    expect(fs.readdirSync(path.dirname(localTarget))).toEqual(['antigravity-oauth-token']);
  });

  it('fails the switch when the local session readback differs', () => {
    const readFileSync = fs.readFileSync.bind(fs);
    vi.spyOn(fs, 'readFileSync').mockImplementation((target, options) => {
      if (target === localTarget && options === 'utf-8') {
        return 'stale-account';
      }
      return readFileSync(target, options);
    });

    expect(() => writeAgyCliToken(PAYLOAD)).toThrow(
      'Client CLI session write could not be confirmed',
    );
  });
});

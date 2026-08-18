import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pathsMock = vi.hoisted(() => ({
  getAgyCliTokenPaths: vi.fn<() => string[]>(() => []),
}));

vi.mock('@/modules/cloud-account/persistence/agyCliTokenPaths', () => ({
  getAgyCliTokenPaths: pathsMock.getAgyCliTokenPaths,
}));

vi.mock('@/shared/logging/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

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

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-token-'));
    pathsMock.getAgyCliTokenPaths.mockReset();
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('writes the payload to every CLI install', async () => {
    const first = path.join(workDir, 'first-token');
    const second = path.join(workDir, 'second-token');
    pathsMock.getAgyCliTokenPaths.mockReturnValue([first, second]);

    const { writeAgyCliToken } =
      await import('../../modules/cloud-account/persistence/agyCliTokenStore');
    writeAgyCliToken(PAYLOAD);

    expect(fs.readFileSync(first, 'utf-8')).toBe(PAYLOAD);
    expect(fs.readFileSync(second, 'utf-8')).toBe(PAYLOAD);
  });

  it('replaces an existing session in place', async () => {
    const target = path.join(workDir, 'token');
    fs.writeFileSync(target, 'previous account');
    pathsMock.getAgyCliTokenPaths.mockReturnValue([target]);

    const { writeAgyCliToken } =
      await import('../../modules/cloud-account/persistence/agyCliTokenStore');
    writeAgyCliToken(PAYLOAD);

    expect(fs.readFileSync(target, 'utf-8')).toBe(PAYLOAD);
    // The temporary file must not survive the swap.
    expect(fs.readdirSync(workDir)).toEqual(['token']);
  });

  it('keeps going when one install cannot be written', async () => {
    const unwritable = path.join(workDir, 'missing-dir', 'token');
    const reachable = path.join(workDir, 'token');
    pathsMock.getAgyCliTokenPaths.mockReturnValue([unwritable, reachable]);

    const { writeAgyCliToken } =
      await import('../../modules/cloud-account/persistence/agyCliTokenStore');

    expect(() => writeAgyCliToken(PAYLOAD)).not.toThrow();
    expect(fs.readFileSync(reachable, 'utf-8')).toBe(PAYLOAD);
  });

  it('removes the temporary credential when the atomic swap fails', async () => {
    const target = path.join(workDir, 'token');
    fs.writeFileSync(target, 'previous account');
    pathsMock.getAgyCliTokenPaths.mockReturnValue([target]);
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('rename failed');
    });

    const { writeAgyCliToken } =
      await import('../../modules/cloud-account/persistence/agyCliTokenStore');
    writeAgyCliToken(PAYLOAD);

    expect(fs.readFileSync(target, 'utf-8')).toBe('previous account');
    expect(fs.readdirSync(workDir)).toEqual(['token']);
  });

  it('does nothing when no CLI install is present', async () => {
    pathsMock.getAgyCliTokenPaths.mockReturnValue([]);

    const { writeAgyCliToken } =
      await import('../../modules/cloud-account/persistence/agyCliTokenStore');
    writeAgyCliToken(PAYLOAD);

    expect(fs.readdirSync(workDir)).toEqual([]);
  });
});

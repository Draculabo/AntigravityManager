import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  provisionGeminiCustomizations,
  provisionExtensionsSharing,
  reconcileAllWorkspaceProfiles,
} from '@/modules/workspace/services/workspace-provisioning';
import { ActiveWorkspaceDeletionError } from '@/modules/workspace/types';

vi.mock('better-sqlite3', async () => {
  const { createRequire } = await import('node:module');
  return { default: createRequire(import.meta.url)('better-sqlite3') };
});
vi.mock('@/shared/logging/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

describe('workspace sharing recovery', () => {
  let root: string;
  let home: string;
  let host: string;
  let config: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-sharing-recovery-'));
    home = path.join(root, 'profile', 'home');
    host = path.join(root, 'host');
    config = path.join(home, '.gemini', 'config');
    fs.mkdirSync(config, { recursive: true });
    fs.mkdirSync(path.join(host, 'config'), { recursive: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('preserves nonempty config.json even when every filename looks like scaffolding', () => {
    const content = '{"theme":"custom","project":"important"}';
    fs.writeFileSync(path.join(config, 'config.json'), content);
    provisionGeminiCustomizations(home, host);
    expect(fs.lstatSync(config).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(config, 'config.json'), 'utf8')).toBe(content);
  });

  it('restores the original directory if a replacement link cannot be created', () => {
    fs.writeFileSync(path.join(config, 'config.json'), '{}');
    vi.spyOn(fs, 'symlinkSync').mockImplementation(() => {
      throw new Error('fixture permission denied');
    });
    provisionGeminiCustomizations(home, host);
    expect(fs.lstatSync(config).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(config, 'config.json'), 'utf8')).toBe('{}');
  });

  it('retains a recovery backup after replacing recognized scaffolding', () => {
    fs.writeFileSync(path.join(config, 'config.json'), '{}');
    expect(provisionGeminiCustomizations(home, host)).toBe(true);
    expect(fs.lstatSync(config).isSymbolicLink()).toBe(true);
    const backup = fs
      .readdirSync(path.dirname(config))
      .find((name) => name.startsWith('config.sharing-backup-'));
    expect(backup).toBeDefined();
    expect(fs.readFileSync(path.join(path.dirname(config), backup!, 'config.json'), 'utf8')).toBe(
      '{}',
    );
  });

  it('retains the backup and reports failure when restoration itself is unavailable', () => {
    fs.writeFileSync(path.join(config, 'config.json'), '{}');
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from).includes('.sharing-backup-')) {
        throw new Error('restore denied');
      }
      return rename(from, to);
    });
    vi.spyOn(fs, 'symlinkSync').mockImplementation(() => {
      throw new Error('link denied');
    });
    expect(provisionGeminiCustomizations(home, host)).toBe(false);
    const backup = fs
      .readdirSync(path.dirname(config))
      .find((name) => name.startsWith('config.sharing-backup-'));
    expect(backup).toBeDefined();
    expect(fs.readFileSync(path.join(path.dirname(config), backup!, 'config.json'), 'utf8')).toBe(
      '{}',
    );
  });

  it('reports a wrong extension link that cannot be replaced as incomplete', () => {
    const source = path.join(root, 'extensions');
    const previous = path.join(root, 'previous-extensions');
    const destination = path.join(root, 'profile', 'extensions');
    fs.mkdirSync(source);
    fs.mkdirSync(previous);
    fs.symlinkSync(previous, destination, process.platform === 'win32' ? 'junction' : 'dir');
    vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {
      throw new Error('link replacement denied');
    });

    expect(provisionExtensionsSharing(path.join(root, 'profile'), home, source)).toBe(false);
    expect(fs.realpathSync(destination)).toBe(fs.realpathSync(previous));
  });

  it('does not count a failed sharing operation as reconciled', async () => {
    fs.rmSync(config, { recursive: true });
    vi.spyOn(fs, 'symlinkSync').mockImplementation(() => {
      throw new Error('fixture permission denied');
    });
    const profile = {
      id: 'profile-a',
      name: 'A',
      accountId: 'account-a',
      projectPath: root,
      userDataDir: path.join(root, 'profile'),
      createdAt: 1,
    };
    const result = await reconcileAllWorkspaceProfiles({
      profileRepo: { listProfiles: async () => [profile] },
      hostGeminiDir: host,
      withStoppedProfile: async (_id, _options, action) => action(),
    });
    expect(result.reconciledCount).toBe(0);
    expect(result.profiles[0]?.reconciled).toBe(false);
  });

  it('defers running profiles without touching their customization directories', async () => {
    const content = '{"theme":"keep"}';
    fs.writeFileSync(path.join(config, 'config.json'), content);
    const profile = {
      id: 'profile-a',
      name: 'A',
      accountId: 'account-a',
      projectPath: root,
      userDataDir: path.join(root, 'profile'),
      createdAt: 1,
    };
    const result = await reconcileAllWorkspaceProfiles({
      profileRepo: { listProfiles: async () => [profile] },
      hostGeminiDir: host,
      withStoppedProfile: async () => {
        throw new ActiveWorkspaceDeletionError(profile.id);
      },
    });
    expect(result).toEqual({
      reconciledCount: 0,
      profiles: [{ id: profile.id, name: profile.name, reconciled: false, reason: 'running' }],
    });
    expect(fs.readFileSync(path.join(config, 'config.json'), 'utf8')).toBe(content);
  });
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getAgentDirMock } = vi.hoisted(() => ({
  getAgentDirMock: vi.fn<() => string>(),
}));

vi.mock('@/shared/platform/paths', () => ({
  getAgentDir: getAgentDirMock,
}));

vi.mock('@/shared/logging/logger', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import { getAppSetting, setAppSetting } from '@/shared/persistence/appSettingsStore';

const SETTINGS_FILE = 'manager_app_settings.json';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-app-settings-'));
  getAgentDirMock.mockReturnValue(tempDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tempDir, { force: true, recursive: true });
});

describe('app settings persistence', () => {
  it('does not overwrite an existing malformed settings file', () => {
    const settingsPath = path.join(tempDir, SETTINGS_FILE);
    const malformed = '{"manual_update_snooze":';
    fs.writeFileSync(settingsPath, malformed, 'utf-8');

    expect(getAppSetting('manual_update_snooze', null)).toBeNull();
    expect(() => setAppSetting('manual_update_snooze', { version: '1.2.3' })).toThrow();
    expect(fs.readFileSync(settingsPath, 'utf-8')).toBe(malformed);
  });

  it('keeps the previous settings file when atomic replacement fails', () => {
    const settingsPath = path.join(tempDir, SETTINGS_FILE);
    const original = JSON.stringify({ existing: 'value' }, null, 2);
    fs.writeFileSync(settingsPath, original, 'utf-8');

    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('rename failed');
    });

    expect(() => setAppSetting('next', 'value')).toThrow('rename failed');
    expect(fs.readFileSync(settingsPath, 'utf-8')).toBe(original);
    expect(fs.readdirSync(tempDir)).toEqual([SETTINGS_FILE]);
  });

  it('preserves existing values when a setting is updated successfully', () => {
    const settingsPath = path.join(tempDir, SETTINGS_FILE);
    fs.writeFileSync(settingsPath, JSON.stringify({ existing: 'value' }), 'utf-8');

    setAppSetting('next', 'value');

    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))).toEqual({
      existing: 'value',
      next: 'value',
    });
  });
});

import path from 'path';
import { describe, expect, it, vi } from 'vitest';

import { configureTrayIcon, resolveTrayIconPath } from '@/modules/app-shell/ipc/tray/icon';

describe('tray icon platform behavior', () => {
  it.each([
    ['darwin', 'tray.png'],
    ['win32', 'icon.png'],
    ['linux', 'icon.png'],
  ] as const)('uses %s-specific asset %s in development', (platform, assetName) => {
    expect(
      resolveTrayIconPath({
        inDevelopment: true,
        platform,
        cwd: path.join('workspace', 'app'),
        resourcesPath: path.join('packaged', 'resources'),
      }),
    ).toBe(path.join('workspace', 'app', 'src', 'assets', assetName));
  });

  it('resolves the selected asset from packaged resources', () => {
    expect(
      resolveTrayIconPath({
        inDevelopment: false,
        platform: 'win32',
        cwd: path.join('workspace', 'app'),
        resourcesPath: path.join('packaged', 'resources'),
      }),
    ).toBe(path.join('packaged', 'resources', 'assets', 'icon.png'));
  });

  it.each([
    ['darwin', true],
    ['win32', false],
    ['linux', false],
  ] as const)('sets template-image mode to %s=%s', (platform, expected) => {
    const setTemplateImage = vi.fn();

    configureTrayIcon({ setTemplateImage }, platform);

    expect(setTemplateImage).toHaveBeenCalledExactlyOnceWith(expected);
  });
});

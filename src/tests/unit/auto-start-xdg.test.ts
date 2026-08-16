import path from 'path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getLoginItemSettings: vi.fn(),
    getName: vi.fn(() => 'Antigravity Manager'),
    setLoginItemSettings: vi.fn(),
  },
}));

import { getLinuxAutoStartPath } from '@/modules/antigravity-runtime/utils/autoStart';

describe('Linux autostart config path', () => {
  it('uses XDG_CONFIG_HOME when it is an absolute path', () => {
    expect(
      getLinuxAutoStartPath(
        { XDG_CONFIG_HOME: '/custom/config' },
        '/home/example',
      ),
    ).toBe(
      path.join(
        '/custom/config',
        'autostart',
        'antigravity-manager.desktop',
      ),
    );
  });

  it('falls back to ~/.config when XDG_CONFIG_HOME is unset or empty', () => {
    const expected = path.join(
      '/home/example',
      '.config',
      'autostart',
      'antigravity-manager.desktop',
    );

    expect(getLinuxAutoStartPath({}, '/home/example')).toBe(expected);
    expect(
      getLinuxAutoStartPath({ XDG_CONFIG_HOME: '   ' }, '/home/example'),
    ).toBe(expected);
  });

  it('ignores a relative XDG_CONFIG_HOME value', () => {
    expect(
      getLinuxAutoStartPath(
        { XDG_CONFIG_HOME: 'relative/config' },
        '/home/example',
      ),
    ).toBe(
      path.join(
        '/home/example',
        '.config',
        'autostart',
        'antigravity-manager.desktop',
      ),
    );
  });
});

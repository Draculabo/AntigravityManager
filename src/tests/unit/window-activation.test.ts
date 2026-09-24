import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
  restoreExistingWindow,
  type ActivatableWindow,
} from '@/modules/app-shell/utils/windowActivation';

describe('restoreExistingWindow utility', () => {
  it('returns false and does nothing when the window is destroyed', () => {
    const window: ActivatableWindow = {
      isDestroyed: vi.fn().mockReturnValue(true),
      isMinimized: vi.fn().mockReturnValue(false),
      restore: vi.fn(),
      isVisible: vi.fn().mockReturnValue(false),
      show: vi.fn(),
      focus: vi.fn(),
    };

    const result = restoreExistingWindow(window);

    expect(result).toBe(false);
    expect(window.restore).not.toHaveBeenCalled();
    expect(window.show).not.toHaveBeenCalled();
    expect(window.focus).not.toHaveBeenCalled();
  });

  it('restores, shows, and focuses a minimized and hidden window', () => {
    const window: ActivatableWindow = {
      isDestroyed: vi.fn().mockReturnValue(false),
      isMinimized: vi.fn().mockReturnValue(true),
      restore: vi.fn(),
      isVisible: vi.fn().mockReturnValue(false),
      show: vi.fn(),
      focus: vi.fn(),
    };

    const result = restoreExistingWindow(window);

    expect(result).toBe(true);
    expect(window.restore).toHaveBeenCalledTimes(1);
    expect(window.show).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);
  });

  it('restores and focuses without redundant show when minimized but already visible', () => {
    const window: ActivatableWindow = {
      isDestroyed: vi.fn().mockReturnValue(false),
      isMinimized: vi.fn().mockReturnValue(true),
      restore: vi.fn(),
      isVisible: vi.fn().mockReturnValue(true),
      show: vi.fn(),
      focus: vi.fn(),
    };

    const result = restoreExistingWindow(window);

    expect(result).toBe(true);
    expect(window.restore).toHaveBeenCalledTimes(1);
    expect(window.show).not.toHaveBeenCalled();
    expect(window.focus).toHaveBeenCalledTimes(1);
  });

  it('shows and focuses a hidden window (e.g. after red x button clicked on macOS)', () => {
    const window: ActivatableWindow = {
      isDestroyed: vi.fn().mockReturnValue(false),
      isMinimized: vi.fn().mockReturnValue(false),
      restore: vi.fn(),
      isVisible: vi.fn().mockReturnValue(false),
      show: vi.fn(),
      focus: vi.fn(),
    };

    const result = restoreExistingWindow(window);

    expect(result).toBe(true);
    expect(window.restore).not.toHaveBeenCalled();
    expect(window.show).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);
  });

  it('only focuses an already visible window', () => {
    const window: ActivatableWindow = {
      isDestroyed: vi.fn().mockReturnValue(false),
      isMinimized: vi.fn().mockReturnValue(false),
      restore: vi.fn(),
      isVisible: vi.fn().mockReturnValue(true),
      show: vi.fn(),
      focus: vi.fn(),
    };

    const result = restoreExistingWindow(window);

    expect(result).toBe(true);
    expect(window.restore).not.toHaveBeenCalled();
    expect(window.show).not.toHaveBeenCalled();
    expect(window.focus).toHaveBeenCalledTimes(1);
  });
});

describe('macOS dock reactivation lifecycle contracts in main.ts', () => {
  const mainSource = readFileSync(path.join(process.cwd(), 'src/main.ts'), 'utf-8');

  it('does not condition app.on("activate") on getAllWindows().length === 0', () => {
    // The old bug checked getAllWindows().length === 0 which blocked hidden windows from reopening
    expect(mainSource).not.toMatch(
      /app\.on\('activate',\s*\(\)\s*=>\s*\{\s*if\s*\(\s*BrowserWindow\.getAllWindows\(\)\.length === 0\s*\)/,
    );
  });

  it('calls createWindow with startHidden false on app activate', () => {
    expect(mainSource).toContain("app.on('activate'");
    expect(mainSource).toContain('createWindow({ startHidden: false })');
  });

  it('exits full screen before hiding window on close interception', () => {
    expect(mainSource).toContain('if (mainWindow.isFullScreen())');
    expect(mainSource).toContain('mainWindow.setFullScreen(false)');
    expect(mainSource).toContain('mainWindow.hide()');
  });

  it('synchronizes tray window reference across lifecycle events', () => {
    expect(mainSource).toContain('setTrayMainWindow(existingWindow)');
    expect(mainSource).toContain('setTrayMainWindow(mainWindow)');
    expect(mainSource).toContain('setTrayMainWindow(null)');
  });
});

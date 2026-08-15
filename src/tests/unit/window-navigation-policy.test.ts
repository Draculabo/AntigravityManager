import type { BrowserWindow } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { applyMainWindowNavigationPolicy } from '@/ipc/windowNavigationPolicy';

function createWindowMock() {
  const handlers = new Map<string, (event: { preventDefault: () => void }) => void>();
  const webContents = {
    setWindowOpenHandler: vi.fn(),
    on: vi.fn((eventName: string, handler: (event: { preventDefault: () => void }) => void) => {
      handlers.set(eventName, handler);
      return webContents;
    }),
  };

  return {
    handlers,
    webContents,
    window: { webContents } as unknown as BrowserWindow,
  };
}

describe('main window navigation policy', () => {
  it('denies renderer-created windows and unexpected navigations', () => {
    const { handlers, webContents, window } = createWindowMock();

    applyMainWindowNavigationPolicy(window);

    expect(webContents.setWindowOpenHandler).toHaveBeenCalledTimes(1);
    expect(webContents.setWindowOpenHandler.mock.calls[0][0]()).toEqual({ action: 'deny' });

    for (const eventName of ['will-navigate', 'will-frame-navigate', 'will-attach-webview']) {
      const preventDefault = vi.fn();
      handlers.get(eventName)?.({ preventDefault });
      expect(preventDefault).toHaveBeenCalledTimes(1);
    }
  });

  it('attaches the policy only once per web contents', () => {
    const { webContents, window } = createWindowMock();

    applyMainWindowNavigationPolicy(window);
    applyMainWindowNavigationPolicy(window);

    expect(webContents.setWindowOpenHandler).toHaveBeenCalledTimes(1);
    expect(webContents.on).toHaveBeenCalledTimes(3);
  });
});

import type { BrowserWindow } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import { installRendererNavigationPolicy } from '@/modules/app-shell/utils/rendererNavigationPolicy';

describe('renderer navigation policy', () => {
  it('denies windows, navigations, frame navigations, and webview attachment', () => {
    const handlers = new Map<string, (...args: any[]) => void>();
    const setWindowOpenHandler = vi.fn();
    const on = vi.fn((event: string, handler: (...args: any[]) => void) => {
      handlers.set(event, handler);
    });
    const webContents = { setWindowOpenHandler, on };
    const window = { webContents } as unknown as BrowserWindow;

    installRendererNavigationPolicy(window);

    const openHandler = setWindowOpenHandler.mock.calls[0]?.[0];
    expect(openHandler()).toEqual({ action: 'deny' });

    for (const eventName of ['will-navigate', 'will-frame-navigate', 'will-attach-webview']) {
      const preventDefault = vi.fn();
      handlers.get(eventName)?.({ preventDefault });
      expect(preventDefault).toHaveBeenCalledOnce();
    }
  });

  it('installs the policy only once for the same webContents', () => {
    const setWindowOpenHandler = vi.fn();
    const on = vi.fn();
    const webContents = { setWindowOpenHandler, on };
    const window = { webContents } as unknown as BrowserWindow;

    installRendererNavigationPolicy(window);
    installRendererNavigationPolicy(window);

    expect(setWindowOpenHandler).toHaveBeenCalledOnce();
    expect(on).toHaveBeenCalledTimes(3);
  });
});

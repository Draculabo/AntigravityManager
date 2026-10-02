import type { BrowserWindow, Session } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { installRendererPermissionPolicy } from '@/modules/app-shell/utils/rendererPermissionPolicy';

describe('renderer permission policy', () => {
  it('denies unexpected permission requests and checks', () => {
    const setPermissionRequestHandler = vi.fn();
    const setPermissionCheckHandler = vi.fn();
    const rendererSession = {
      setPermissionRequestHandler,
      setPermissionCheckHandler,
    } as unknown as Session;
    const window = {
      webContents: { session: rendererSession },
    } as unknown as BrowserWindow;

    installRendererPermissionPolicy(window);

    expect(setPermissionRequestHandler).toHaveBeenCalledTimes(1);
    expect(setPermissionCheckHandler).toHaveBeenCalledTimes(1);

    const requestHandler = setPermissionRequestHandler.mock.calls[0][0];
    const callback = vi.fn();
    requestHandler(undefined, 'media', callback);
    expect(callback).toHaveBeenCalledWith(false);

    const checkHandler = setPermissionCheckHandler.mock.calls[0][0];
    expect(checkHandler()).toBe(false);
  });

  it('configures a shared Electron session only once', () => {
    const setPermissionRequestHandler = vi.fn();
    const setPermissionCheckHandler = vi.fn();
    const rendererSession = {
      setPermissionRequestHandler,
      setPermissionCheckHandler,
    } as unknown as Session;
    const firstWindow = {
      webContents: { session: rendererSession },
    } as unknown as BrowserWindow;
    const secondWindow = {
      webContents: { session: rendererSession },
    } as unknown as BrowserWindow;

    installRendererPermissionPolicy(firstWindow);
    installRendererPermissionPolicy(secondWindow);

    expect(setPermissionRequestHandler).toHaveBeenCalledTimes(1);
    expect(setPermissionCheckHandler).toHaveBeenCalledTimes(1);
  });
});

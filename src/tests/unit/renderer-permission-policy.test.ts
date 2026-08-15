import type { BrowserWindow, Session } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { configureRendererPermissionPolicy } from '@/modules/app-shell/security/rendererPermissionPolicy';

function createWindowWithSession() {
  const setPermissionRequestHandler = vi.fn();
  const setPermissionCheckHandler = vi.fn();
  const session = {
    setPermissionRequestHandler,
    setPermissionCheckHandler,
  } as unknown as Session;
  const window = {
    webContents: { session },
  } as unknown as BrowserWindow;

  return {
    window,
    setPermissionRequestHandler,
    setPermissionCheckHandler,
  };
}

describe('renderer permission policy', () => {
  it('denies permission requests and permission checks by default', () => {
    const { window, setPermissionRequestHandler, setPermissionCheckHandler } =
      createWindowWithSession();

    configureRendererPermissionPolicy(window);

    const requestHandler = setPermissionRequestHandler.mock.calls[0][0];
    const checkHandler = setPermissionCheckHandler.mock.calls[0][0];
    const callback = vi.fn();

    requestHandler(undefined, 'media', callback, {});

    expect(callback).toHaveBeenCalledWith(false);
    expect(checkHandler()).toBe(false);
  });

  it('configures each Electron session only once', () => {
    const { window, setPermissionRequestHandler, setPermissionCheckHandler } =
      createWindowWithSession();

    configureRendererPermissionPolicy(window);
    configureRendererPermissionPolicy(window);

    expect(setPermissionRequestHandler).toHaveBeenCalledTimes(1);
    expect(setPermissionCheckHandler).toHaveBeenCalledTimes(1);
  });
});

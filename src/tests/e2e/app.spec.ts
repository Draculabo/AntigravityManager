import { test, expect, ElectronApplication } from '@playwright/test';
import { _electron as electron } from 'playwright';
import path from 'path';

const injectCloudAccountsFailureScript = `
(() => {
  const START_ORPC_SERVER = 'start-orpc-server';
  const originalPostMessage = window.postMessage.bind(window);
  const isStringValue = (value) => Object.prototype.toString.call(value) === '[object String]';

  window.postMessage = function (message, targetOrigin, transfer) {
    if (message === START_ORPC_SERVER && Array.isArray(transfer) && transfer[0]) {
      const serverPort = transfer[0];
      if (serverPort.start instanceof Function) {
        serverPort.start();
      }

      serverPort.onmessage = (event) => {
        try {
          const request = isStringValue(event.data) ? JSON.parse(event.data) : event.data;
          const requestId = request && (request.i || request.id);
          const requestUrl = (request && request.p && request.p.u) || '';

          if (!requestId) {
            return;
          }

          if (requestUrl.includes('/cloud/listCloudAccounts')) {
            serverPort.postMessage(
              JSON.stringify({
                i: requestId,
                p: { s: 500, b: { json: { message: 'internal server error' } } },
              }),
            );
            return;
          }

          let result = null;
          if (requestUrl.includes('/process/isProcessRunning')) {
            result = false;
          } else if (requestUrl.includes('/cloud/getAutoSwitchEnabled')) {
            result = false;
          }

          serverPort.postMessage(
            JSON.stringify({
              i: requestId,
              p: { b: { json: result } },
            }),
          );
        } catch (_error) {
          // Ignore malformed messages in E2E bridge stub.
        }
      };

      return;
    }

    return originalPostMessage(message, targetOrigin, transfer);
  };
})();
`;

test.describe('Antigravity Manager', () => {
  let electronApp: ElectronApplication;
  const electronMainPath = path.join(__dirname, '../../../.vite/build/main.js');

  test.beforeAll(async () => {
    // Launch Electron app
    electronApp = await electron.launch({
      args: [electronMainPath],
    });
  });

  test.afterAll(async () => {
    await electronApp.close();
  });

  test('should launch and display home page', async () => {
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    const title = await window.title();
    expect(title).toBe('Antigravity Manager');

    await expect(window.getByRole('main')).toBeVisible();
    await expect(window.locator('a[href="/settings"]').first()).toBeVisible();
  });

  test('should navigate to settings', async () => {
    const window = await electronApp.firstWindow();

    // Click settings link (use data-testid or aria-label for reliability)
    await window.click('a[href="/settings"]');
    await window.waitForLoadState('domcontentloaded');

    // Check settings page has content (i18n-agnostic)
    await expect(window.locator('h2').first()).toBeVisible();
  });

  test('should show fallback UI when cloud accounts loading fails', async () => {
    await electronApp.close();

    electronApp = await electron.launch({
      args: [electronMainPath],
    });

    const page = await electronApp.firstWindow();
    await page.addInitScript(injectCloudAccountsFailureScript);
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    const mainContent = page.getByRole('main');
    await expect(mainContent.getByTestId('cloud-load-error-fallback')).toBeVisible({
      timeout: 15000,
    });
    await expect(mainContent.getByTestId('cloud-load-error-retry')).toBeVisible();
  });

  // More detailed tests would require mocking IPC or having a real environment
  // For now, we verify basic navigation and rendering
});

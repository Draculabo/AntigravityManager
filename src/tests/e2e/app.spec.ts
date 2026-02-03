import { test, expect, ElectronApplication } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { getAppBuildPath } from './utils';

test.describe('Antigravity Manager', () => {
  let electronApp: ElectronApplication;

  test.beforeAll(async () => {
    // Launch Electron app using helper to ensure build exists
    electronApp = await electron.launch({
      args: [getAppBuildPath()],
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

    // Check for main elements - h2 is present (contains i18n content)
    await expect(window.locator('h2').first()).toBeVisible();
  });

  test('should navigate to settings', async () => {
    const window = await electronApp.firstWindow();

    // Click settings link (use data-testid or aria-label for reliability)
    await window.click('a[href="/settings"]');
    await window.waitForLoadState('domcontentloaded');

    // Check settings page has content (i18n-agnostic)
    await expect(window.locator('h2').first()).toBeVisible();
  });

  // More detailed tests would require mocking IPC or having a real environment
  // For now, we verify basic navigation and rendering
});

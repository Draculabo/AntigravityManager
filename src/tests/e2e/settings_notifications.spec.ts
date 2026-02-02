import { test, expect, ElectronApplication, Page } from '@playwright/test';
import { _electron as electron } from 'playwright';
import path from 'path';

test.describe('Settings - Notifications', () => {
  let electronApp: ElectronApplication;
  let window: Page;

  test.beforeAll(async () => {
    // Note: This relies on the app being built at .vite/build/main.js
    electronApp = await electron.launch({
      args: [path.join(__dirname, '../../../.vite/build/main.js')],
    });
    window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
  });

  test.afterAll(async () => {
    await electronApp.close();
  });

  test('should display notification settings and send test notification', async () => {
    // Navigate to settings
    await window.click('a[href="/settings"]');

    // Toggle for notifications check
    const enableLabel = window.getByText('Enable Notifications');
    await expect(enableLabel).toBeVisible();

    // Sliders check
    await expect(window.getByText('Warning Threshold')).toBeVisible();
    await expect(window.getByText('Auto-Switch Threshold')).toBeVisible();

    // Test Notification button
    const testParams = { name: 'Test Notification' };
    const testBtn = window.getByRole('button', testParams).filter({ hasText: 'Test Notification' });

    // Ensure button is visible
    await expect(testBtn).toBeVisible();
    await expect(testBtn).toBeEnabled();

    // Click button
    await testBtn.click();

    // Expect toast to appear with success message
    // "Test notification sent" is the translation key 'settings.notifications.toast_sent'
    await expect(window.getByText('Test notification sent')).toBeVisible();
  });
});

import { test, expect, ElectronApplication } from '@playwright/test';
import { _electron as electron } from 'playwright';
import path from 'path';

test.describe('Antigravity Manager', () => {
  let electronApp: ElectronApplication;

  test.beforeAll(async () => {
    // Launch Electron app
    electronApp = await electron.launch({
      args: [path.join(__dirname, '../../../.vite/build/main.js')],
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

    // Check for main elements
    await expect(window.locator('h1')).toContainText('Antigravity');
    await expect(window.locator('h2')).toContainText('Accounts');
  });

  test('should navigate to settings', async () => {
    const window = await electronApp.firstWindow();

    // Click settings link
    await window.click('text=Settings');

    // Check settings page
    await expect(window.locator('h2')).toContainText('Settings');
    await expect(window.locator('text=Appearance')).toBeVisible();
    await expect(window.locator('text=About')).toBeVisible();
  });

  // More detailed tests would require mocking IPC or having a real environment
  // For now, we verify basic navigation and rendering
});

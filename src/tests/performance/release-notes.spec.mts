import { createRequire } from 'node:module';
import { _electron, expect, test } from '@playwright/test';
import { prepareReleaseNotesPreview } from '../../../scripts/preview-release-notes.mjs';

test('release notes work through isolated Electron preload and MessagePort IPC', async ({}, testInfo) => {
  test.setTimeout(180_000);
  const preview = await prepareReleaseNotesPreview();
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  try {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
    delete env.ELECTRON_RUN_AS_NODE;
    env.AGM_RELEASE_NOTES_URL = `${preview.url}release-notes.html?language=en`;
    env.AGM_RELEASE_NOTES_CONFIGURATION = JSON.stringify({
      mode: 'ready',
      state: 'available',
      tagName: 'v1.2.3',
    });
    env.AGM_RELEASE_NOTES_SHOW = '0';
    app = await _electron.launch({
      executablePath: createRequire(import.meta.url)('electron'),
      args: [preview.main, `--user-data-dir=${testInfo.outputPath('profile')}`],
      env,
      timeout: 60_000,
    });
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    const errors: string[] = [];
    const remoteImages: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (request.url().includes('example.com')) {
        remoteImages.push(request.url());
      }
    });
    await expect(page.getByRole('button', { name: 'View changes', exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await expect
      .poll(() =>
        page.evaluate(() => window.__releaseNotesPreview.status().then((state) => state.downloads)),
      )
      .toBe(1);
    await page.getByRole('button', { name: 'View changes', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Loading');
    const dialog = page.getByRole('dialog');
    await expect(
      dialog.getByRole('heading', { name: 'Local release preview', exact: true }),
    ).toBeVisible();
    await expect(dialog.locator('table')).toContainText('Exact target version');
    await expect(dialog.locator('img, script, iframe')).toHaveCount(0);
    await expect(dialog.getByText('中文更新说明。', { exact: false })).toBeVisible();
    expect(
      await dialog
        .locator('[aria-busy]')
        .evaluate((element) => element.scrollHeight > element.clientHeight),
    ).toBe(true);
    await expect(
      dialog.getByRole('button', { name: 'Release page', exact: true }),
    ).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath('release-notes-light.png') });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Toggle theme' }).click();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(600, 500),
    );
    await page.getByLabel('Update state').selectOption('downloaded');
    await page.getByRole('button', { name: 'Show update notice' }).click();
    await page.getByRole('button', { name: 'View changes', exact: true }).click();
    await expect(
      dialog.getByRole('heading', { name: 'Local release preview', exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'Close', exact: true }).first(),
    ).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath('release-notes-dark-narrow.png') });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Restart', exact: true })).toBeVisible();
    await page.getByLabel('Scenario').selectOption('empty');
    await page.getByRole('button', { name: 'Show update notice' }).click();
    await page.getByRole('button', { name: 'View changes', exact: true }).click();
    await expect(dialog).toContainText('This release does not include release notes.');
    await page.keyboard.press('Escape');
    await page.getByLabel('Scenario').selectOption('retry');
    await page.getByRole('button', { name: 'Show update notice' }).click();
    await page.getByRole('button', { name: 'View changes', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('release-notes-error.png') });
    await dialog.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(
      dialog.getByRole('heading', { name: 'Local release preview', exact: true }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByLabel('Scenario').selectOption('slow');
    await page.getByRole('button', { name: 'Show update notice' }).click();
    await page.getByRole('button', { name: 'View changes', exact: true }).click();
    await expect(page.getByRole('status')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__releaseNotesPreview.status().then((state) => state.cancellations),
        ),
      )
      .toBe(1);
    expect(
      await page.evaluate(() =>
        window.__releaseNotesPreview.status().then((state) => state.installs),
      ),
    ).toBe(0);
    expect(remoteImages).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await app?.close();
    await preview.server.close();
  }
});

test('the production resolver reads a published GitHub release before publishing this change', async ({}, testInfo) => {
  test.skip(
    !process.env.AGM_RELEASE_NOTES_LIVE_TAG,
    'Set AGM_RELEASE_NOTES_LIVE_TAG to a published tag for live validation.',
  );
  test.setTimeout(120_000);
  const preview = await prepareReleaseNotesPreview();
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  try {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
    delete env.ELECTRON_RUN_AS_NODE;
    env.AGM_RELEASE_NOTES_URL = `${preview.url}release-notes.html?language=en`;
    env.AGM_RELEASE_NOTES_CONFIGURATION = JSON.stringify({
      mode: 'live',
      state: 'downloading',
      tagName: process.env.AGM_RELEASE_NOTES_LIVE_TAG,
    });
    env.AGM_RELEASE_NOTES_SHOW = '0';
    app = await _electron.launch({
      executablePath: createRequire(import.meta.url)('electron'),
      args: [preview.main, `--user-data-dir=${testInfo.outputPath('profile')}`],
      env,
      timeout: 60_000,
    });
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    await page
      .getByRole('button', { name: 'View changes', exact: true })
      .click({ timeout: 60_000 });
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('[aria-busy]')).toHaveAttribute('aria-busy', 'false', {
      timeout: 30_000,
    });
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await expect(dialog.locator('[aria-busy]')).not.toContainText(
      'This release does not include release notes.',
    );
    expect((await dialog.locator('[aria-busy]').innerText()).length).toBeGreaterThan(20);
    await page.screenshot({ path: testInfo.outputPath('release-notes-live.png') });
  } finally {
    await app?.close();
    await preview.server.close();
  }
});

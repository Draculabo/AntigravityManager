import { createRequire } from 'node:module';
import path from 'node:path';
import { _electron, expect, test } from '@playwright/test';
import { createRendererTestServer } from './support/renderer-test-server.mjs';

test('model aliases expose publication and automatic targets in the actual desktop renderer', async ({}, testInfo) => {
  const server = await createRendererTestServer('model-aliases');
  const executablePath: string = createRequire(import.meta.url)('electron');
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  try {
    await server.listen();
    const url = server.resolvedUrls?.local[0];
    if (!url) {
      throw new Error('The isolated renderer server did not open.');
    }
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
    env.AGM_RENDERER_PROFILE_URL = `${url}renderer-updates.html?workspace&language=en`;
    delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({
      executablePath,
      args: [
        path.join(process.cwd(), 'src/tests/performance/support/renderer-updates-main.cjs'),
        `--user-data-dir=${testInfo.outputPath('profile')}`,
      ],
      env,
      timeout: 60_000,
    });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.getByRole('heading', { name: 'Accounts', exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await page.waitForLoadState('networkidle');
    await page.getByRole('link', { name: 'API Proxy', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Models', exact: true }))
      .toBeVisible({ timeout: 10_000 })
      .catch(async (error: unknown) => {
        console.log(
          JSON.stringify({ errors, body: (await page.locator('body').innerText()).slice(0, 2500) }),
        );
        await page.screenshot({ path: testInfo.outputPath('model-aliases-failure.png') });
        throw error;
      });
    await page.getByRole('tab', { name: 'Models', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Model aliases', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Add alias', exact: true }).click();
    const alias = page.getByLabel('Requested model name', { exact: true }).last();
    await alias.fill('desktop-private-opus');
    await page.getByRole('combobox', { name: 'Routing strategy', exact: true }).last().click();
    await page.getByRole('option', { name: 'Latest available Opus', exact: true }).click();
    await expect(page.getByLabel('Target model', { exact: true }).last()).toHaveValue(
      'auto:claude-opus',
    );
    const published = page
      .getByRole('checkbox', { name: 'Show in model lists', exact: true })
      .last();
    await expect(published).not.toBeChecked();
    await published.check();
    await expect(published).toBeChecked();
    await page.screenshot({
      path: testInfo.outputPath('model-aliases-light.png'),
      animations: 'disabled',
    });
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(900, 700),
    );
    await published.scrollIntoViewIfNeeded();
    expect(
      await page.locator('main').evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await expect(published).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('model-aliases-narrow-dark.png'),
      animations: 'disabled',
    });
    await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await expect(page.locator('input[value="desktop-private-opus"]')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await app?.close();
    await server.close();
  }
});

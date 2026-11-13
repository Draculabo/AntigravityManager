import { createRequire } from 'node:module';
import path from 'node:path';
import { _electron, expect, test } from '@playwright/test';
import { createRendererTestServer } from './support/renderer-test-server.mjs';

test('manual Google login accepts a pasted callback address in the desktop renderer', async ({}, testInfo) => {
  const server = await createRendererTestServer('manual-oauth-input');
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
    env.AGM_RENDERER_PROFILE_URL = `${url}renderer-updates.html?workspace&language=zh-CN`;
    delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({
      executablePath: createRequire(import.meta.url)('electron'),
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
    await expect(page.getByRole('button', { name: '添加账号', exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: '添加账号', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('summary').click();
    const input = page.getByLabel('授权码或回调地址', { exact: true });
    const callback =
      'http://127.0.0.1:1234/oauth-callback?code=4%2Fsynthetic&state=synthetic-current';
    await input.fill(callback);
    await expect(input).toHaveValue(callback);
    await expect(
      page.getByText(
        '请先在上方开始登录，再粘贴该次登录的授权码或回调地址。回调地址必须包含本次登录的 state。',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(dialog.getByRole('button', { name: '验证并添加', exact: true })).toBeDisabled();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(900, 700),
    );
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath('manual-oauth-input.png'),
      animations: 'disabled',
    });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: '添加账号', exact: true })).toBeFocused();
    expect(errors).toEqual([]);
  } finally {
    await app?.close();
    await server.close();
  }
});

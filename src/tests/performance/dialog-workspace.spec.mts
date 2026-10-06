import { createRequire } from 'node:module';
import path from 'node:path';
import { _electron, expect, test } from '@playwright/test';
import { createRendererTestServer } from './support/renderer-test-server.mjs';

test('account and request dialogs preserve keyboard flows in desktop windows', async ({}, testInfo) => {
  test.setTimeout(180_000);
  const server = await createRendererTestServer('workspace');
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  try {
    await server.listen();
    const url = server.resolvedUrls?.local[0];
    if (!url) {
      throw new Error('The workspace preview server did not open.');
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
    const add = page.getByRole('button', { name: '添加账号', exact: true });
    await expect(add).toBeVisible({ timeout: 60_000 });
    await page.waitForLoadState('networkidle');
    await add.focus();
    await page.keyboard.press('Enter');
    let dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const code = page.getByLabel('授权码', { exact: true });
    await expect(code).not.toBeVisible();
    await dialog.locator('summary').focus();
    await page.keyboard.press('Enter');
    await code.fill('synthetic-code');
    await expect(dialog.getByRole('button', { name: '验证并添加', exact: true })).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath('login.png') });
    await page.keyboard.press('Escape');
    await expect(add).toBeFocused();
    await add.click();
    await dialog.locator('summary').click();
    await expect(code).toHaveValue('');
    await page.keyboard.press('Escape');
    for (const name of ['导出', '导入']) {
      const trigger = page.getByRole('button', { name, exact: true });
      await trigger.click();
      await expect(dialog).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(trigger).toBeFocused();
    }
    await page.getByRole('checkbox', { name: 'synthetic-99@example.com', exact: true }).check();
    const bar = page.getByRole('region', { name: '已选账号操作', exact: true });
    await expect(bar).toBeInViewport();
    const remove = bar.getByRole('button', { name: '删除选中', exact: true });
    await remove.click();
    await expect(dialog).toContainText('1');
    await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath('batch-delete.png') });
    await page.keyboard.press('Escape');
    await expect(remove).toBeFocused();
    await expect(bar).toBeVisible();
    await bar.getByRole('button', { name: '取消选择', exact: true }).click();
    await expect(bar).not.toBeVisible();
    await page.getByRole('link', { name: '流量', exact: true }).click();
    const rows = page.locator('main button').filter({ hasText: '/v1/chat/completions' });
    await rows.first().focus();
    await page.keyboard.press('Enter');
    dialog = page.getByRole('dialog', { name: /流量详情/ });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('已完成', { exact: true }).first()).toBeVisible();
    await expect(dialog.locator('dt').filter({ hasText: '输入 Token' })).toBeVisible();
    await expect(dialog).not.toContainText('inputTokens');
    await expect(dialog).not.toContainText('clientIp');
    await expect(dialog.locator('.cm-content:visible')).toContainText('Synthetic response');
    await expect(dialog.locator('.cm-theme-light')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('request-light.png') });
    await page.keyboard.press('Escape');
    await page.getByRole('link', { name: '设置', exact: true }).click();
    await page.getByRole('switch', { name: '深色模式', exact: true }).click();
    await page.getByRole('link', { name: '流量', exact: true }).click();
    await rows.first().click();
    await expect(dialog.locator('.cm-theme-dark')).toBeVisible();
    await expect(dialog.locator('.cm-content:visible')).toContainText('Synthetic response');
    await expect(dialog.locator('.cm-editor')).not.toHaveCSS(
      'background-color',
      'rgb(255, 255, 255)',
    );
    await page.screenshot({ path: testInfo.outputPath('request-dark.png') });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(900, 700),
    );
    const history = dialog.getByRole('tab', { name: '重试记录（2）', exact: true });
    await history.click();
    const attempt = dialog.getByRole('button', { name: /第 1 次尝试/ });
    await attempt.focus();
    await page.keyboard.press('Space');
    await expect(attempt).toHaveAttribute('aria-pressed', 'true');
    await dialog.getByRole('tab', { name: '完整内容（2）', exact: true }).click();
    const body = dialog.getByRole('button', { name: '模型服务 响应', exact: true });
    await body.focus();
    await page.keyboard.press('Space');
    await expect(body).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.locator('.cm-content:visible')).toContainText('Synthetic response');
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    const bounds = await dialog.boundingBox();
    expect(bounds?.y).toBeGreaterThanOrEqual(0);
    expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(700);
    await page.screenshot({ path: testInfo.outputPath('request-narrow.png') });
    await page.keyboard.press('Escape');
    await expect(rows.first()).toBeFocused();
    await rows.nth(1).click();
    await expect(dialog).toContainText('这条记录已无法查看');
    await page.keyboard.press('Escape');
    await rows.nth(2).click();
    await expect(dialog.getByRole('alert')).toContainText('暂时无法读取这条请求');
    await dialog.getByRole('button', { name: '重试', exact: true }).click();
    await expect(dialog.getByText('已完成', { exact: true }).first()).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await app?.close();
    await server.close();
  }
});

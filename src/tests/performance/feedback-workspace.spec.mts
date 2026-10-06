import { createRequire } from 'node:module';
import path from 'node:path';
import { _electron, expect, test } from '@playwright/test';
import { createRendererTestServer } from './support/renderer-test-server.mjs';

test('loading, empty, failure and notifications give usable feedback in Electron', async ({}, testInfo) => {
  test.setTimeout(180_000);
  const server = await createRendererTestServer('workspace');
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  try {
    await server.listen();
    const url = server.resolvedUrls?.local[0];
    if (!url) {
      throw new Error('The feedback preview server did not open.');
    }
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
    env.AGM_RENDERER_PROFILE_URL = `${url}renderer-updates.html?workspace&language=zh-CN&feedback=loading`;
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
    const main = page.locator('main');
    await expect(main.getByRole('status', { name: '正在读取账号' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    await page.screenshot({
      path: testInfo.outputPath('accounts-loading.png'),
      animations: 'disabled',
    });
    await page.getByRole('link', { name: '流量', exact: true }).click();
    await expect(main.getByRole('status', { name: '正在加载记录…' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    await page.evaluate(() => window.__rendererFeedback.releaseReads());
    await expect(main.getByRole('status', { name: '正在加载记录…' })).not.toBeVisible();
    await expect(
      main.getByRole('button').filter({ hasText: '/v1/chat/completions' }).first(),
    ).toBeVisible();
    await page.goto(`${url}renderer-updates.html?workspace&language=zh-CN&feedback=empty`);
    await expect(main.getByRole('status', { name: '暂无云账号。' })).toBeVisible();
    await expect(main).toContainText('点击“添加账号”登录');
    await expect(page.getByRole('button', { name: '添加账号', exact: true })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('accounts-empty.png'),
      animations: 'disabled',
    });
    await page.getByRole('link', { name: '流量', exact: true }).click();
    await expect(main.getByRole('status', { name: '当前分类暂无记录。' })).toBeVisible();
    await expect(main).toContainText('通过反代发送的请求会显示在这里');
    await page.screenshot({
      path: testInfo.outputPath('traffic-empty.png'),
      animations: 'disabled',
    });
    await page.goto(`${url}renderer-updates.html?workspace&language=zh-CN&feedback=error`);
    await expect(main.getByRole('alert')).toContainText('加载云账号失败');
    await expect(main.getByRole('button', { name: '反馈这个问题', exact: true })).toBeVisible();
    await main.getByRole('button', { name: '重试', exact: true }).click();
    await expect(main.getByRole('heading', { name: '账号列表', exact: true })).toBeVisible();
    await page.getByRole('link', { name: '流量', exact: true }).click();
    await expect(main.getByRole('alert')).toContainText('暂时无法读取请求记录');
    await expect(main).not.toContainText('当前分类暂无记录');
    await page.screenshot({
      path: testInfo.outputPath('traffic-error.png'),
      animations: 'disabled',
    });
    await main.getByRole('button', { name: '重试', exact: true }).focus();
    await page.keyboard.press('Space');
    await expect(main.getByRole('alert')).not.toBeVisible();
    await expect(
      main.getByRole('button').filter({ hasText: '/v1/chat/completions' }).first(),
    ).toBeVisible();

    // Clear any read-error notification before checking the four explicit result variants.
    const dismiss = page.getByRole('button', { name: '关闭通知', exact: true });
    if (await dismiss.isVisible()) {
      await dismiss.click();
    }
    await page.getByRole('link', { name: '设置', exact: true }).click();
    await page.getByRole('switch', { name: '深色模式', exact: true }).click();
    await page.getByRole('link', { name: '账号', exact: true }).click();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(900, 700),
    );
    for (const variant of ['default', 'success', 'warning', 'destructive'] as const) {
      await page.evaluate((value) => window.__rendererFeedback.notify(value), variant);
      const notification = page.locator(`[data-variant="${variant}"]`);
      await expect(notification).toBeVisible();
      await expect(notification).toBeInViewport();
      expect(
        await notification.evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
      await expect(dismiss).toHaveCSS('opacity', '1');
      await page.screenshot({
        path: testInfo.outputPath(`notification-${variant}.png`),
        animations: 'disabled',
      });
      await dismiss.focus();
      await page.keyboard.press('Space');
      await expect(notification).not.toBeVisible();
    }
    expect(errors).toEqual([]);
  } finally {
    await app?.close();
    await server.close();
  }
});

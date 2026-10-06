import { createRequire } from 'node:module';
import path from 'node:path';
import { _electron, expect, test } from '@playwright/test';
import { createRendererTestServer } from './support/renderer-test-server.mjs';

test('proxy and settings stay usable across desktop themes and window sizes', async ({}, testInfo) => {
  test.setTimeout(180_000);
  const server = await createRendererTestServer('workspace');
  const executablePath: string = createRequire(import.meta.url)('electron');
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
    await expect(page.getByRole('heading', { name: '账号列表', exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await page.waitForLoadState('networkidle');
    await page.getByRole('link', { name: 'API 反代', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'API 反代', exact: true })).toBeVisible();
    const tools = page.getByRole('tab', { name: '工具配置', exact: true });
    await expect(tools).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: 'Claude Code', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '一键配置', exact: true })).toHaveCount(3);
    const advanced = page
      .locator('details')
      .filter({ has: page.getByText('更多服务设置', { exact: true }) });
    await expect(advanced).not.toHaveAttribute('open');
    await advanced.locator('summary').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#proxy-allow-local-video-paths')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.locator('#proxy-allow-local-video-paths')).not.toBeVisible();
    await expect(page.getByLabel('API 密钥', { exact: true })).toHaveAttribute('type', 'password');
    await expect(page.getByLabel('API 密钥', { exact: true })).toHaveValue('********');
    await page.getByRole('button', { name: '启动服务', exact: true }).click();
    await expect(
      page.getByRole('dialog', { name: '开启反向代理前，请确认风险', exact: true }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: '启动服务', exact: true })).toBeFocused();
    // Native disclosure state must survive changing panels, just like tool input drafts.
    const toolDetails = page.getByRole('tabpanel').locator('details').first();
    await toolDetails.locator('summary').click();
    await expect(toolDetails).toHaveAttribute('open', '');
    await tools.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: '模型设置', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByRole('heading', { name: 'Claude Code', exact: true })).not.toBeVisible();
    await page.keyboard.press('ArrowLeft');
    await expect(toolDetails).toHaveAttribute('open', '');
    await toolDetails.locator('summary').click();
    await page.screenshot({ path: testInfo.outputPath('proxy-light.png'), animations: 'disabled' });
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await page.screenshot({ path: testInfo.outputPath('proxy-dark.png'), animations: 'disabled' });
    await page.evaluate(() => document.documentElement.classList.remove('dark'));
    await page.getByRole('tab', { name: '请求记录', exact: true }).click();
    await expect(page.getByRole('tabpanel')).toBeVisible();
    await page.getByRole('tab', { name: '调用示例', exact: true }).click();
    const anthropic = page.getByRole('button', { name: 'Anthropic 协议', exact: true });
    await anthropic.focus();
    await page.keyboard.press('Space');
    await expect(anthropic).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'OpenAI 协议', exact: true })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await expect(page.getByRole('tabpanel')).toContainText('POST /v1/messages');
    await page.getByRole('tab', { name: '工具配置', exact: true }).click();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(900, 700),
    );
    await expect(tools).toBeVisible();
    await expect(page.getByRole('button', { name: '启动服务', exact: true })).toBeVisible();
    expect(
      await page.locator('main').evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath('proxy-narrow.png'),
      animations: 'disabled',
    });

    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1500, 1000),
    );
    await page.getByRole('link', { name: '设置', exact: true }).click();
    await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
    const clientSetup = page
      .locator('details')
      .filter({ has: page.getByText('客户端位置与启动设置', { exact: true }) });
    await expect(page.locator('#antigravity-executable')).not.toBeVisible();
    await clientSetup.locator('summary').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#antigravity-executable')).toBeVisible();
    await expect(page.getByRole('button', { name: '选择文件', exact: true })).toHaveCount(3);
    await page.keyboard.press('Enter');
    await page.screenshot({
      path: testInfo.outputPath('settings-light.png'),
      animations: 'disabled',
    });
    const darkMode = page.getByRole('switch', { name: '深色模式', exact: true });
    await darkMode.click();
    await expect(page.locator('html')).toHaveClass('dark');
    await page.screenshot({
      path: testInfo.outputPath('settings-dark.png'),
      animations: 'disabled',
    });
    await darkMode.click();
    await page.getByRole('tab', { name: '模型', exact: true }).click();
    await expect(page.getByRole('tabpanel')).toBeVisible();
    await page.getByRole('tab', { name: '反代', exact: true }).click();
    await expect(page.getByRole('tabpanel')).toBeVisible();
    await page.getByRole('tab', { name: '常规', exact: true }).click();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(900, 700),
    );
    await expect(darkMode).toBeVisible();
    expect(
      await page.locator('main').evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath('settings-narrow.png'),
      animations: 'disabled',
    });
    expect(errors).toEqual([]);
  } finally {
    await app?.close();
    await server.close();
  }
});

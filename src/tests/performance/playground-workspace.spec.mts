import { createRequire } from 'node:module';
import path from 'node:path';
import { _electron, expect, test } from '@playwright/test';
import { createRendererTestServer } from './support/renderer-test-server.mjs';

test('Playground selection, cancellation and retry work in an isolated desktop window', async ({}, testInfo) => {
  const server = await createRendererTestServer('playground');
  const executablePath: string = createRequire(import.meta.url)('electron');
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  try {
    await server.listen();
    const url = server.resolvedUrls?.local[0];
    if (!url) {
      throw new Error('The Playground preview server did not open.');
    }
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
    env.AGM_RENDERER_PROFILE_URL =
      url + 'renderer-updates.html?workspace&playground&language=zh-CN';
    delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({
      executablePath,
      args: [
        path.join(process.cwd(), 'src/tests/performance/support/renderer-updates-main.cjs'),
        '--user-data-dir=' + testInfo.outputPath('profile'),
      ],
      env,
      timeout: 60_000,
    });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.getByRole('link', { name: '演练场', exact: true }).click({ timeout: 60_000 });
    await expect(page.getByRole('heading', { name: '模型演练场 (Playground)' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: '模型', exact: true })).toContainText(
      'gemini-3-pro',
    );
    await expect(page.getByLabel('提示词', { exact: true })).toHaveValue(
      '请打个招呼，说明你的确切模型名称，再讲一个简短的笑话。',
    );
    await page.getByRole('button', { name: '打招呼', exact: true }).click();
    await expect(page.getByLabel('提示词', { exact: true })).toHaveValue(
      '请打个招呼，说明你的模型名称，并用一句简短的话概括你的用途。',
    );
    await page.getByRole('button', { name: '高级参数', exact: true }).click();
    await expect(page.getByLabel('系统提示词', { exact: true })).toHaveAttribute(
      'placeholder',
      '可选的系统指令，例如：你是一位乐于助人的助手。',
    );
    await page.screenshot({ path: testInfo.outputPath('single-zh.png'), animations: 'disabled' });
    await page.getByRole('tab', { name: '多账号对比', exact: true }).click();
    const panel = page.getByRole('tabpanel');
    await expect(panel.getByRole('checkbox', { checked: true })).toHaveCount(0);
    await expect(panel.getByText('已选择 0 个账号', { exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: '测试所选账号', exact: true })).toBeDisabled();
    const first = panel.getByRole('checkbox', { name: 'Synthetic 0', exact: true });
    const extra = panel.getByRole('checkbox', { name: 'Synthetic 10', exact: true });
    await expect(extra).toBeEnabled();
    await first.click();
    await expect(first).toBeChecked();
    await extra.focus();
    await page.keyboard.press('Space');
    await expect(extra).toBeChecked();
    await panel.getByText('Synthetic 0', { exact: true }).click();
    await expect(first).not.toBeChecked();
    await panel.getByRole('button', { name: '全选', exact: true }).click();
    await expect(panel.getByRole('checkbox', { checked: true })).toHaveCount(12);
    await expect(panel.getByText('已选择 12 个账号', { exact: true })).toBeVisible();
    await expect(first).toBeChecked();
    await expect(extra).toBeChecked();
    await expect(extra).toBeEnabled();
    await panel.getByRole('button', { name: '清空选择', exact: true }).click();
    await expect(panel.getByRole('checkbox', { checked: true })).toHaveCount(0);
    await panel.getByRole('button', { name: '全选', exact: true }).click();
    await page.evaluate(() => window.__playgroundFixture.setFailedAccount('synthetic-2'));
    await panel.getByRole('button', { name: '测试所选账号', exact: true }).click();
    await expect(panel.getByText('Synthetic account rate limit', { exact: true })).toBeVisible();
    await expect(panel.getByText(/^Synthetic answer:/)).toHaveCount(11);
    await page.evaluate(() => window.__playgroundFixture.setFailedAccount(null));
    await panel.getByRole('button', { name: '测试所选账号', exact: true }).click();
    await expect(panel.getByText('Synthetic account rate limit', { exact: true })).toHaveCount(0);
    await expect(panel.getByText(/^Synthetic answer:/)).toHaveCount(12);
    await page.getByRole('heading', { name: '模型演练场 (Playground)' }).scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath('compare-light.png'),
      animations: 'disabled',
    });
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await page.screenshot({
      path: testInfo.outputPath('compare-dark.png'),
      animations: 'disabled',
    });
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(900, 700),
    );
    await expect(page.getByRole('button', { name: '全选', exact: true })).toBeVisible();
    expect(
      await page.locator('main').evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath('compare-narrow.png'),
      animations: 'disabled',
    });

    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1500, 1000),
    );
    await page.getByRole('tab', { name: '双模型对比', exact: true }).click();
    await page.evaluate(() => window.__playgroundFixture.setDeferred(true));
    await page.getByRole('button', { name: '对比两款模型', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__playgroundFixture.pendingCount)).toBe(2);
    await page.getByRole('button', { name: '停止', exact: true }).click();
    await expect(page.getByText('已停止双模型对比。', { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__playgroundFixture.cancelledCount)).toBe(2);
    await page.getByLabel('提示词', { exact: true }).fill('Current run');
    await page.getByRole('button', { name: '对比两款模型', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__playgroundFixture.pendingCount)).toBe(2);
    await page.evaluate(() => window.__playgroundFixture.finish());
    await expect(page.getByText('Synthetic answer: Current run', { exact: true })).toHaveCount(2);
    await page.getByRole('button', { name: '对比两款模型', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__playgroundFixture.pendingCount)).toBe(2);
    await page.getByRole('tab', { name: '多账号对比', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__playgroundFixture.cancelledCount)).toBe(4);
    await page.getByRole('tab', { name: '账号模型评测', exact: true }).click();
    await expect(page.getByLabel('评测提示词', { exact: true })).toHaveValue(
      '请写两行关于编程的押韵标语，并说明人工智能的一个主要优势。',
    );
    await expect(page.getByRole('button', { name: '开始评测', exact: true })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('benchmark-zh.png'),
      animations: 'disabled',
    });
    expect(errors).toEqual([]);
  } finally {
    await app?.close();
    await server.close();
  }
});

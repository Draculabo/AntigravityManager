import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { _electron, expect, test } from '@playwright/test';
import { prepareErrorNotificationPreview } from '../../../scripts/preview-error-notifications.mjs';

test('interactive error demo uses the production preload for reports and keeps details closable', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const preview = await prepareErrorNotificationPreview();
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  try {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
    delete env.ELECTRON_RUN_AS_NODE;
    env.AGM_ERROR_PREVIEW_URL = `${preview.url}error-notifications.html`;
    env.AGM_ERROR_PREVIEW_VERSION = '0.24.0';
    env.AGM_ERROR_PREVIEW_SHOW = '0';
    app = await _electron.launch({
      executablePath: createRequire(import.meta.url)('electron'),
      args: [preview.main, `--user-data-dir=${testInfo.outputPath('profile')}`],
      env,
      timeout: 60_000,
    });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    // Keep the real preload/IPC/clipboard path; intercept only launching an external browser.
    await app.evaluate(({ shell }) => {
      shell.openExternal = async (url) => {
        process.env.AGM_ERROR_PREVIEW_OPENED_URL = url;
      };
    });
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.getByRole('heading', { name: '错误通知体验' })).toBeVisible();
    await page.getByRole('button', { name: '后端堆栈', exact: true }).click();
    const notice = page.locator('[data-variant="destructive"]');
    await notice.getByRole('button', { name: '详情', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '错误详情' });
    await expect(dialog).toContainText('at refreshAccount (services/accounts.ts:42:1)');
    await expect(dialog).not.toContainText('Renderer transport stack');
    await dialog.getByRole('button', { name: '生成脱敏日志附件', exact: true }).click();
    const logs = dialog.locator('pre[aria-label="脱敏日志预览"]');
    await expect(logs).toContainText('{"code":"ECONNRESET","status":502}');
    await expect(logs).not.toContainText('demo-private');
    const reviewed = await dialog.locator('pre[aria-label="脱敏日志预览"]').innerText();
    const destination = testInfo.outputPath('sanitized-attachment.txt');
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, destination);
    await dialog.getByRole('button', { name: '保存已预览的附件', exact: true }).click();
    await expect(dialog).toContainText('附件已保存');
    expect(await readFile(destination, 'utf8')).toBe(reviewed);
    await page.screenshot({
      path: testInfo.outputPath('sanitized-log-preview.png'),
      animations: 'disabled',
    });
    await dialog.getByRole('button', { name: '上报到 GitHub', exact: true }).click();
    await expect(dialog).toContainText('错误信息已复制');
    expect(await app.evaluate(() => process.env.AGM_ERROR_PREVIEW_OPENED_URL)).toBe(
      'https://github.com/Draculabo/AntigravityManager/issues/new?template=bug_report.md',
    );
    const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
    expect(copied).toContain('- **App Version**: 0.24.0');
    expect(copied).toContain('- **Electron Version**:');
    expect(copied).toContain('at refreshAccount (services/accounts.ts:42:1)');
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(notice.getByRole('button', { name: '详情', exact: true })).toBeFocused();
    await page.getByRole('button', { name: '脱敏示例', exact: true }).click();
    await notice.getByRole('button', { name: '详情', exact: true }).click();
    await expect(dialog).toContainText('access_token=[REDACTED]');
    await expect(dialog).not.toContainText('demo-placeholder-token');
    await expect(dialog).not.toContainText('DemoUser');
    await dialog.getByRole('button', { name: '关闭', exact: true }).last().click();
    await page.getByRole('button', { name: '无堆栈错误', exact: true }).click();
    await notice.getByRole('button', { name: '详情', exact: true }).click();
    await expect(dialog).toContainText('此操作只返回了错误提示，没有堆栈。');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '切换主题', exact: true }).click();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(900, 700),
    );
    await page.getByRole('button', { name: '触发错误', exact: true }).click();
    await expect(notice).toBeInViewport();
    await page.screenshot({
      path: testInfo.outputPath('interactive-error-demo.png'),
      animations: 'disabled',
    });
    await notice.getByRole('button', { name: '详情', exact: true }).click();
    await expect(dialog).toContainText('Synthetic operation');
    await page.screenshot({
      path: testInfo.outputPath('interactive-error-details.png'),
      animations: 'disabled',
    });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '关闭当前通知', exact: true }).click();
    await expect(notice).not.toBeVisible();
    await page.getByRole('button', { name: '成功通知', exact: true }).click();
    const success = page.locator('[data-variant="success"]');
    await expect(success).toBeVisible();
    await expect(success.getByRole('button', { name: '上报到 GitHub' })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await app?.close();
    await preview.server.close();
  }
});

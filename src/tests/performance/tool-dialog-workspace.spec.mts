import { createRequire } from 'node:module';
import path from 'node:path';
import { _electron, expect, test, type Locator } from '@playwright/test';
import { createRendererTestServer } from './support/renderer-test-server.mjs';
const zh = {
  common: { close: '关闭', cancel: '取消' },
  action: { retry: '重试' },
  'agent-tools': {
    configure: '一键配置',
    address: 'Manager 地址',
    confirm: '确认',
    'invalid-address':
      '请输入以 http:// 或 https:// 开头的 Manager 地址，不要包含登录信息或额外参数。',
    'reset-address': '使用当前 Manager 地址',
    restore: '恢复备份',
    view: '查看配置',
  },
  cloud: {
    card: { identityProfile: '身份配置' },
    identity: {
      'load-failed': '暂时无法读取设备信息',
      history: '已保存的记录',
      title: '账号设备信息',
      close: '关闭',
    },
  },
  proxy: {
    'open-code': {
      'select-all': '全选',
      'deselect-all': '取消全选',
      'choose-model-hint': '请至少选择一个模型后再继续。',
      'confirm-sync': '确认同步',
      'config-load-failed': '加载配置失败',
      'copy-config': '复制配置（隐藏隐私信息）',
    },
  },
  settings: {
    cache: {
      clear: '清理 Antigravity 缓存',
      'paths-failed': '暂时无法找到缓存位置',
      confirm: '清理缓存',
    },
  },
};

test('device, import, tool and cache dialogs remain usable in small desktop windows', async ({}, testInfo) => {
  test.setTimeout(180_000);
  const server = await createRendererTestServer('workspace');
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  try {
    await server.listen();
    const url = server.resolvedUrls?.local[0];
    if (!url) {
      throw new Error('The dialog preview server did not open.');
    }
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
    env.AGM_RENDERER_PROFILE_URL = `${url}renderer-updates.html?workspace&language=zh-CN&dialogs`;
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
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setContentSize(900, 700);
      BrowserWindow.getAllWindows()[0].show();
    });
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const inspectBounds = async (dialog: Locator) => {
      expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      const box = await dialog.boundingBox();
      expect(box?.y).toBeGreaterThanOrEqual(0);
      expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(700);
    };
    const identity = page
      .getByRole('button', { name: zh.cloud.card.identityProfile, exact: true })
      .first();
    await expect(identity).toBeVisible({ timeout: 60_000 });
    await identity.click();
    let dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('alert')).toContainText(zh.cloud.identity['load-failed']);
    await dialog.getByRole('button', { name: zh.action.retry, exact: true }).click();
    await expect(dialog.getByText(zh.cloud.identity.history, { exact: true })).toBeVisible();
    await inspectBounds(dialog);
    await dialog
      .locator('div.overflow-y-auto')
      .first()
      .evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
    await expect(
      dialog.getByRole('heading', { name: zh.cloud.identity.title, exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: zh.cloud.identity.close, exact: true }).first(),
    ).toBeInViewport();
    await page.screenshot({
      path: testInfo.outputPath('device-information.png'),
      animations: 'disabled',
    });
    await page.keyboard.press('Escape');
    await expect(identity).toBeFocused();

    await expect(page.getByRole('button', { name: '从 IDE 同步', exact: true })).toHaveCount(0);
    const scan = page.getByRole('button', { name: '从本机导入账号', exact: true });
    await expect(scan).toHaveCount(1);
    await scan.click();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByText('synthetic-19@example.com', { exact: true })).toBeAttached();
    await inspectBounds(dialog);
    await expect(
      dialog.getByRole('button', { name: '导入 20 个账号', exact: true }),
    ).toBeInViewport();
    await page.screenshot({
      path: testInfo.outputPath('local-import-preview.png'),
      animations: 'disabled',
    });
    await page.keyboard.press('Escape');
    await expect(scan).toBeFocused();

    await page.getByRole('link', { name: 'API 反代', exact: true }).click();
    const codex = page
      .locator('div.bg-card.rounded-xl')
      .filter({ has: page.getByRole('heading', { name: 'Codex', exact: true }) });
    const configure = codex.getByRole('button', { name: zh['agent-tools'].configure, exact: true });
    await configure.click();
    dialog = page.getByRole('dialog');
    await dialog.locator('summary').click();
    const address = dialog.getByLabel(zh['agent-tools'].address, { exact: true });
    await address.fill('not-an-address');
    await page.screenshot({
      path: testInfo.outputPath('tool-invalid-address.png'),
      animations: 'disabled',
    });
    await expect(address).toHaveAttribute('aria-invalid', 'true');
    await expect(dialog.getByRole('alert')).toContainText(zh['agent-tools']['invalid-address']);
    await expect(
      dialog.getByRole('button', { name: zh['agent-tools'].confirm, exact: true }),
    ).toBeDisabled();
    await dialog
      .getByRole('button', { name: zh['agent-tools']['reset-address'], exact: true })
      .click();
    await expect(address).toHaveAttribute('aria-invalid', 'false');
    await inspectBounds(dialog);
    await page.screenshot({
      path: testInfo.outputPath('tool-settings.png'),
      animations: 'disabled',
    });
    await page.keyboard.press('Escape');
    await expect(configure).toBeFocused();
    await codex.getByRole('button', { name: zh['agent-tools'].restore, exact: true }).click();
    await expect(dialog.getByRole('button', { name: zh.common.cancel, exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await codex.getByRole('button', { name: zh['agent-tools'].view, exact: true }).click();
    await expect(dialog.locator('pre')).toContainText('Synthetic configuration');
    await inspectBounds(dialog);
    await expect(
      dialog.getByRole('button', { name: zh.common.close, exact: true }).first(),
    ).toBeInViewport();
    await page.keyboard.press('Escape');

    const openCode = page
      .locator('div.bg-card.rounded-xl')
      .filter({ has: page.getByRole('heading', { name: 'OpenCode', exact: true }) });
    await openCode.getByRole('button', { name: zh['agent-tools'].configure, exact: true }).click();
    dialog = page.getByRole('dialog');
    const selectAll = dialog.getByRole('button', {
      name: zh.proxy['open-code']['select-all'],
      exact: true,
    });
    if (await selectAll.isVisible()) {
      await selectAll.click();
    }
    await dialog
      .getByRole('button', { name: zh.proxy['open-code']['deselect-all'], exact: true })
      .click();
    await expect(dialog.getByRole('status')).toContainText(
      zh.proxy['open-code']['choose-model-hint'],
    );
    await expect(
      dialog.getByRole('button', { name: zh.proxy['open-code']['confirm-sync'], exact: true }),
    ).toBeDisabled();
    await inspectBounds(dialog);
    await page.screenshot({
      path: testInfo.outputPath('opencode-models.png'),
      animations: 'disabled',
    });
    await page.keyboard.press('Escape');

    await page.getByRole('link', { name: '设置', exact: true }).click();
    await page.getByRole('switch', { name: '深色模式', exact: true }).click();
    const cache = page.getByRole('button', { name: zh.settings.cache.clear, exact: true });
    await cache.click();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('alert')).toContainText(zh.settings.cache['paths-failed']);
    await expect(
      dialog.getByRole('button', { name: zh.settings.cache.confirm, exact: true }),
    ).toBeDisabled();
    await dialog.getByRole('button', { name: zh.action.retry, exact: true }).click();
    await expect(
      dialog.getByText('C:/synthetic/Antigravity/Cache/location-19', { exact: true }),
    ).toBeAttached();
    await expect(
      dialog.getByRole('button', { name: zh.settings.cache.confirm, exact: true }),
    ).toBeEnabled();
    await inspectBounds(dialog);
    await page.screenshot({
      path: testInfo.outputPath('cache-confirmation-dark.png'),
      animations: 'disabled',
    });
    await page.keyboard.press('Escape');
    await expect(cache).toBeFocused();

    await page.getByRole('link', { name: 'API 反代', exact: true }).click();
    await openCode.getByRole('button', { name: zh['agent-tools'].view, exact: true }).click();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('alert')).toContainText(
      zh.proxy['open-code']['config-load-failed'],
    );
    await dialog.getByRole('button', { name: zh.action.retry, exact: true }).click();
    await expect(dialog.locator('pre')).toContainText('[REDACTED]');
    await inspectBounds(dialog);
    await expect(
      dialog.getByRole('button', { name: zh.proxy['open-code']['copy-config'], exact: true }),
    ).toBeInViewport();
    await page.screenshot({
      path: testInfo.outputPath('configuration-preview-dark.png'),
      animations: 'disabled',
    });
    await page.keyboard.press('Escape');
    expect(errors).toEqual([]);
  } finally {
    await app?.close();
    await server.close();
  }
});

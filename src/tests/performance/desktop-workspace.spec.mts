import { createRequire } from 'node:module';
import path from 'node:path';
import { _electron, expect, test, type Page } from '@playwright/test';
import { createRendererTestServer } from './support/renderer-test-server.mjs';

test('desktop workspace remains usable in light, dark and narrow windows', async ({}, testInfo) => {
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
    env.AGM_RENDERER_PROFILE_URL = `${url}renderer-updates.html?workspace`;
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
    await expect(page.getByRole('button', { name: 'Add Account', exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await page.waitForLoadState('networkidle');
    await assertThemeContrast(page);
    const checkbox = page.getByRole('checkbox', { name: 'synthetic-99@example.com', exact: true });
    await expect(checkbox).toBeVisible();
    await checkbox.focus();
    await page.keyboard.press('Space');
    await expect(checkbox).toBeChecked();
    await page.keyboard.press('Space');
    await expect(checkbox).not.toBeChecked();
    const proxyButton = page.getByRole('button', { name: 'Network proxy', exact: true }).first();
    await proxyButton.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Network proxy' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(proxyButton).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath('accounts-light.png') });
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await assertThemeContrast(page);
    await page.screenshot({ path: testInfo.outputPath('accounts-dark.png') });
    await page.getByRole('link', { name: 'Traffic', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Traffic Monitor' })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('traffic-dark.png') });
    await page.evaluate(() => document.documentElement.classList.remove('dark'));
    await page.screenshot({ path: testInfo.outputPath('traffic-light.png') });
    await expect(page.getByRole('link', { name: 'Traffic', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(900, 700),
    );
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Expand sidebar', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Accounts', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Add Account', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Import', exact: true })).toBeVisible();
    expect(
      await page.locator('main').evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem('sidebar-collapsed'))).toBe('true');
    await page.screenshot({ path: testInfo.outputPath('accounts-narrow.png') });
    await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Collapse sidebar', exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Collapse sidebar', exact: true })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('sidebar-collapsed'))).toBe('false');
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1500, 1000),
    );
    await page.goto(`${url}renderer-updates.html?workspace&language=zh-CN`);
    await expect(page.getByRole('heading', { name: '账号列表', exact: true })).toBeVisible();
    await expect(
      page.getByRole('button', { name: '查看客户端运行状态', exact: true }),
    ).toContainText('客户端均未运行');
    await expect(page.locator('main')).not.toContainText('ago');
    await page.screenshot({ path: testInfo.outputPath('accounts-chinese.png') });
    expect(errors).toEqual([]);
  } finally {
    await app?.close();
    await server.close();
  }
});

async function assertThemeContrast(page: Page) {
  const pairs = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('The renderer cannot measure theme colors.');
    }
    const luminance = (color: string) => {
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b] = Array.from(context.getImageData(0, 0, 1, 1).data).map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const probe = document.createElement('span');
    document.body.append(probe);
    try {
      const combinations: [string, string, number][] = [
        ...['info', 'success', 'warning'].flatMap((family): [string, string, number][] => [
          [`${family}-soft`, family, 4.5],
          [`${family}-soft`, 'muted-foreground', 4.5],
        ]),
        ['background', 'foreground', 4.5],
        ['card', 'foreground', 4.5],
        ['card', 'muted-foreground', 4.5],
        ['muted', 'muted-foreground', 4.5],
        ['primary', 'primary-foreground', 4.5],
        ['secondary', 'secondary-foreground', 4.5],
        ['accent', 'accent-foreground', 4.5],
        ['destructive', 'destructive-foreground', 4.5],
        ['sidebar', 'sidebar-foreground', 4.5],
        ['sidebar-accent', 'sidebar-accent-foreground', 4.5],
        ['card', 'input', 3],
        ['card', 'ring', 3],
      ];
      return combinations.map(([family, text, minimum]) => {
        probe.style.backgroundColor = `var(--${family})`;
        probe.style.color = `var(--${text})`;
        const styles = getComputedStyle(probe);
        const foreground = luminance(styles.color);
        const background = luminance(styles.backgroundColor);
        return {
          family,
          text,
          minimum,
          contrast:
            (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05),
        };
      });
    } finally {
      probe.remove();
    }
  });
  for (const pair of pairs) {
    expect(pair.contrast, `${pair.text} on ${pair.family} surface`).toBeGreaterThanOrEqual(
      pair.minimum,
    );
  }
}

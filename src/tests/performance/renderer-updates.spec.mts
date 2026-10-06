import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { _electron, expect, test, type Page } from '@playwright/test';
import type { Plugin } from 'vite';
import { createRendererTestServer } from './support/renderer-test-server.mjs';
import ts from 'typescript';
import type { RendererUpdateProfile } from './support/renderer-updates';

const root = process.cwd();
const support = path.join(root, 'src/tests/performance/support');
const watchedComponents = new Set([
  'CloudAccountList',
  'CloudAccountListContent',
  'CloudAccountGrid',
  'CloudAccountCard',
  'TrafficMonitorPage',
  'TrafficTable',
  'TrafficMonitorHeader',
  'TrafficSearchForm',
  'TrafficRefreshControls',
]);

function countComponentRenders(): Plugin {
  return {
    name: 'profile-component-invocations',
    enforce: 'post',
    transform(code, id) {
      if (!id.includes('/src/modules/') || !id.endsWith('.tsx')) {
        return;
      }
      const tree = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const insertions: { offset: number; code: string }[] = [];
      function visit(node: ts.Node) {
        if (
          ts.isFunctionDeclaration(node) &&
          node.name &&
          node.body &&
          watchedComponents.has(node.name.text)
        ) {
          const name = JSON.stringify(node.name.text);
          insertions.push({
            offset: node.body.getStart(tree) + 1,
            code: `\nif (window.__rendererUpdateProfile) { const counts = window.__rendererUpdateProfile.counts; counts[${name}] = (counts[${name}] ?? 0) + 1; }\n`,
          });
        }
        ts.forEachChild(node, visit);
      }
      visit(tree);
      if (!insertions.length) {
        return;
      }
      let result = code;
      for (const insertion of insertions.sort((a, b) => b.offset - a.offset)) {
        result =
          result.slice(0, insertion.offset) + insertion.code + result.slice(insertion.offset);
      }
      return { code: result, map: null };
    },
  };
}

function baselineSources(ref: string): Plugin {
  const files = new Set([
    'src/modules/cloud-account/components/CloudAccountList.tsx',
    'src/modules/cloud-account/components/CloudAccountGrid.tsx',
    'src/modules/cloud-account/components/CloudAccountToolbar.tsx',
    'src/modules/cloud-account/components/CloudAccountBatchActionBar.tsx',
    'src/modules/cloud-account/components/CloudAccountCard.tsx',
    'src/modules/proxy-gateway/traffic-monitor/TrafficMonitorPage.tsx',
  ]);
  return {
    name: 'profile-baseline-sources',
    enforce: 'pre',
    load(id) {
      const relative = path.relative(root, id).split(path.sep).join('/');
      if (files.has(relative)) {
        return execFileSync('git', ['show', `${ref}:${relative}`], {
          cwd: root,
          encoding: 'utf8',
          maxBuffer: 1024 * 1024,
        });
      }
    },
  };
}

async function settle(page: Page) {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
}

async function scenario(page: Page, action: () => Promise<void>) {
  await settle(page);
  await page.evaluate(() => window.__rendererUpdateProfile.reset());
  const startedAt = Date.now();
  await action();
  await settle(page);
  const snapshot: Pick<RendererUpdateProfile, 'counts' | 'commits'> = await page.evaluate(() => {
    const { counts, commits } = window.__rendererUpdateProfile;
    return { counts: { ...counts }, commits: [...commits] };
  });
  return { ...snapshot, elapsedMs: Date.now() - startedAt };
}

test('profiles account and traffic update isolation in Electron with React Compiler', async ({}, testInfo) => {
  test.setTimeout(300_000);
  const require = createRequire(import.meta.url);
  const executablePath: string = require('electron');
  const baseline = process.env.AGM_RENDERER_PROFILE_BASELINE;
  const variants = baseline ? (['baseline', 'worktree'] as const) : (['worktree'] as const);
  const reports: {
    variant: string;
    scenarios: Record<string, Awaited<ReturnType<typeof scenario>>>;
  }[] = [];
  for (const variant of variants) {
    const server = await createRendererTestServer(variant, [
      ...(variant === 'baseline' && baseline ? [baselineSources(baseline)] : []),
      countComponentRenders(),
    ]);
    let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
    try {
      await server.listen();
      console.log(`Renderer profiling: ${variant} server ready`);
      const url = server.resolvedUrls?.local[0];
      if (!url) {
        throw new Error('The renderer profiling server did not open.');
      }
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      );
      env.AGM_RENDERER_PROFILE_URL = `${url}renderer-updates.html`;
      delete env.ELECTRON_RUN_AS_NODE;
      app = await _electron.launch({
        executablePath,
        args: [
          path.join(support, 'renderer-updates-main.cjs'),
          `--user-data-dir=${testInfo.outputPath(variant)}`,
        ],
        env,
        timeout: 60_000,
      });
      const page = await app.firstWindow();
      console.log(`Renderer profiling: ${variant} window ready`);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await expect(page.getByRole('checkbox')).toHaveCount(100, { timeout: 60_000 });
      await page.waitForLoadState('networkidle');
      console.log(`Renderer profiling: ${variant} accounts ready`);
      const scenarios: Record<string, Awaited<ReturnType<typeof scenario>>> = {};
      scenarios.selection = await scenario(page, async () => {
        const checkbox = page.getByRole('checkbox').nth(42);
        await checkbox.locator('xpath=ancestor::div[contains(@class, "group")][1]').hover();
        await checkbox.click();
      });
      await page.getByRole('button', { name: 'Add Account', exact: true }).click();
      await page.locator('summary').filter({ hasText: 'Enter a code manually' }).click();
      scenarios.loginInput = await scenario(page, async () => {
        const input = page.getByLabel('Authorization Code', { exact: true });
        await input.fill('synthetic-code');
        await input.fill('synthetic-code-2');
        await input.fill('synthetic-code-3');
      });
      await page.keyboard.press('Escape');
      scenarios.availability = await scenario(page, async () => {
        await page.evaluate(() =>
          window.__rendererUpdateProfile.updateAvailability('synthetic-42', Date.now()),
        );
        await page.waitForTimeout(30);
      });
      await page.evaluate(() => window.__rendererUpdateProfile.showTraffic());
      await expect(
        page.getByRole('heading', { name: 'Traffic Monitor', exact: true }),
      ).toBeVisible();
      await expect(page.locator('button[style*="translateY"]')).not.toHaveCount(0);
      scenarios.statistics = await scenario(page, async () => {
        for (let rows = 101; rows <= 110; rows++) {
          await page.evaluate(
            (value) => window.__rendererUpdateProfile.updateStatistics(value),
            rows,
          );
          await page.waitForTimeout(20);
        }
      });
      scenarios.trafficEvents = await scenario(page, async () => {
        for (let index = 0; index < 10; index++) {
          await page.evaluate(() => window.__rendererUpdateProfile.emitTraffic());
          await settle(page);
        }
      });
      scenarios.trafficSearch = await scenario(page, async () => {
        const search = page.locator('main form input');
        await search.fill('synthetic');
        await search.fill('synthetic request');
        await search.fill('synthetic request 2');
      });
      expect(errors).toEqual([]);
      reports.push({ variant, scenarios });
    } finally {
      await app?.close();
      await server.close();
    }
  }
  await mkdir(testInfo.outputDir, { recursive: true });
  const reportPath = testInfo.outputPath('renderer-updates.json');
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        environment: 'isolated-electron-renderer',
        data: 'synthetic',
        compiler: true,
        baseline: baseline ?? null,
        reports,
      },
      null,
      2,
    ),
  );
  await testInfo.attach('renderer-updates', { path: reportPath, contentType: 'application/json' });
  // Keep timing as diagnostic evidence; render isolation is the deterministic regression gate.
  const current = reports.find((report) => report.variant === 'worktree');
  expect(current).toBeDefined();
  expect(current?.scenarios.selection.counts.CloudAccountCard).toBe(1);
  expect(current?.scenarios.availability.counts.CloudAccountCard).toBe(1);
  expect(current?.scenarios.loginInput.counts.CloudAccountListContent ?? 0).toBe(0);
  expect(current?.scenarios.statistics.counts.TrafficMonitorPage ?? 0).toBe(0);
  expect(current?.scenarios.trafficEvents.counts.TrafficMonitorPage ?? 0).toBe(0);
  expect(current?.scenarios.trafficSearch.counts.TrafficMonitorPage ?? 0).toBe(0);
});

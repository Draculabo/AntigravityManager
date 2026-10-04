import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { z } from 'zod';

const listSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      recordKind: z.string(),
      protocol: z.string(),
      model: z.string().nullable(),
    }),
  ),
  total: z.number().int().nonnegative(),
});
const detailSchema = z.object({
  request: z.object({
    status: z.number().nullable(),
    outcome: z.string(),
    inputTokens: z.number().nullable(),
    outputTokens: z.number().nullable(),
    protocol: z.string(),
  }),
  attempts: z.array(z.object({ status: z.number().nullable(), attemptIndex: z.number() })),
});

export async function openTrafficMonitor(page) {
  await page.getByRole('link', { name: 'Traffic', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Traffic Monitor', exact: true })).toBeVisible({
    timeout: 30000,
  });
}

// Compare the real rendered view with the same persisted requests used by task acceptance.
// Account identifiers, bodies and credentials remain in memory and are not included in this report.
export async function verifyTrafficMonitor({ page, gateway, profileHome, reportPath }) {
  let step = 'audit-list';
  try {
    const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
    const config = JSON.parse(
      await fs.readFile(path.join(profileHome, '.antigravity-agent', 'gui_config.json'), 'utf8'),
    );
    const getJson = async (route, schema) => {
      const response = await fetch(`${gateway}${route}`, {
        headers: { authorization: `Bearer ${config.proxy.api_key}` },
        signal: AbortSignal.timeout(15000),
      });
      assert.equal(response.status, 200, 'Audit diagnostics must be available');
      return schema.parse(await response.json());
    };
    const query = new URLSearchParams({
      trafficClass: 'model',
      from: String(report.startedAt - 2000),
      to: String(report.endedAt + 2000),
      limit: '200',
      offset: '0',
    });
    const list = await getJson(`/internal/audit/requests?${query}`, listSchema);
    step = 'audit-window-size';
    assert(
      list.total <= 200,
      'Traffic UI acceptance requires an unambiguous bounded request window',
    );
    const protocols = { claude: 'anthropic', codex: 'openai-responses', opencode: 'openai' };
    const requests = list.items.filter(
      (item) => item.recordKind === 'request' && item.protocol === protocols[report.client],
    );
    step = 'audit-request-count';
    if (requests.length !== report.audit.count) {
      console.log(
        JSON.stringify({
          monitorAuditWindow: {
            matchingRequests: requests.length,
            taskSnapshotRequests: report.audit.count,
            totalModelRequests: list.total,
            recordKinds: list.items.reduce(
              (counts, item) => ({
                ...counts,
                [item.recordKind]: (counts[item.recordKind] ?? 0) + 1,
              }),
              {},
            ),
          },
        }),
      );
    }
    assert.equal(
      requests.length,
      report.audit.count,
      'UI comparison must cover every task request',
    );
    assert(requests.length > 0, 'A task without requests cannot pass monitor acceptance');

    const search = page.getByPlaceholder('Search metadata: request ID, model, URL, protocol');
    const results = [];
    for (const item of requests) {
      const detail = await getJson(
        `/internal/audit/requests/${encodeURIComponent(item.id)}`,
        detailSchema,
      );
      step = 'search';
      await search.fill(item.id);
      await search.press('Enter');
      await expect(page.locator('footer')).toContainText('1 total');
      const row = page.locator('button[style*="translateY"]');
      await expect(row).toHaveCount(1);
      step = 'row-metadata';
      await expect(row).toContainText(detail.request.protocol);
      await expect(row).toContainText(detail.request.outcome);
      await expect(row).toContainText(String(detail.request.status ?? '—'));
      await expect(row).toContainText(
        `${detail.request.inputTokens ?? '—'} / ${detail.request.outputTokens ?? '—'}`,
      );
      step = 'refresh';
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await expect(row).toHaveCount(1);
      step = 'detail';
      await row.click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(item.id);
      for (const [label, value] of Object.entries({
        status: detail.request.status,
        inputTokens: detail.request.inputTokens,
        outputTokens: detail.request.outputTokens,
      })) {
        step = `detail-${label}`;
        const definition = dialog
          .locator('dl > div')
          .filter({ has: page.locator('dt', { hasText: new RegExp(`^${label}$`) }) });
        await expect(definition.locator('dd').filter({ visible: true })).toHaveText(
          String(value ?? '—'),
        );
      }
      step = 'attempts';
      const retryTab = dialog.getByRole('tab', { name: /^Retry history/ });
      if (await retryTab.isVisible()) {
        await expect(retryTab).toHaveText(`Retry history (${detail.attempts.length})`);
        await retryTab.click();
      }
      const attempts = dialog
        .getByRole('button', { name: /^Attempt \d+/ })
        .filter({ visible: true });
      await expect(attempts).toHaveCount(detail.attempts.length);
      for (let i = 0; i < detail.attempts.length; i += 1) {
        await expect(attempts.nth(i)).toContainText(String(detail.attempts[i].status ?? '—'));
      }
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      step = 'status-filter';
      const status = page.getByRole('combobox', { name: 'Status', exact: true });
      if (detail.request.status !== null) {
        const group = `${Math.floor(detail.request.status / 100)}xx`;
        await status.selectOption(group);
        await expect(row).toHaveCount(1);
        const excluded = group === '2xx' ? '4xx' : '2xx';
        await status.selectOption(excluded);
        await expect(page.locator('footer')).toContainText('0 total');
        await expect(row).toHaveCount(0);
        await status.selectOption('all');
      }
      results.push({
        status: detail.request.status,
        tokensMatched: true,
        detailMatched: true,
        attemptStatuses: detail.attempts.map((attempt) => attempt.status),
        statusFilterMatched: detail.request.status !== null,
      });
    }
    await search.fill('');
    await search.press('Enter');
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    const result = {
      schemaVersion: 1,
      platform: process.platform,
      client: report.client,
      passed: true,
      matchedRequests: results.length,
      requests: results,
    };
    await fs.writeFile(
      path.join(path.dirname(reportPath), 'traffic-ui-report.json'),
      JSON.stringify(result, null, 2),
      { mode: 0o600 },
    );
    return result;
  } catch {
    throw new Error(`Traffic Monitor comparison failed at ${step}`);
  }
}

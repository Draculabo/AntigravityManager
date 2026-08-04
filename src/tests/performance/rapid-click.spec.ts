import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, expect, test, type Browser, type JSHandle, type Page } from '@playwright/test';
import type { RendererPerformanceRecorderController } from '@/modules/app-shell/performance-recorder/types';
import { createRendererPerformanceRecorder } from '@/tests/performance/support/renderer-recorder';

const CLICK_COUNT = Number(process.env.ANTIGRAVITY_PERFORMANCE_CLICK_COUNT ?? 50);
const DEBUG_PORT = process.env.ANTIGRAVITY_PERFORMANCE_DEBUG_PORT ?? '9333';
const TARGET_SELECTOR = process.env.ANTIGRAVITY_PERFORMANCE_SELECTOR;
const DEFAULT_TARGET_ACCESSIBLE_NAME = 'Open service status';

test.describe('rapid-click responsiveness', () => {
  let browser: Browser;
  let page: Page;
  let recorderHandle: JSHandle<RendererPerformanceRecorderController> | undefined;
  let recordingActive = false;

  test.beforeAll(async () => {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
    const pages = browser.contexts().flatMap((context) => context.pages());
    page = pages.find((candidate) => candidate.url().startsWith('http://localhost:')) ?? pages[0];
    if (!page) {
      throw new Error('No Electron renderer page was exposed by the debugging endpoint');
    }
    await page.waitForLoadState('domcontentloaded');
  });

  test.afterEach(async () => {
    const activeRecorderHandle = recorderHandle;
    recorderHandle = undefined;
    if (!activeRecorderHandle) {
      recordingActive = false;
      return;
    }

    try {
      if (recordingActive) {
        const snapshot = await activeRecorderHandle.evaluate((recorder) => recorder.stop());
        await page.evaluate(async (rendererSnapshot) => {
          if (window.electron.stopPerformanceRecording) {
            await window.electron.stopPerformanceRecording(rendererSnapshot);
          }
        }, snapshot);
      }
    } catch {
      // Preserve the original test failure while still releasing the renderer handle.
    } finally {
      await activeRecorderHandle.dispose();
      recordingActive = false;
    }
  });

  test('keeps the renderer and Electron main process responsive', async () => {
    const target = TARGET_SELECTOR
      ? page.locator(TARGET_SELECTOR).first()
      : page
          .getByRole('button', {
            exact: true,
            name: DEFAULT_TARGET_ACCESSIBLE_NAME,
          })
          .first();
    await expect(target).toBeVisible();

    const activeRecorderHandle = await page.evaluateHandle(createRendererPerformanceRecorder);
    recorderHandle = activeRecorderHandle;
    await activeRecorderHandle.evaluate((recorder) => recorder.start());
    const recording = await page
      .evaluate(async () => {
        if (!window.electron.startPerformanceRecording) {
          throw new Error('Performance recorder bridge is disabled');
        }
        return window.electron.startPerformanceRecording('rapid-click');
      })
      .catch(async (error: unknown) => {
        await activeRecorderHandle.evaluate((recorder) => recorder.stop()).catch(() => undefined);
        await activeRecorderHandle.dispose();
        recorderHandle = undefined;
        throw error;
      });
    recordingActive = true;
    expect(recording).toMatchObject({
      sessionId: expect.any(String),
    });

    const clickDurationsMs: number[] = [];
    for (let index = 0; index < CLICK_COUNT; index += 1) {
      const startedAt = Date.now();
      await target.click({ force: true, timeout: 10_000 });
      clickDurationsMs.push(Date.now() - startedAt);
    }

    const rendererHeartbeatMs = await page.evaluate(async () => {
      const startedAt = performance.now();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return performance.now() - startedAt;
    });
    const snapshot = await activeRecorderHandle.evaluate((recorder) => recorder.stop());
    const summary = await page.evaluate(async (rendererSnapshot) => {
      if (!window.electron.stopPerformanceRecording) {
        throw new Error('Performance recorder bridge is disabled');
      }
      return window.electron.stopPerformanceRecording(rendererSnapshot);
    }, snapshot);
    recordingActive = false;
    await activeRecorderHandle.dispose();
    recorderHandle = undefined;

    const scenario = {
      clickCount: CLICK_COUNT,
      clickDurationsMs,
      maxClickDurationMs: Math.max(...clickDurationsMs),
      rendererHeartbeatMs,
      locator: TARGET_SELECTOR
        ? { kind: 'css', selector: TARGET_SELECTOR }
        : {
            accessibleName: DEFAULT_TARGET_ACCESSIBLE_NAME,
            kind: 'role',
            role: 'button',
          },
      summary,
    };
    await writeFile(
      join(recording.artifactDirectory, 'rapid-click-scenario.json'),
      `${JSON.stringify(scenario, null, 2)}\n`,
    );

    expect(summary).toMatchObject({
      sessionId: recording.sessionId,
    });
    expect(rendererHeartbeatMs).toBeLessThan(1_000);
    expect(summary.thresholdsExceeded.mainEventLoop200Ms).toBe(false);
    expect(summary.thresholdsExceeded.rendererLongTask200Ms).toBe(false);
  });
});

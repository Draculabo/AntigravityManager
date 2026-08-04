import { describe, expect, it } from 'vitest';
import { buildPerformanceSummary } from '@/modules/app-shell/performance-recorder/summary';

describe('performance recorder summary', () => {
  it('aggregates process, event-loop, and renderer measurements', () => {
    const summary = buildPerformanceSummary({
      appMetricsPath: 'run/app-metrics.json',
      appMetricsSamples: [
        {
          processes: [
            {
              cpuPercent: 12,
              memory: {
                peakWorkingSetSizeKb: 120,
                workingSetSizeKb: 100,
              },
              pid: 10,
              type: 'Browser',
            },
          ],
          timestampMs: 1,
        },
        {
          processes: [
            {
              cpuPercent: 25,
              memory: {
                peakWorkingSetSizeKb: 160,
                workingSetSizeKb: 140,
              },
              pid: 10,
              type: 'Browser',
            },
          ],
          timestampMs: 2,
        },
      ],
      durationMs: 2_000,
      eventLoopDelayPath: 'run/event-loop-delay.json',
      eventLoopDelaySamples: [
        { delayMs: 5, timestampMs: 1 },
        { delayMs: 240, timestampMs: 2 },
      ],
      histogram: {
        maxMs: 240,
        meanMs: 12,
        minMs: 1,
        p50Ms: 5,
        p95Ms: 220,
        p99Ms: 240,
        stddevMs: 20,
      },
      rendererEntriesPath: 'run/renderer-long-tasks.json',
      rendererSnapshot: {
        capturedAt: '2026-08-04T00:00:02.000Z',
        events: [
          {
            durationMs: 80,
            name: 'click',
            processingEndMs: 90,
            processingStartMs: 10,
            startTimeMs: 5,
          },
        ],
        longTasks: [{ durationMs: 210, name: 'self', startTimeMs: 10 }],
        timeOrigin: 1,
      },
      sessionId: 'session-1',
      startedAt: '2026-08-04T00:00:00.000Z',
      stoppedAt: '2026-08-04T00:00:02.000Z',
      summaryPath: 'run/summary.json',
      tracePath: 'run/electron-trace.json',
    });

    expect(summary).toEqual({
      artifacts: {
        appMetrics: 'run/app-metrics.json',
        eventLoopDelay: 'run/event-loop-delay.json',
        rendererEntries: 'run/renderer-long-tasks.json',
        summary: 'run/summary.json',
        trace: 'run/electron-trace.json',
      },
      durationMs: 2_000,
      mainEventLoop: {
        maxMs: 240,
        meanMs: 12,
        minMs: 1,
        p50Ms: 5,
        p95Ms: 220,
        p99Ms: 240,
        samplesAtOrAbove200Ms: 1,
        stddevMs: 20,
      },
      processes: [
        {
          maxCpuPercent: 25,
          maxWorkingSetSizeKb: 140,
          name: undefined,
          pid: 10,
          serviceName: undefined,
          type: 'Browser',
        },
      ],
      renderer: {
        eventCount: 1,
        longTaskCount: 1,
        maxEventDurationMs: 80,
        maxLongTaskDurationMs: 210,
      },
      sessionId: 'session-1',
      startedAt: '2026-08-04T00:00:00.000Z',
      stoppedAt: '2026-08-04T00:00:02.000Z',
      thresholdsExceeded: {
        mainEventLoop200Ms: true,
        rendererLongTask200Ms: true,
      },
    });
  });
});

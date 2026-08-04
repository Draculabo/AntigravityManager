import type {
  EventLoopDelayHistogram,
  EventLoopDelaySample,
  PerformanceAppMetricsSample,
  PerformanceRecordingSummary,
  RendererPerformanceSnapshot,
} from './types';

interface BuildPerformanceSummaryInput {
  appMetricsPath: string;
  appMetricsSamples: PerformanceAppMetricsSample[];
  durationMs: number;
  eventLoopDelayPath: string;
  eventLoopDelaySamples: EventLoopDelaySample[];
  histogram: EventLoopDelayHistogram;
  rendererEntriesPath: string;
  rendererSnapshot: RendererPerformanceSnapshot;
  sessionId: string;
  startedAt: string;
  stoppedAt: string;
  summaryPath: string;
  tracePath: string;
}

export function buildPerformanceSummary(
  input: BuildPerformanceSummaryInput,
): PerformanceRecordingSummary {
  const processSummaries = new Map<string, PerformanceRecordingSummary['processes'][number]>();

  for (const sample of input.appMetricsSamples) {
    for (const processMetric of sample.processes) {
      const key = `${processMetric.type}:${processMetric.pid}`;
      const existing = processSummaries.get(key);
      processSummaries.set(key, {
        maxCpuPercent: Math.max(existing?.maxCpuPercent ?? 0, processMetric.cpuPercent),
        maxWorkingSetSizeKb: Math.max(
          existing?.maxWorkingSetSizeKb ?? 0,
          processMetric.memory.workingSetSizeKb,
        ),
        name: processMetric.name ?? existing?.name,
        pid: processMetric.pid,
        serviceName: processMetric.serviceName ?? existing?.serviceName,
        type: processMetric.type,
      });
    }
  }

  const maxEventDurationMs = input.rendererSnapshot.events.reduce(
    (maximum, entry) => Math.max(maximum, entry.durationMs),
    0,
  );
  const maxLongTaskDurationMs = input.rendererSnapshot.longTasks.reduce(
    (maximum, entry) => Math.max(maximum, entry.durationMs),
    0,
  );
  const samplesAtOrAbove200Ms = input.eventLoopDelaySamples.filter(
    (sample) => sample.delayMs >= 200,
  ).length;

  return {
    artifacts: {
      appMetrics: input.appMetricsPath,
      eventLoopDelay: input.eventLoopDelayPath,
      rendererEntries: input.rendererEntriesPath,
      summary: input.summaryPath,
      trace: input.tracePath,
    },
    durationMs: input.durationMs,
    mainEventLoop: {
      ...input.histogram,
      samplesAtOrAbove200Ms,
    },
    processes: [...processSummaries.values()].sort(
      (left, right) => right.maxCpuPercent - left.maxCpuPercent,
    ),
    renderer: {
      eventCount: input.rendererSnapshot.events.length,
      longTaskCount: input.rendererSnapshot.longTasks.length,
      maxEventDurationMs,
      maxLongTaskDurationMs,
    },
    sessionId: input.sessionId,
    startedAt: input.startedAt,
    stoppedAt: input.stoppedAt,
    thresholdsExceeded: {
      mainEventLoop200Ms: input.histogram.maxMs >= 200 || samplesAtOrAbove200Ms > 0,
      rendererLongTask200Ms: maxLongTaskDurationMs >= 200,
    },
  };
}

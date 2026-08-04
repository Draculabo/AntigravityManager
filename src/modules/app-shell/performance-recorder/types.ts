import { z } from 'zod';

export const PERFORMANCE_RECORDER_ENABLED_ENV = 'ANTIGRAVITY_ENABLE_PERFORMANCE_RECORDER';
export const PERFORMANCE_RECORDER_OUTPUT_ENV = 'ANTIGRAVITY_PERFORMANCE_OUTPUT_DIR';
export const PERFORMANCE_RECORDER_DEBUG_PORT_ENV = 'ANTIGRAVITY_PERFORMANCE_DEBUG_PORT';

export const RendererLongTaskEntrySchema = z.object({
  durationMs: z.number().nonnegative(),
  name: z.string().max(256),
  startTimeMs: z.number().nonnegative(),
});

export const RendererEventTimingEntrySchema = z.object({
  durationMs: z.number().nonnegative(),
  interactionId: z.number().nonnegative().optional(),
  name: z.string().max(128),
  processingEndMs: z.number().nonnegative(),
  processingStartMs: z.number().nonnegative(),
  startTimeMs: z.number().nonnegative(),
  targetAriaLabel: z.string().max(128).optional(),
  targetTag: z.string().max(64).optional(),
});

export const RendererPerformanceSnapshotSchema = z.object({
  capturedAt: z.string().datetime(),
  events: z.array(RendererEventTimingEntrySchema).max(20_000),
  longTasks: z.array(RendererLongTaskEntrySchema).max(20_000),
  timeOrigin: z.number().nonnegative(),
});

export type RendererLongTaskEntry = z.infer<typeof RendererLongTaskEntrySchema>;
export type RendererEventTimingEntry = z.infer<typeof RendererEventTimingEntrySchema>;
export type RendererPerformanceSnapshot = z.infer<typeof RendererPerformanceSnapshotSchema>;

export interface PerformanceRecordingStartResult {
  artifactDirectory: string;
  sessionId: string;
  startedAt: string;
}

export interface PerformanceProcessMetric {
  cpuPercent: number;
  memory: {
    peakWorkingSetSizeKb: number;
    privateBytesKb?: number;
    workingSetSizeKb: number;
  };
  name?: string;
  pid: number;
  serviceName?: string;
  type: Electron.ProcessMetric['type'];
}

export interface PerformanceAppMetricsSample {
  processes: PerformanceProcessMetric[];
  timestampMs: number;
}

export interface EventLoopDelaySample {
  delayMs: number;
  timestampMs: number;
}

export interface EventLoopDelayHistogram {
  maxMs: number;
  meanMs: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  stddevMs: number;
}

export interface PerformanceRecordingSummary {
  artifacts: {
    appMetrics: string;
    eventLoopDelay: string;
    rendererEntries: string;
    summary: string;
    trace: string;
  };
  durationMs: number;
  mainEventLoop: EventLoopDelayHistogram & {
    samplesAtOrAbove200Ms: number;
  };
  processes: Array<{
    maxCpuPercent: number;
    maxWorkingSetSizeKb: number;
    name?: string;
    pid: number;
    serviceName?: string;
    type: Electron.ProcessMetric['type'];
  }>;
  renderer: {
    eventCount: number;
    longTaskCount: number;
    maxEventDurationMs: number;
    maxLongTaskDurationMs: number;
  };
  sessionId: string;
  startedAt: string;
  stoppedAt: string;
  thresholdsExceeded: {
    mainEventLoop200Ms: boolean;
    rendererLongTask200Ms: boolean;
  };
}

export interface RendererPerformanceRecorderController {
  start: () => void;
  stop: () => RendererPerformanceSnapshot;
}

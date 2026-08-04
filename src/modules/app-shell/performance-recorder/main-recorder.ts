import { app, contentTracing } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { buildPerformanceSummary } from './summary';
import {
  PERFORMANCE_RECORDER_ENABLED_ENV,
  PERFORMANCE_RECORDER_DEBUG_PORT_ENV,
  PERFORMANCE_RECORDER_OUTPUT_ENV,
  type EventLoopDelayHistogram,
  type EventLoopDelaySample,
  type PerformanceAppMetricsSample,
  type PerformanceProcessMetric,
  type PerformanceRecordingStartResult,
  type PerformanceRecordingSummary,
  type RendererPerformanceSnapshot,
} from './types';

const APP_METRICS_INTERVAL_MS = 250;
const EVENT_LOOP_INTERVAL_MS = 50;
const NANOSECONDS_PER_MILLISECOND = 1_000_000;
const TRACE_CATEGORY_FILTER = [
  'blink.user_timing',
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-v8.cpu_profiler',
  'electron',
  'toplevel',
  'v8',
].join(',');

interface ActiveRecording extends PerformanceRecordingStartResult {
  appMetricsSamples: PerformanceAppMetricsSample[];
  eventLoopDelaySamples: EventLoopDelaySample[];
  eventLoopHistogram: ReturnType<typeof monitorEventLoopDelay>;
  eventLoopTimer: NodeJS.Timeout;
  metricsTimer: NodeJS.Timeout;
  startedAtMs: number;
}

function roundMilliseconds(value: number): number {
  return Number((value / NANOSECONDS_PER_MILLISECOND).toFixed(3));
}

function sanitizeLabel(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function serializeProcessMetric(metric: Electron.ProcessMetric): PerformanceProcessMetric {
  return {
    cpuPercent: metric.cpu.percentCPUUsage,
    memory: {
      peakWorkingSetSizeKb: metric.memory.peakWorkingSetSize,
      privateBytesKb: metric.memory.privateBytes,
      workingSetSizeKb: metric.memory.workingSetSize,
    },
    name: metric.name,
    pid: metric.pid,
    serviceName: metric.serviceName,
    type: metric.type,
  };
}

function createEmptyHistogram(): EventLoopDelayHistogram {
  return {
    maxMs: 0,
    meanMs: 0,
    minMs: 0,
    p50Ms: 0,
    p95Ms: 0,
    p99Ms: 0,
    stddevMs: 0,
  };
}

export function isPerformanceRecorderEnabled(): boolean {
  return process.env[PERFORMANCE_RECORDER_ENABLED_ENV] === '1';
}

export function configurePerformanceRecorderCommandLine(): void {
  if (!isPerformanceRecorderEnabled()) {
    return;
  }

  const rawPort = process.env[PERFORMANCE_RECORDER_DEBUG_PORT_ENV] ?? '9333';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new Error(`${PERFORMANCE_RECORDER_DEBUG_PORT_ENV} must be a port from 1024 to 65535`);
  }
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  app.commandLine.appendSwitch('remote-debugging-port', String(port));
}

export class ElectronPerformanceRecorder {
  private active: ActiveRecording | null = null;

  async start(label: string): Promise<PerformanceRecordingStartResult> {
    if (!isPerformanceRecorderEnabled()) {
      throw new Error(`Performance recorder requires ${PERFORMANCE_RECORDER_ENABLED_ENV}=1`);
    }
    if (!app.isReady()) {
      throw new Error('Performance recorder cannot start before Electron is ready');
    }
    if (this.active) {
      throw new Error(`Performance recording ${this.active.sessionId} is already active`);
    }

    const safeLabel = sanitizeLabel(label) || 'session';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const sessionId = `${timestamp}-${safeLabel}-${randomUUID().slice(0, 8)}`;
    const outputRoot = process.env[PERFORMANCE_RECORDER_OUTPUT_ENV]
      ? resolve(process.env[PERFORMANCE_RECORDER_OUTPUT_ENV])
      : join(app.getPath('userData'), 'performance-runs');
    const artifactDirectory = join(outputRoot, sessionId);
    await mkdir(artifactDirectory, { recursive: true });

    await contentTracing.startRecording({
      categoryFilter: TRACE_CATEGORY_FILTER,
      traceOptions: 'record-until-full,enable-sampling',
    });

    const startedAtMs = Date.now();
    const eventLoopHistogram = monitorEventLoopDelay({ resolution: 20 });
    eventLoopHistogram.enable();
    const appMetricsSamples: PerformanceAppMetricsSample[] = [];
    const eventLoopDelaySamples: EventLoopDelaySample[] = [];
    let expectedEventLoopTick = performance.now() + EVENT_LOOP_INTERVAL_MS;

    const sampleAppMetrics = () => {
      appMetricsSamples.push({
        processes: app.getAppMetrics().map(serializeProcessMetric),
        timestampMs: Date.now(),
      });
    };
    sampleAppMetrics();

    const metricsTimer = setInterval(sampleAppMetrics, APP_METRICS_INTERVAL_MS);
    const eventLoopTimer = setInterval(() => {
      const now = performance.now();
      eventLoopDelaySamples.push({
        delayMs: Math.max(0, now - expectedEventLoopTick),
        timestampMs: Date.now(),
      });
      expectedEventLoopTick = now + EVENT_LOOP_INTERVAL_MS;
    }, EVENT_LOOP_INTERVAL_MS);

    this.active = {
      appMetricsSamples,
      artifactDirectory,
      eventLoopDelaySamples,
      eventLoopHistogram,
      eventLoopTimer,
      metricsTimer,
      sessionId,
      startedAt: new Date(startedAtMs).toISOString(),
      startedAtMs,
    };

    return {
      artifactDirectory,
      sessionId,
      startedAt: this.active.startedAt,
    };
  }

  async stop(rendererSnapshot: RendererPerformanceSnapshot): Promise<PerformanceRecordingSummary> {
    const recording = this.active;
    if (!recording) {
      throw new Error('No performance recording is active');
    }
    this.active = null;
    clearInterval(recording.metricsTimer);
    clearInterval(recording.eventLoopTimer);
    recording.eventLoopHistogram.disable();

    const stoppedAtMs = Date.now();
    const tracePath = join(recording.artifactDirectory, 'electron-trace.json');
    const appMetricsPath = join(recording.artifactDirectory, 'app-metrics.json');
    const eventLoopDelayPath = join(recording.artifactDirectory, 'event-loop-delay.json');
    const rendererEntriesPath = join(recording.artifactDirectory, 'renderer-long-tasks.json');
    const summaryPath = join(recording.artifactDirectory, 'summary.json');
    await contentTracing.stopRecording(tracePath);

    const histogram = recording.eventLoopHistogram.count
      ? {
          maxMs: roundMilliseconds(recording.eventLoopHistogram.max),
          meanMs: roundMilliseconds(recording.eventLoopHistogram.mean),
          minMs: roundMilliseconds(recording.eventLoopHistogram.min),
          p50Ms: roundMilliseconds(recording.eventLoopHistogram.percentile(50)),
          p95Ms: roundMilliseconds(recording.eventLoopHistogram.percentile(95)),
          p99Ms: roundMilliseconds(recording.eventLoopHistogram.percentile(99)),
          stddevMs: roundMilliseconds(recording.eventLoopHistogram.stddev),
        }
      : createEmptyHistogram();
    const summary = buildPerformanceSummary({
      appMetricsPath,
      appMetricsSamples: recording.appMetricsSamples,
      durationMs: stoppedAtMs - recording.startedAtMs,
      eventLoopDelayPath,
      eventLoopDelaySamples: recording.eventLoopDelaySamples,
      histogram,
      rendererEntriesPath,
      rendererSnapshot,
      sessionId: recording.sessionId,
      startedAt: recording.startedAt,
      stoppedAt: new Date(stoppedAtMs).toISOString(),
      summaryPath,
      tracePath,
    });

    await Promise.all([
      writeFile(appMetricsPath, `${JSON.stringify(recording.appMetricsSamples, null, 2)}\n`),
      writeFile(
        eventLoopDelayPath,
        `${JSON.stringify({ histogram, samples: recording.eventLoopDelaySamples }, null, 2)}\n`,
      ),
      writeFile(rendererEntriesPath, `${JSON.stringify(rendererSnapshot, null, 2)}\n`),
      writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`),
    ]);

    return summary;
  }
}

export const electronPerformanceRecorder = new ElectronPerformanceRecorder();

import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalize } from '@sentry/core';
import { SwitchTraceRecorder } from '@/modules/antigravity-runtime/switch/switchTrace';
import { SwitchTraceSchema } from '@/shared/observability/switchDiagnostic';
import { OperationContext } from '@/shared/observability/operationContext';
import {
  configureErrorReportingRuntime,
  type ErrorReportingRuntime,
} from '@/shared/observability/errorReporting';
import {
  attachOperationScope,
  projectOperationSentryEvent,
} from '@/shared/observability/operationSentry';
import { sanitizeLogRecord } from '@/modules/app-shell/diagnostic-logs/sanitize-record';
import { logger } from '@/shared/logging/logger';
import { classifyOperationCause } from '@/modules/cloud-account/services/operation-cause';
import { processError } from '@/modules/antigravity-runtime/processErrors';

afterEach(() => {
  configureErrorReportingRuntime(
    { initialize() {}, report() {}, flush: async () => true },
    false,
    false,
  );
  vi.restoreAllMocks();
});
describe('bounded switch attempt diagnostics', () => {
  it('keeps successful recovery when diagnostic logging is unavailable', async () => {
    vi.spyOn(logger, 'info').mockImplementation(() => {
      throw new Error('log transport unavailable');
    });
    const operation = new OperationContext('cloud-account-switch');
    await expect(
      operation.run(async () => {
        const recorder = new SwitchTraceRecorder();
        await recorder
          .phase(
            'service-stop',
            'hot',
            async () => {
              throw processError('exit-unconfirmed');
            },
            'restart',
          )
          .catch(() => {});
        operation.setSwitchTrace(recorder.finish('recovered-by-restart'));
        operation.completeSwitch();
      }),
    ).resolves.toBeUndefined();
  });
  it('retains primary/recovery evidence, source coordinates and final outcome through logger, export and SDK normalization', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const capture = vi.fn<ErrorReportingRuntime['report']>(() => 'a'.repeat(32));
    configureErrorReportingRuntime(
      { initialize() {}, report: capture, flush: async () => true },
      true,
      true,
    );
    const operation = new OperationContext('cloud-account-switch');
    await operation.run(async () => {
      const recorder = new SwitchTraceRecorder();
      const hot = Object.assign(new Error('Bearer private-secret private@example.test'), {
        code: 'EACCES',
      });
      hot.stack =
        'Error private\n at write (C:\\Users\\private\\src\\modules\\antigravity-runtime\\credentials\\clientAccountWrite.ts:93:11)\n' +
        'private'.repeat(4000);
      hot.cause = hot;
      await recorder
        .phase(
          'hot-write',
          'hot',
          async () => {
            throw hot;
          },
          'restart',
        )
        .catch(() => {});
      await recorder.phase('client-close', 'restart', async () => {
        recorder.effects.client = 'stopped';
      });
      await recorder
        .phase('restart-write', 'restart', async () => {
          throw processError('probe-failed');
        })
        .catch(() => {});
      operation.setSwitchTrace(recorder.finish('failed'));
      operation.finish({ stage: 'target-write', reason: 'storage-failed', target: 'classic' });
    });
    const report = capture.mock.calls[0][0].operation!;
    const trace = report.switchTrace!;
    expect(
      trace.steps.filter((step) => step.outcome === 'failed').map((step) => step.stage),
    ).toEqual(['hot-write', 'restart-write']);
    expect(trace.steps[1]).toMatchObject({
      errors: [{ kind: 'native', code: 'EACCES' }],
      sources: [
        {
          filename: 'src/modules/antigravity-runtime/credentials/clientAccountWrite.ts',
          lineno: 93,
          colno: 11,
        },
      ],
      detailsTruncated: true,
    });
    const logTrace = info.mock.calls.find((call) => call[0] === 'Switch trace v1')?.[1];
    expect(logTrace).toEqual(trace);
    expect(sanitizeLogRecord('Switch trace v1 ' + JSON.stringify(trace))).toEqual({
      text: 'Switch trace v1 ' + JSON.stringify(trace),
      removed: false,
    });
    const scope = { setTag: vi.fn(), setContext: vi.fn(), setFingerprint: vi.fn() };
    attachOperationScope(scope, report);
    const event = projectOperationSentryEvent({
      type: undefined,
      tags: {
        operation_diagnostic_schema: '1',
        operation_runtime: 'standalone-core',
        private: 'private-secret',
      },
      contexts: normalize(
        {
          operation_diagnostic: { serialized: JSON.stringify(report) },
          private: { token: 'private-secret' },
        },
        3,
      ),
      extra: { secret: 'private-secret' },
    });
    expect(event?.contexts?.operation_diagnostic).toEqual(report);
    expect(event?.tags?.switch_outcome).toBe('failed');
    expect(JSON.stringify(event)).not.toMatch(/private|Bearer|@example/);
    expect(SwitchTraceSchema.safeParse(trace).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(trace))).toBeLessThan(48 * 1024);
  });

  it('projects recovered attempts as a warning and preserves their complete successful recovery', async () => {
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    const capture = vi.fn<ErrorReportingRuntime['report']>(() => 'a'.repeat(32));
    configureErrorReportingRuntime(
      { initialize() {}, report: capture, flush: async () => true },
      true,
      true,
    );
    const operation = new OperationContext('cloud-account-switch');
    await operation.run(async () => {
      const recorder = new SwitchTraceRecorder();
      await recorder
        .phase(
          'service-stop',
          'hot',
          async () => {
            throw processError('exit-unconfirmed');
          },
          'restart',
        )
        .catch(() => {});
      for (const stage of [
        'restart-ownership',
        'client-close',
        'restart-write',
        'terms-restore',
        'client-start',
        'account-finalize',
      ] as const) {
        await recorder.phase(stage, 'restart', async () => {});
      }
      operation.setSwitchTrace(recorder.finish('recovered-by-restart'));
      operation.completeSwitch();
    });
    const report = capture.mock.calls[0][0].operation!;
    const event = projectOperationSentryEvent({
      type: undefined,
      tags: { operation_diagnostic_schema: '1' },
      contexts: { operation_diagnostic: { serialized: JSON.stringify(report) } },
    });
    expect(event?.level).toBe('warning');
    expect(event?.exception?.values?.[0].type).toBe('OperationRecovered');
    expect(event?.contexts?.operation_diagnostic).toEqual(report);
    expect(report.steps.at(-1)).toEqual({ stage: 'account-finalize', outcome: 'succeeded' });
    expect(report.switchTrace?.steps).toHaveLength(14);
    const oversizedMetadata = projectOperationSentryEvent({
      type: undefined,
      tags: { operation_diagnostic_schema: '1' },
      contexts: {
        operation_diagnostic: { serialized: JSON.stringify(report) },
        os: { name: 'Windows', version: '1'.repeat(70_000) },
      },
    });
    expect(oversizedMetadata?.contexts?.operation_diagnostic).toEqual({
      failure: report.failure,
      steps: [],
      stepsTruncated: true,
      switchTrace: report.switchTrace,
    });
  });

  it('rejects arbitrary fields, source paths and oversized traces from export', () => {
    const base = {
      schemaVersion: 1,
      diagnosticId: crypto.randomUUID(),
      target: 'classic',
      outcome: 'failed',
      steps: [],
    };
    for (const value of [
      { ...base, email: 'private@example.test' },
      { ...base, steps: Array.from({ length: 33 }, () => ({})) },
      {
        ...base,
        steps: [
          {
            stage: 'hot-write',
            sources: [{ filename: 'C:\\Users\\private\\file.ts', lineno: 1, colno: 1 }],
          },
        ],
      },
    ]) {
      expect(sanitizeLogRecord('Switch trace v1 ' + JSON.stringify(value))).toEqual({
        text: '[Content removed]',
        removed: true,
      });
    }
  });

  it('classifies an initiating and recovery failure without discarding either sibling', () => {
    const hot = Object.assign(new Error('private first failure'), { code: 'EACCES' });
    const recovery = processError('exit-unconfirmed');
    const result = classifyOperationCause(
      new AggregateError([recovery, hot], 'Recovery failed', { cause: recovery }),
    );
    expect(result.causes).toEqual([
      { reason: 'unknown' },
      {
        reason: 'timed-out',
        nativeCode: 'ANTIGRAVITY_PROCESS_FAILED',
        process: { reason: 'exit-unconfirmed' },
      },
      { reason: 'permission-denied', nativeCode: 'EACCES' },
    ]);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { processError } from '@/modules/antigravity-runtime/processErrors';
import { classifyOperationCause } from '@/modules/cloud-account/services/operation-cause';
import { CloudSwitchDiagnosticSchema } from '@/modules/cloud-account/services/operation-diagnostic.schema';
import { formatOperationDiagnostic } from '@/shared/observability/operationDiagnosticText';
import { OperationContext } from '@/shared/observability/operationContext';
import { configureErrorReportingRuntime } from '@/shared/observability/errorReporting';
import { projectOperationSentryEvent } from '@/shared/observability/operationSentry';
import { normalize } from '@sentry/core';
import { sanitizeLogRecord } from '@/modules/app-shell/diagnostic-logs/sanitize-record';

afterEach(() => {
  configureErrorReportingRuntime(
    { initialize() {}, report() {}, flush: async () => true },
    false,
    false,
  );
  vi.restoreAllMocks();
});

describe('process failure classification', () => {
  it('preserves the exact close failure and native code through final diagnostics', () => {
    const cause = processError('window-close-failed', new Error('private-path-and-token'), 5);
    const classified = classifyOperationCause(processError('close-failed', cause));
    expect(classified).toEqual({
      primary: {
        reason: 'permission-denied',
        nativeCode: 'ANTIGRAVITY_PROCESS_FAILED',
        process: { reason: 'window-close-failed', windowsErrorCode: 5 },
      },
      causes: [
        {
          reason: 'process-close-failed',
          nativeCode: 'ANTIGRAVITY_PROCESS_FAILED',
          process: { reason: 'close-failed' },
        },
        {
          reason: 'permission-denied',
          nativeCode: 'ANTIGRAVITY_PROCESS_FAILED',
          process: { reason: 'window-close-failed', windowsErrorCode: 5 },
        },
        { reason: 'unknown' },
      ],
      causesTruncated: false,
    });
    const reports: Parameters<typeof projectOperationSentryEvent>[0][] = [];
    configureErrorReportingRuntime(
      {
        initialize() {},
        report(event) {
          if (event.operation) {
            reports.push({
              type: undefined,
              tags: { operation_diagnostic_schema: '1' },
              contexts: normalize(
                { operation_diagnostic: { serialized: JSON.stringify(event.operation) } },
                3,
              ),
            });
          }
          return 'a'.repeat(32);
        },
        flush: async () => true,
      },
      true,
      true,
    );
    const diagnostic = new OperationContext('cloud-account-switch').finish({
      stage: 'process-close',
      target: 'classic',
      storage: 'credential-store',
      ...classified.primary,
      reason: 'process-close-failed',
      causes: classified.causes,
      rollback: 'not-attempted',
    });
    expect(CloudSwitchDiagnosticSchema.parse(diagnostic)).toEqual(diagnostic);
    expect(formatOperationDiagnostic(diagnostic)).toContain('"windowsErrorCode":5');
    expect(formatOperationDiagnostic(diagnostic)).toContain(
      `Diagnostic ID: ${diagnostic.diagnosticId}`,
    );
    expect(JSON.stringify(diagnostic)).not.toContain('private-path-and-token');
    expect(reports).toHaveLength(1);
    const projected = projectOperationSentryEvent(reports[0]);
    expect(projected?.contexts?.operation_diagnostic).toMatchObject({
      failure: { causes: classified.causes },
    });
    const record = `Operation diagnostic v1 ${JSON.stringify(diagnostic)}`;
    const sanitized = sanitizeLogRecord(record);
    expect(sanitized.removed).toBe(false);
    expect(sanitized.text).toMatch(/^Operation diagnostic v1 /);
    expect(JSON.parse(sanitized.text.slice('Operation diagnostic v1 '.length))).toEqual(diagnostic);
    for (const process of [
      { reason: 'close-failed', executablePath: 'private-native-path' },
      { reason: 'close-failed', windowsErrorCode: 'private-native-prose' },
    ]) {
      const malformed = { ...diagnostic, process };
      expect(CloudSwitchDiagnosticSchema.safeParse(malformed).success).toBe(false);
      expect(sanitizeLogRecord(`Operation diagnostic v1 ${JSON.stringify(malformed)}`)).toEqual({
        text: '[Content removed]',
        removed: true,
      });
      const { reporting: _reporting, ...failure } = malformed;
      expect(
        projectOperationSentryEvent({
          type: undefined,
          tags: { operation_diagnostic_schema: '1' },
          contexts: {
            operation_diagnostic: {
              serialized: JSON.stringify({ failure, steps: [], stepsTruncated: false }),
            },
          },
        }),
      ).toBeNull();
    }
  });
  it.each([
    ['target-conflict', 'unavailable'],
    ['exit-unconfirmed', 'timed-out'],
    ['no-closable-window', 'process-close-failed'],
  ] as const)('retains %s without inferring from message strings', (failure, reason) => {
    expect(classifyOperationCause(processError(failure)).primary).toEqual({
      reason,
      nativeCode: 'ANTIGRAVITY_PROCESS_FAILED',
      process: { reason: failure },
    });
  });
});

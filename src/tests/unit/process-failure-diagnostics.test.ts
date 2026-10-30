import { afterEach, describe, expect, it, vi } from 'vitest';
import { processError, processOwnershipError } from '@/modules/antigravity-runtime/processErrors';
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
  it('retains a native permission failure as primary when adding observation context', () => {
    const cause = Object.assign(new Error('private native path'), { code: 'EPERM' });
    const error = processOwnershipError(
      'probe-failed',
      { reason: 'observation-failed', capturedCount: 1 },
      cause,
    );
    const classified = classifyOperationCause(error);
    expect(classified.primary).toEqual({ reason: 'permission-denied', nativeCode: 'EPERM' });
    expect(classified.causes).toEqual([
      {
        reason: 'unavailable',
        nativeCode: 'ANTIGRAVITY_PROCESS_FAILED',
        process: error.processDiagnostic,
      },
      { reason: 'permission-denied', nativeCode: 'EPERM' },
    ]);
  });
  it('keeps four ownership causes and write certainty within the public diagnostic budget', () => {
    const process = {
      reason: 'switched-startup-unconfirmed',
      windowsErrorCode: 0xffffffff,
      ownership: {
        reason: 'metadata-unavailable',
        capturedCount: 0xffffffff,
        observedCount: 0xffffffff,
        matchedCount: 0xffffffff,
      },
    };
    const cause = {
      reason: 'process-close-failed',
      nativeCode: 'ANTIGRAVITY_PROCESS_FAILED',
      process,
    };
    const diagnostic = {
      schemaVersion: 1,
      diagnosticId: '00000000-0000-4000-8000-000000000000',
      operation: 'cloud-account-switch',
      stage: 'process-close',
      ...cause,
      target: 'classic',
      storage: 'credential-store',
      rollback: 'not-attempted',
      credentialWrite: 'uncertain',
      readback: {
        accessToken: false,
        refreshToken: false,
        idToken: false,
        expiry: false,
        projectId: false,
      },
      causes: [cause, cause, cause, cause],
      causesTruncated: true,
      switchRecovery: {
        outcome: 'failed',
        hotFailureStage: 'credential-reassert',
        recoveryFailureStage: 'restart-ownership',
      },
      reporting: { state: 'captured', eventId: 'a'.repeat(32) },
    };
    expect(CloudSwitchDiagnosticSchema.parse(diagnostic)).toEqual(diagnostic);
    expect(new TextEncoder().encode(JSON.stringify(diagnostic)).length).toBeLessThanOrEqual(2048);
  });
  it('preserves ownership evidence and write certainty through export and Sentry projection', () => {
    const ownership = {
      reason: 'main-missing' as const,
      capturedCount: 2,
      observedCount: 1,
      matchedCount: 1,
    };
    const classified = classifyOperationCause(
      processOwnershipError('switched-hot-unconfirmed', ownership),
    );
    const diagnostic = CloudSwitchDiagnosticSchema.parse({
      schemaVersion: 1,
      diagnosticId: '00000000-0000-4000-8000-000000000000',
      operation: 'cloud-account-switch',
      stage: 'process-close',
      target: 'classic',
      ...classified.primary,
      reason: 'process-close-failed',
      causes: classified.causes,
      credentialWrite: 'confirmed',
      reporting: { state: 'not-reported', reason: 'disabled' },
    });
    expect(diagnostic.process?.ownership).toEqual(ownership);
    expect(formatOperationDiagnostic(diagnostic)).toContain(
      `Process ownership: ${JSON.stringify(ownership)}`,
    );
    expect(formatOperationDiagnostic(diagnostic)).toContain('Client credential write: confirmed');
    const record = `Operation diagnostic v1 ${JSON.stringify(diagnostic)}`;
    expect(sanitizeLogRecord(record)).toEqual({ text: record, removed: false });
    const { reporting: _reporting, ...failure } = diagnostic;
    const projected = projectOperationSentryEvent({
      type: undefined,
      tags: { operation_diagnostic_schema: '1' },
      contexts: normalize(
        {
          operation_diagnostic: {
            serialized: JSON.stringify({ failure, steps: [], stepsTruncated: false }),
          },
        },
        3,
      ),
    });
    expect(projected?.contexts?.operation_diagnostic).toEqual({
      failure,
      steps: [],
      stepsTruncated: false,
    });
    for (const invalid of [
      { ...ownership, executablePath: 'private-path' },
      { ...ownership, reason: 'private-reason' },
      { ...ownership, capturedCount: -1 },
      { ...ownership, observedCount: 0x100000000 },
    ]) {
      const unsafe = { ...diagnostic, process: { ...diagnostic.process, ownership: invalid } };
      expect(CloudSwitchDiagnosticSchema.safeParse(unsafe).success).toBe(false);
      expect(sanitizeLogRecord(`Operation diagnostic v1 ${JSON.stringify(unsafe)}`)).toEqual({
        text: '[Content removed]',
        removed: true,
      });
    }
  });
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

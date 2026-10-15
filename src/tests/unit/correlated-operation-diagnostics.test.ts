import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ErrorEvent } from '@sentry/node';
import winston from 'winston';
import { z } from 'zod';
import { ORPCError } from '@orpc/server';
import { normalize } from '@sentry/core';
import { logger } from '@/shared/logging/logger';
import {
  configureErrorReportingRuntime,
  type ErrorReportingRuntime,
} from '@/shared/observability/errorReporting';
import { OperationContext } from '@/shared/observability/operationContext';
import {
  OperationDiagnosticSchema,
  type OperationDiagnostic,
  type OperationFailure,
  readFinalizedOperationDiagnostic,
} from '@/shared/observability/operationDiagnostic';
import {
  attachOperationScope,
  projectOperationSentryEvent,
} from '@/shared/observability/operationSentry';
import { CloudOperationDiagnosticSchema } from '@/modules/cloud-account/diagnostics';
import {
  classifyOperationCause,
  GoogleApiDiagnosticError,
} from '@/modules/cloud-account/services/operation-cause';
import { sanitizeLogRecord } from '@/modules/app-shell/diagnostic-logs/sanitize-record';
import { diagnosticId, loginDiagnostic } from '../fixtures/oauth-diagnostic';
import { currentOperationIdentity } from '@/shared/observability/operationScope';

afterEach(() => {
  configureErrorReportingRuntime(
    { initialize() {}, report() {}, flush: async () => true },
    false,
    false,
  );
  vi.restoreAllMocks();
});

describe('correlated operation diagnostics', () => {
  it('reads owner errors and deserialized transport envelopes through the same diagnostic contract', () => {
    const diagnostic = loginDiagnostic('login-failed');
    const values = [
      Object.assign(new Error('Private owner detail'), { diagnostic }),
      new ORPCError('INTERNAL_SERVER_ERROR', { data: { diagnostic } }),
      { diagnostic },
      { data: { diagnostic } },
    ];
    expect(values.map(readFinalizedOperationDiagnostic)).toEqual(values.map(() => diagnostic));
  });

  it('rejects malformed envelopes and never bypasses an invalid direct diagnostic', () => {
    const diagnostic = loginDiagnostic('login-failed');
    const invalidDiagnostic = {
      ...diagnostic,
      reporting: { state: 'captured', eventId: 'invalid' },
    };
    const values = [
      null,
      undefined,
      'Private detail',
      new Error('Private detail'),
      { data: null },
      { diagnostic: invalidDiagnostic },
      { data: { diagnostic: invalidDiagnostic } },
      { diagnostic: invalidDiagnostic, data: { diagnostic } },
      { diagnostic: undefined, data: { diagnostic } },
    ];
    expect(values.map(readFinalizedOperationDiagnostic)).toEqual(values.map(() => null));
  });

  it('correlates concurrent logging and releases scopes after completion', async () => {
    const report = vi.fn<ErrorReportingRuntime['report']>(() => 'a'.repeat(32));
    configureErrorReportingRuntime(
      { initialize() {}, report, flush: async () => true },
      true,
      true,
    );
    const first = new OperationContext('google-login');
    const second = new OperationContext('cloud-account-switch');
    const gate = Promise.withResolvers<void>();
    let detached: (() => unknown) | undefined;
    await Promise.all([
      first.run(async () => {
        await gate.promise;
        expect(currentOperationIdentity()?.diagnosticId).toBe(first.diagnosticId);
        const late = Promise.withResolvers<void>();
        const pending = late.promise.then(() => currentOperationIdentity());
        detached = async () => {
          late.resolve();
          return pending;
        };
        logger.error('Classified by the owner');
      }),
      second.run(async () => {
        expect(currentOperationIdentity()?.diagnosticId).toBe(second.diagnosticId);
        logger.error('Classified by another owner');
        gate.resolve();
      }),
    ]);
    expect(report).not.toHaveBeenCalled();
    expect(currentOperationIdentity()).toBeUndefined();
    expect(await detached?.()).toBeUndefined();
    logger.error('Ordinary error outside an operation');
    expect(report).toHaveBeenCalledOnce();
  });
  it.each([
    ['ENOTFOUND', 'dns-failed'],
    ['EAI_AGAIN', 'dns-failed'],
    ['ECONNREFUSED', 'connection-refused'],
    ['ECONNRESET', 'connection-reset'],
    ['ETIMEDOUT', 'timed-out'],
    ['CERT_HAS_EXPIRED', 'tls-failed'],
    ['EACCES', 'permission-denied'],
    ['SQLITE_BUSY', 'locked'],
  ])('retains a recognized %s through a transport cause', (code, reason) => {
    const error = new GoogleApiDiagnosticError(
      'Private network prose',
      { reason: 'network-failed' },
      Object.assign(new Error('private-token and private-host'), { code }),
    );
    expect(classifyOperationCause(error)).toEqual({
      primary: { reason, nativeCode: code },
      causes: [{ reason: 'network-failed' }, { reason, nativeCode: code }],
      causesTruncated: false,
    });
  });

  it('does not guess DNS or proxy from arbitrary messages and bounds cyclic causes', () => {
    const cause = new Error('DNS failed; proxy failed; private-secret');
    cause.cause = cause;
    expect(classifyOperationCause(cause)).toEqual({
      primary: { reason: 'unknown' },
      causes: [{ reason: 'unknown' }],
      causesTruncated: true,
    });
    expect(
      classifyOperationCause({ code: 'private-secret', cause: { request: 'private-secret' } }),
    ).toEqual({
      primary: { reason: 'unknown' },
      causes: [{ reason: 'unknown' }, { reason: 'unknown' }],
      causesTruncated: false,
    });
  });

  it('finalizes once and suppresses ordinary forwarding even with a captured receipt', () => {
    const eventId = 'a'.repeat(32);
    const report = vi.fn<ErrorReportingRuntime['report']>(() => eventId);
    configureErrorReportingRuntime(
      { initialize() {}, report, flush: async () => true },
      true,
      true,
    );
    const context = new OperationContext('google-login', diagnosticId);
    context.observe('token-exchange', 'started');
    const terminal = context.finish({
      stage: 'token-exchange',
      reason: 'dns-failed',
      nativeCode: 'ENOTFOUND',
      accountCommit: 'not-attempted',
    });
    expect(terminal.reporting).toEqual({ state: 'captured', eventId });
    expect(context.finish({ stage: 'account-persist', reason: 'storage-failed' })).toBe(terminal);
    logger.error(
      'Forwarded failure',
      new ORPCError('INTERNAL_SERVER_ERROR', { data: { diagnostic: terminal } }),
    );
    expect(report).toHaveBeenCalledOnce();
    expect(report.mock.calls[0]).toEqual([
      {
        level: 'error',
        message: 'Operation failed',
        logs: [],
        operation: {
          failure: {
            schemaVersion: 1,
            diagnosticId,
            operation: 'google-login',
            stage: 'token-exchange',
            reason: 'dns-failed',
            nativeCode: 'ENOTFOUND',
            accountCommit: 'not-attempted',
          },
          steps: [
            { stage: 'token-exchange', outcome: 'started' },
            { stage: 'token-exchange', outcome: 'failed' },
          ],
          stepsTruncated: false,
        },
      },
    ]);
  });

  it.each([
    [false, true, 'disabled'],
    [true, false, 'unconfigured'],
  ] as const)(
    'keeps local references when enabled=%s, configured=%s',
    (enabled, hasDsn, reason) => {
      const report = vi.fn();
      configureErrorReportingRuntime(
        { initialize() {}, report, flush: async () => true },
        enabled,
        hasDsn,
      );
      const terminal = new OperationContext('google-login').finish({
        stage: 'token-exchange',
        reason: 'unknown',
        accountCommit: 'not-attempted',
      });
      logger.error('Forwarded failure', { diagnostic: terminal });
      expect(terminal.reporting).toEqual({ state: 'not-reported', reason });
      expect(report).not.toHaveBeenCalled();
      expect(OperationDiagnosticSchema.safeParse(terminal).success).toBe(true);
    },
  );

  it('keeps failed, unavailable and expected-outcome receipts without recapture', () => {
    const report = vi.fn(() => {
      throw new Error('private dispatch detail');
    });
    configureErrorReportingRuntime(
      { initialize() {}, report, flush: async () => true },
      true,
      true,
    );
    const terminal = new OperationContext('google-login').finish({
      stage: 'token-exchange',
      reason: 'unknown',
      accountCommit: 'not-attempted',
    });
    expect(terminal.reporting).toEqual({ state: 'failed' });
    logger.error('Forwarded failure', { diagnostic: terminal });
    const expected = new OperationContext('google-login').finish(
      { stage: 'duplicate-check', reason: 'duplicate-account', accountCommit: 'not-attempted' },
      true,
    );
    expect(expected.reporting).toEqual({ state: 'not-reported', reason: 'expected-outcome' });
    expect(report).toHaveBeenCalledOnce();
    configureErrorReportingRuntime(
      {
        initialize() {
          throw new Error('private');
        },
        report,
        flush: async () => true,
      },
      true,
      true,
    );
    expect(
      new OperationContext('google-login').finish({
        stage: 'token-exchange',
        reason: 'unknown',
        accountCommit: 'not-attempted',
      }).reporting,
    ).toEqual({ state: 'not-reported', reason: 'unavailable' });
  });

  it('keeps parallel identities and bounded observations separate', async () => {
    const log = vi.spyOn(logger, 'info');
    const contexts = [
      new OperationContext('google-login'),
      new OperationContext('cloud-account-switch'),
    ];
    for (let index = 0; index < 20; index += 1) {
      contexts[0].observe('token-exchange', 'started');
    }
    const report = vi.fn<ErrorReportingRuntime['report']>(() => 'a'.repeat(32));
    configureErrorReportingRuntime(
      { initialize() {}, report, flush: async () => true },
      true,
      true,
    );
    const results = await Promise.all(
      contexts.map(async (context) =>
        context.finish({ stage: 'management-transport', reason: 'management-failed' }),
      ),
    );
    expect(results[0].diagnosticId).not.toBe(results[1].diagnosticId);
    expect(report.mock.calls.map((call) => call[0].operation?.failure.diagnosticId)).toEqual(
      results.map((result) => result.diagnosticId),
    );
    expect(report.mock.calls[0][0].operation?.steps).toHaveLength(12);
    expect(report.mock.calls[0][0].operation?.stepsTruncated).toBe(true);
    expect(report.mock.calls[1][0].operation?.steps).toEqual([
      { stage: 'management-transport', outcome: 'failed' },
    ]);
    const steps = log.mock.calls.filter(
      (call) =>
        call[0] === 'Operation step v1' &&
        typeof call[1] === 'object' &&
        call[1] !== null &&
        'diagnosticId' in call[1] &&
        call[1].diagnosticId === contexts[0].diagnosticId,
    );
    expect(steps).toHaveLength(13);
    expect(steps.at(-1)?.[1]).toMatchObject({ truncated: true });
  });

  it('isolates normalized Sentry events from automatic account, request and log data', () => {
    const { reporting, ...baseFailure } = loginDiagnostic('login-failed');
    const failure: OperationFailure = {
      ...baseFailure,
      http: {
        route: 'forward-proxy',
        destination: 'loopback',
        transport: 'plain',
        responseFormat: 'html',
      },
    };
    expect(reporting).toEqual({ state: 'not-reported', reason: 'disabled' });
    const report = { failure, steps: [], stepsTruncated: false };
    const scope = { setTag: vi.fn(), setContext: vi.fn(), setFingerprint: vi.fn() };
    const exception = attachOperationScope(scope, report);
    expect(exception).not.toHaveProperty('cause');
    expect(exception.stack).toBeUndefined();
    const event: ErrorEvent = {
      type: undefined,
      event_id: 'a'.repeat(32),
      release: 'antigravity-manager@0.25.1',
      tags: {
        operation_diagnostic_schema: '1',
        operation_runtime: 'standalone-core',
        account: 'private-sentinel',
      },
      contexts: {
        operation_diagnostic: { serialized: JSON.stringify(report) },
        os: { name: 'Windows', version: '10.0.26100', hostname: 'private-sentinel' },
        recent_logs: { entries: ['private-sentinel'] },
      },
      exception: {
        values: [
          { value: 'private-sentinel', stacktrace: { frames: [{ filename: 'private-sentinel' }] } },
        ],
      },
      request: { headers: { authorization: 'private-sentinel' } },
      user: { email: 'private-sentinel' },
      breadcrumbs: [{ message: 'private-sentinel' }],
      extra: { private: 'private-sentinel' },
      server_name: 'private-sentinel',
    };
    const projected = projectOperationSentryEvent(event);
    expect(normalize({ operation_diagnostic: { serialized: JSON.stringify(report) } }, 3)).toEqual({
      operation_diagnostic: { serialized: JSON.stringify(report) },
    });
    expect(projected?.contexts).toEqual({
      operation_diagnostic: report,
      os: { name: 'Windows', version: '10.0.26100' },
    });
    expect(JSON.stringify(projected)).not.toContain('private-sentinel');
    expect(projected?.user).toEqual({ geo: {} });
    expect(projected?.fingerprint).not.toContain(diagnosticId);
    expect(projected?.release).toBe('antigravity-manager@0.25.1');
    const second = projectOperationSentryEvent({
      ...event,
      contexts: {
        operation_diagnostic: {
          serialized: JSON.stringify({
            ...report,
            failure: { ...failure, diagnosticId: '22222222-2222-4222-8222-222222222222' },
          }),
        },
      },
    });
    expect(second?.fingerprint).toEqual(projected?.fingerprint);
    expect(
      projectOperationSentryEvent({
        ...event,
        contexts: {
          operation_diagnostic: {
            serialized: JSON.stringify({ ...report, private: 'private-sentinel' }),
          },
        },
      }),
    ).toBeNull();
  });

  it('keeps the largest classified HTTP failure within the public byte budget', () => {
    const cause = {
      reason: 'proxy-configuration-invalid',
      nativeCode: 'DEPTH_ZERO_SELF_SIGNED_CERT',
      upstreamStatus: 599,
      upstreamCode: 'temporarily_unavailable',
      http: {
        route: 'forward-proxy',
        destination: 'non-loopback',
        transport: 'unknown',
        responseFormat: 'empty',
      },
    } satisfies Pick<
      OperationFailure,
      'reason' | 'nativeCode' | 'upstreamStatus' | 'upstreamCode' | 'http'
    >;
    const diagnostic: OperationDiagnostic = {
      schemaVersion: 1,
      diagnosticId,
      operation: 'cloud-account-switch',
      stage: 'management-transport',
      ...cause,
      target: 'classic',
      storage: 'credential-store',
      rollback: 'not-attempted',
      readback: {
        accessToken: false,
        refreshToken: false,
        idToken: false,
        expiry: false,
        projectId: false,
      },
      causes: Array.from({ length: 4 }, () => cause),
      causesTruncated: true,
      reporting: { state: 'not-reported', reason: 'expected-outcome' },
    };
    expect(OperationDiagnosticSchema.parse(diagnostic)).toEqual(diagnostic);
    const output: string[] = [];
    vi.spyOn(winston.transports.Console.prototype, 'log').mockImplementation((info, callback) => {
      output.push(z.object({ message: z.string() }).parse(info).message);
      if (typeof callback === 'function') {
        callback();
      }
    });
    const {
      schemaVersion: _schemaVersion,
      diagnosticId: id,
      operation,
      reporting: _reporting,
      ...failure
    } = diagnostic;
    const terminal = new OperationContext(operation, id).finish(failure, true);
    const record = output.join('\n');
    const serialized = record.match(/Operation diagnostic v1 (\{[^\r\n]+\})/)?.[1];
    expect(serialized).toBeDefined();
    expect(readFinalizedOperationDiagnostic({ diagnostic: JSON.parse(serialized!) })).toEqual(
      terminal,
    );
    expect(sanitizeLogRecord(`Operation diagnostic v1 ${serialized}`)).toEqual({
      text: `Operation diagnostic v1 ${serialized}`,
      removed: false,
    });
  });

  it('rejects arbitrary fields and invalid feature combinations in transports and attachments', () => {
    const valid: OperationDiagnostic = {
      ...loginDiagnostic('login-failed'),
      http: {
        route: 'forward-proxy',
        destination: 'loopback',
        transport: 'plain',
        responseFormat: 'html',
      },
    };
    expect(CloudOperationDiagnosticSchema.safeParse({ ...valid, target: 'classic' }).success).toBe(
      false,
    );
    expect(
      CloudOperationDiagnosticSchema.safeParse({ ...valid, nativeCode: 'private-sentinel' })
        .success,
    ).toBe(false);
    expect(
      CloudOperationDiagnosticSchema.safeParse({ ...valid, stage: 'process-close' }).success,
    ).toBe(false);
    expect(
      CloudOperationDiagnosticSchema.safeParse({
        ...valid,
        reporting: { state: 'captured', eventId: 'private' },
      }).success,
    ).toBe(false);
    const record = `Operation diagnostic v1 ${JSON.stringify(valid)}`;
    const sanitized = sanitizeLogRecord(record);
    expect(sanitized.removed).toBe(false);
    expect(JSON.parse(sanitized.text.slice('Operation diagnostic v1 '.length))).toEqual(valid);
    for (const message of [
      `private-sentinel ${record}`,
      `Operation diagnostic v1 ${JSON.stringify({ ...valid, http: { ...valid.http, address: 'private-sentinel' } })}`,
      `Operation diagnostic v1 ${JSON.stringify({ ...valid, secret: 'private-sentinel' })}`,
      record + '\nprivate-sentinel',
    ]) {
      expect(sanitizeLogRecord(message)).toEqual({ text: '[Content removed]', removed: true });
    }
  });
});

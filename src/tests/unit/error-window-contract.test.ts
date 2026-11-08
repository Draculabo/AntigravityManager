import { expect, it } from 'vitest';
import { resolveErrorWindowBudget } from '@/modules/error-diagnostics/error-budget';
import { ErrorWindowBudgetSchema } from '@/modules/error-diagnostics/error-budget';
import { ErrorDiagnosticsConfigSchema } from '@/modules/error-diagnostics/error-settings';
import {
  decodeErrorRecord,
  encodeErrorRecord,
  MAX_ERROR_RECORD_BYTES,
} from '@/modules/error-diagnostics/error-record';
import { createDiagnosticErrorRecord } from '@/shared/observability/errorDiagnostic';

it('allocates one deployment window instead of one full budget to each process', () => {
  expect(resolveErrorWindowBudget(0)).toEqual({
    totalBytes: 500 * 1024 * 1024,
    appBytes: 250 * 1024 * 1024,
    coreBytes: 250 * 1024 * 1024,
    effectiveMiB: 500,
    source: 'default',
    ignoredEnvironmentOverride: false,
  });
  expect(resolveErrorWindowBudget(1, '2')).toEqual({
    totalBytes: 2 * 1024 * 1024,
    appBytes: 1024 * 1024,
    coreBytes: 1024 * 1024,
    effectiveMiB: 2,
    source: 'environment',
    ignoredEnvironmentOverride: false,
  });
});

it('owns the capacity boundary, zero-to-default policy and one combined allocation contract', () => {
  expect(ErrorDiagnosticsConfigSchema.parse({})).toEqual({ max_storage_mib: 500 });
  expect(
    resolveErrorWindowBudget(
      ErrorDiagnosticsConfigSchema.parse({ max_storage_mib: 0 }).max_storage_mib,
    ).effectiveMiB,
  ).toBe(500);
  expect(ErrorDiagnosticsConfigSchema.safeParse({ max_storage_mib: 10_241 }).success).toBe(false);
  expect(ErrorDiagnosticsConfigSchema.safeParse({ max_storage_mib: 0.5 }).success).toBe(false);
  const valid = resolveErrorWindowBudget(500);
  expect(ErrorWindowBudgetSchema.parse(valid)).toEqual(valid);
  expect(ErrorWindowBudgetSchema.safeParse({ ...valid, appBytes: valid.totalBytes }).success).toBe(
    false,
  );
});

it.each(['0', '-1', '2.5', '10241', '1e3', ' 2', '9007199254740993', ''])(
  'reports an invalid environment allocation without using it: %j',
  (override) => {
    const budget = resolveErrorWindowBudget(200, override);
    expect(budget.effectiveMiB).toBe(200);
    expect(budget.appBytes + budget.coreBytes).toBe(budget.totalBytes);
    expect(budget.source).toBe('configuration');
    expect(budget.ignoredEnvironmentOverride).toBe(true);
  },
);

it('stores every sanitized stack frame and cause without duplicating stack chunks', () => {
  const cause = new Error('upstream Bearer fixture-secret');
  cause.stack = 'Error: upstream Bearer fixture-secret\n    at inner (file.ts:3:4)';
  const error = new Error('failure', { cause });
  error.stack = 'Error: failure\n' + '    at 帧 (file.ts:1:2)\n'.repeat(5000);
  const record = createDiagnosticErrorRecord({
    error,
    role: 'core',
    source: 'logger',
    category: 'error',
  });
  const encoded = encodeErrorRecord(record);
  expect(encoded.accepted).toBe(true);
  if (!encoded.accepted) {
    throw new Error('Expected a complete encoded diagnostic');
  }
  const stored = decodeErrorRecord(encoded.body);
  const { stackChunks: _chunks, ...expected } = record;
  expect(stored).toEqual(expected);
  expect(encoded.bytes).toBe(Buffer.byteLength(encoded.body, 'utf8'));
  expect(encoded.body).not.toContain('fixture-secret');
  expect(encoded.body).not.toContain('stackChunks');
});

it('rejects an oversized complete diagnostic rather than silently shortening it', () => {
  const record = createDiagnosticErrorRecord({
    error: new Error('failure'),
    role: 'core',
    source: 'logger',
    category: 'error',
  });
  record.stack = '帧'.repeat(MAX_ERROR_RECORD_BYTES / 2);
  expect(encodeErrorRecord(record)).toEqual({ accepted: false, reason: 'record_too_large' });
});

it('refuses malformed or unknown durable records without disclosing parser input', () => {
  expect(() => decodeErrorRecord('{private-body-fixture')).toThrow(
    'Local error diagnostic is invalid',
  );
  const record = createDiagnosticErrorRecord({
    error: 'failure',
    role: 'core',
    source: 'logger',
    category: 'error',
  });
  const encoded = encodeErrorRecord(record);
  if (!encoded.accepted) {
    throw new Error('Expected encoded fixture');
  }
  expect(() => decodeErrorRecord(encoded.body.replace('"version":1', '"version":2'))).toThrow(
    'Local error diagnostic is invalid',
  );
});

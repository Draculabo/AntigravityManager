import { afterEach, expect, it, vi } from 'vitest';
import { logger } from '@/shared/logging/logger';

const dispose: Array<() => void> = [];
afterEach(() => {
  for (const unregister of dispose.splice(0)) {
    unregister();
  }
  logger.setErrorReportingEnabled(false);
  logger.setSentryReporter(null);
  vi.restoreAllMocks();
});

it('captures error diagnostics without admitting normal refresh logs or arbitrary arguments', () => {
  const sink = vi.fn();
  dispose.push(logger.setLocalErrorSink(sink));
  const error = new Error('original failure');
  logger.info('refresh', { privateBody: 'never-forward-body' });
  logger.warn('warning');
  logger.debug('debug');
  logger.error('generation failed', { privateBody: 'never-forward-body' }, error);
  expect(sink.mock.calls).toEqual([[{ message: 'generation failed', error }]]);
});

it('keeps replacement registration when an old owner disposes', () => {
  const old = vi.fn();
  const current = vi.fn();
  const unregisterOld = logger.setLocalErrorSink(old);
  dispose.push(logger.setLocalErrorSink(current));
  unregisterOld();
  logger.diagnosticError('current failure');
  expect(old).not.toHaveBeenCalled();
  expect(current.mock.calls).toEqual([[{ message: 'current failure', error: undefined }]]);
});

it('contains a throwing sink while preserving the existing single Sentry submission', () => {
  const sentry = vi.fn();
  logger.setErrorReportingEnabled(true);
  logger.setSentryReporter(sentry);
  const before = logger.getLocalErrorSinkFailures();
  const sink = vi.fn(() => {
    throw new Error('sink failure must not replace original');
  });
  dispose.push(logger.setLocalErrorSink(sink));
  expect(() => logger.error('original business error', new Error('original'))).not.toThrow();
  expect(sink).toHaveBeenCalledOnce();
  expect(logger.getLocalErrorSinkFailures()).toBe(before + 1);
  expect(sentry).toHaveBeenCalledOnce();
});

it('bounds recursive sink failures without re-entering the local sink', () => {
  const before = logger.getLocalErrorSinkFailures();
  const sink = vi.fn(() => logger.error('nested diagnostic failure'));
  dispose.push(logger.setLocalErrorSink(sink));
  logger.error('original error');
  expect(sink).toHaveBeenCalledOnce();
  expect(logger.getLocalErrorSinkFailures()).toBe(before + 1);
});

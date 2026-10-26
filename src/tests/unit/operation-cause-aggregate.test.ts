import { describe, expect, it } from 'vitest';
import { classifyOperationCause } from '@/modules/cloud-account/services/operation-cause';
import { processError } from '@/modules/antigravity-runtime/processErrors';

describe('compound operation failure diagnostics', () => {
  it('prioritizes observed Windows evidence while retaining aggregate recovery failures', () => {
    const process = processError('window-close-failed', undefined, 5);
    const recovery = Object.assign(new Error('Synthetic recovery failure'), { code: 'EIO' });
    const result = classifyOperationCause(
      new AggregateError(
        [processError('close-failed', process), recovery],
        'Synthetic compound failure',
      ),
    );
    expect(result).toEqual({
      primary: {
        reason: 'permission-denied',
        nativeCode: 'ANTIGRAVITY_PROCESS_FAILED',
        process: { reason: 'window-close-failed', windowsErrorCode: 5 },
      },
      causes: [
        { reason: 'unknown' },
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
        { reason: 'storage-failed', nativeCode: 'EIO' },
      ],
      causesTruncated: false,
    });
  });

  it('retains the primary failure and failed recovery without private text', () => {
    const primary = Object.assign(new Error('access_token=private fixture'), { code: 'EACCES' });
    const recovery = Object.assign(new Error('private recovery path'), { code: 'EIO' });
    const result = classifyOperationCause(
      new AggregateError([primary, recovery], 'Recovery failed'),
    );
    expect(result).toEqual({
      primary: { reason: 'permission-denied', nativeCode: 'EACCES' },
      causes: [
        { reason: 'unknown' },
        { reason: 'permission-denied', nativeCode: 'EACCES' },
        { reason: 'storage-failed', nativeCode: 'EIO' },
      ],
      causesTruncated: false,
    });
    expect(JSON.stringify(result)).not.toMatch(/private|access_token/);
  });

  it('bounds aggregate siblings while keeping the first causal branch first', () => {
    const primary = new Error('primary', {
      cause: Object.assign(new Error('native cause'), { code: 'ENOSPC' }),
    });
    const result = classifyOperationCause(
      new AggregateError([primary, new Error('recovery'), new Error('extra')]),
    );
    expect(result).toEqual({
      primary: { reason: 'storage-failed', nativeCode: 'ENOSPC' },
      causes: [
        { reason: 'unknown' },
        { reason: 'unknown' },
        { reason: 'storage-failed', nativeCode: 'ENOSPC' },
        { reason: 'unknown' },
      ],
      causesTruncated: true,
    });
  });
  it('bounds cyclic aggregate children and still inspects a recovery sibling', () => {
    const aggregate = new AggregateError([], 'Synthetic cycle');
    aggregate.errors.push(aggregate, Object.assign(new Error('Recovery'), { code: 'EIO' }));
    expect(classifyOperationCause(aggregate)).toEqual({
      primary: { reason: 'storage-failed', nativeCode: 'EIO' },
      causes: [{ reason: 'unknown' }, { reason: 'storage-failed', nativeCode: 'EIO' }],
      causesTruncated: true,
    });
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
const captured = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock('@/modules/error-diagnostics/public', () => ({ errorProcessOwner: captured }));
import { trafficAuditService } from '@/modules/proxy-gateway/audit/traffic-audit.service';
import { UpstreamRequestError } from '@/server/gateway/common/exceptions/upstream-request.exception';
import {
  completeCurrentUpstreamAttempt,
  runWithTrafficAuditRequestContext,
  startCurrentUpstreamAttempt,
} from '@/modules/proxy-gateway/audit/traffic-audit-context';

afterEach(() => {
  vi.restoreAllMocks();
  captured.capture.mockReset();
});

describe('Independent physical upstream failure diagnostics', () => {
  it('captures a recovered attempt error exactly once with no audit admission or retained request payload', () => {
    vi.spyOn(trafficAuditService, 'startAttempt').mockReturnValue(null);
    const completed = vi
      .spyOn(trafficAuditService, 'completeAttempt')
      .mockImplementation(() => undefined);
    const context = {
      attemptSequence: 0,
      parent: null,
      thoughtSessionKey: 'synthetic',
      thoughtSessionStable: true,
    };
    const error = Object.assign(
      new Error('controlled timeout', { cause: new Error('socket closed') }),
      { code: 'ETIMEDOUT' },
    );
    runWithTrafficAuditRequestContext(context, () => {
      const attempt = startCurrentUpstreamAttempt({
        endpoint: 'https://example.test?private=value',
        operation: 'generate-content',
        requestBody: { secret: 'never-forward-fixture' },
        headers: { Authorization: 'Bearer never-forward-fixture' },
      });
      completeCurrentUpstreamAttempt(attempt, { error, status: 504, outcome: 'upstream_error' });
      completeCurrentUpstreamAttempt(attempt, { error, status: 504, outcome: 'upstream_error' });
      const recovery = startCurrentUpstreamAttempt({
        endpoint: 'https://example.test',
        operation: 'generate-content',
      });
      completeCurrentUpstreamAttempt(recovery, { status: 200, outcome: 'completed' });
    });
    expect(captured.capture).toHaveBeenCalledOnce();
    expect(captured.capture.mock.calls[0][0]).toEqual({
      error,
      source: 'proxy-gateway',
      module: 'google-transport',
      functionName: 'generate-content',
      stage: 'upstream-attempt',
      protocol: 'google',
      category: 'timeout',
      status: 504,
      requestId: undefined,
      attemptId: expect.stringMatching(/^[a-f0-9-]{36}$/u),
    });
    expect(JSON.stringify(captured.capture.mock.calls)).not.toContain('never-forward-fixture');
    expect(context).toMatchObject({ attemptSequence: 2, failedAttemptCount: 1 });
    expect(completed).toHaveBeenCalledTimes(2);
  });

  it('does not classify success, unfinished sends or client cancellation as error-window failures', () => {
    for (const outcome of [
      'completed',
      'in_progress',
      'client_cancelled',
      'client_disconnected',
    ] as const) {
      const attempt = startCurrentUpstreamAttempt({
        endpoint: 'https://example.test',
        operation: 'count-tokens',
      });
      completeCurrentUpstreamAttempt(attempt, { outcome, status: 200 });
    }
    const attempt = startCurrentUpstreamAttempt({
      endpoint: 'https://example.test',
      operation: 'count-tokens',
    });
    completeCurrentUpstreamAttempt(attempt, {
      outcome: 'upstream_error',
      error: new DOMException('cancelled', 'AbortError'),
    });
    expect(captured.capture).not.toHaveBeenCalled();
  });

  it('contains diagnostic failures while completing the original audit operation', () => {
    captured.capture.mockImplementation(() => {
      throw new Error('controlled unavailable sink');
    });
    const completed = vi
      .spyOn(trafficAuditService, 'completeAttempt')
      .mockImplementation(() => undefined);
    const attempt = startCurrentUpstreamAttempt({
      endpoint: 'https://example.test',
      operation: 'generate-content',
    });
    expect(() =>
      completeCurrentUpstreamAttempt(attempt, {
        outcome: 'upstream_error',
        error: new Error('original failure'),
        status: 503,
      }),
    ).not.toThrow();
    expect(captured.capture).toHaveBeenCalledOnce();
    expect(completed).toHaveBeenCalledOnce();
  });

  it('keeps structured authorization failure despite cancellation wording', () => {
    const attempt = startCurrentUpstreamAttempt({
      endpoint: 'https://example.test',
      operation: 'generate-content',
    });
    completeCurrentUpstreamAttempt(attempt, {
      outcome: 'auth_failed',
      status: 403,
      error: new UpstreamRequestError({ message: 'The account access was cancelled', status: 403 }),
    });
    expect(captured.capture).toHaveBeenCalledOnce();
    expect(captured.capture.mock.calls[0][0]).toMatchObject({
      category: 'authorization_failure',
      status: 403,
    });
  });
});

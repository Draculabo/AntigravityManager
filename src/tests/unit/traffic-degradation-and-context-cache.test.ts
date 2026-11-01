import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveHttpOutcome } from '@/modules/proxy-gateway/audit/traffic-audit-http-metadata';
import { buildProxyResponseTimingHeaders } from '@/modules/proxy-gateway/server/common/proxy-response-timing';
import { runWithTrafficAuditRequestContext } from '@/modules/proxy-gateway/audit/traffic-audit-context';
import { TrafficDetailDialog } from '@/modules/proxy-gateway/traffic-monitor/TrafficDetailDialog';
import { ProxyConfigSchema } from '@/modules/config/types';
import { TrafficAuditSummarySchema } from '@/modules/proxy-gateway/audit/traffic-audit.types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'traffic.recovered-badge' && options?.count) {
        return `Recovered (${options.count} attempts)`;
      }
      if (key === 'traffic.fallback-attempt-recovered') {
        return `Recovered on Attempt ${options?.index} ${options?.operation}${options?.status}`;
      }
      return typeof options?.defaultValue === 'string' ? options.defaultValue : key;
    },
  }),
}));

let currentRequestDetail: Record<string, unknown> = {};
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});

function renderAttempts(
  attempts: Array<{
    id: string;
    attemptIndex: number;
    operation: string;
    outcome: string;
    status: number;
    error: string | null;
  }>,
) {
  currentRequestDetail = {
    recordKind: 'request',
    request: { id: 'request', outcome: 'completed', trafficClass: 'model', status: 200 },
    attempts,
    bodies: [],
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(TrafficDetailDialog, {
        id: 'request',
        includeCredentials: false,
        onCopyCurl: vi.fn(),
        onOpenChange: vi.fn(),
      }),
    ),
  );
}

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQuery: (options: { queryKey?: unknown[] }) => {
      const key = options?.queryKey;
      if (Array.isArray(key) && key[0] === 'gateway' && key[1] === 'traffic-detail') {
        return {
          data: currentRequestDetail,
          isLoading: false,
          isError: false,
        };
      }
      return {
        data: undefined,
        isLoading: false,
        isError: false,
      };
    },
  };
});

describe('Traffic degradation & Context Cache Error Handling', () => {
  it('classifies 403 with SERVICE_DISABLED as upstream_error instead of auth_failed', () => {
    const serviceDisabledPayload = {
      error: {
        code: 403,
        message:
          'Agent Platform API has not been used in project aicode-consumers before or it is disabled.',
        status: 'PERMISSION_DENIED',
        details: [{ reason: 'SERVICE_DISABLED', domain: 'googleapis.com' }],
      },
    };

    const outcome = resolveHttpOutcome(403, serviceDisabledPayload);
    expect(outcome).toBe('upstream_error');

    const pureAuthError = resolveHttpOutcome(403, { error: { message: 'Invalid credentials' } });
    expect(pureAuthError).toBe('auth_failed');
  });

  it('adds x-antigravity-attempts and x-antigravity-fallback headers when attemptSequence > 1', () => {
    const context = {
      attemptSequence: 2,
      failedAttemptCount: 1,
      clientSessionId: 'sess-123',
      currentAccountId: 'acc-1',
      currentAccountEmail: 'test@example.com',
      parent: null,
      thoughtSessionKey: 'thought-1',
      thoughtSessionStable: true,
      proxyTiming: {
        startedAt: 1000,
        cleanMs: 1.0,
        normalizationStartedAt: null,
        normMs: 2.0,
        thinkingMs: 0,
        upstreamStartedAt: null,
        ttftMs: 50.0,
      },
    };

    const headers = runWithTrafficAuditRequestContext(context, () =>
      buildProxyResponseTimingHeaders(),
    );

    expect(headers['x-antigravity-attempts']).toBe('2');
    expect(headers['x-antigravity-fallback']).toBe('true');
    expect(headers['x-antigravity-account-id']).toBe('acc-1');
  });

  it('does not emit a fallback header for two successful upstream operations', () => {
    const headers = runWithTrafficAuditRequestContext(
      {
        attemptSequence: 2,
        parent: null,
        thoughtSessionKey: 'session',
        thoughtSessionStable: true,
      },
      () => buildProxyResponseTimingHeaders(),
    );
    expect(headers['x-antigravity-fallback']).toBeUndefined();
  });

  it('renders recovered badge when a completed request required failover attempts', () => {
    currentRequestDetail = {
      recordKind: 'request',
      request: {
        id: '5eb01787-b574-4e7c-b353-879576258b03',
        outcome: 'completed',
        trafficClass: 'model',
        method: 'POST',
        url: '/v1/chat/completions',
        protocol: 'openai',
        model: 'gemini-3.8-flash-tiered',
        mappedModel: 'gemini-3.8-flash-tiered',
        timestamp: Date.now(),
        attributedAccountId: 'acc-1',
        status: 200,
        durationMs: 23256,
        inputTokens: 24084,
        outputTokens: 867,
      },
      attempts: [
        {
          id: 'att-1',
          attemptIndex: 1,
          operation: 'create-context-cache',
          endpoint: 'https://us-central1-aiplatform.googleapis.com/...',
          outcome: 'upstream_error',
          status: 403,
          durationMs: 1109,
          error: '{"message":"SERVICE_DISABLED"}',
        },
        {
          id: 'att-2',
          attemptIndex: 2,
          operation: 'streamGenerateContent',
          endpoint: 'https://daily-cloudcode-pa.googleapis.com/...',
          outcome: 'completed',
          status: 200,
          durationMs: 22115,
        },
      ],
      bodies: [],
    };

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    clients.push(queryClient);

    render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(TrafficDetailDialog, {
          id: '5eb01787-b574-4e7c-b353-879576258b03',
          includeCredentials: false,
          onCopyCurl: vi.fn(),
          onOpenChange: vi.fn(),
        }),
      ),
    );

    expect(screen.getByText('Recovered (2 attempts)')).toBeTruthy();
  });

  it('does not call successful cache creation followed by successful generation a recovery', () => {
    renderAttempts([
      {
        id: 'cache',
        attemptIndex: 1,
        operation: 'create-context-cache',
        outcome: 'completed',
        status: 200,
        error: null,
      },
      {
        id: 'generation',
        attemptIndex: 2,
        operation: 'generate',
        outcome: 'completed',
        status: 200,
        error: null,
      },
    ]);
    expect(screen.queryByText('Recovered (2 attempts)')).toBeNull();
    expect(screen.queryByText('traffic.fallback-diagnostics')).toBeNull();
  });

  it('names the successful generation after failure rather than the earlier cache creation', () => {
    renderAttempts([
      {
        id: 'cache',
        attemptIndex: 1,
        operation: 'create-context-cache',
        outcome: 'completed',
        status: 200,
        error: null,
      },
      {
        id: 'failed',
        attemptIndex: 2,
        operation: 'generate',
        outcome: 'upstream_error',
        status: 404,
        error: 'cachedContent not found',
      },
      {
        id: 'recovered',
        attemptIndex: 3,
        operation: 'generate',
        outcome: 'completed',
        status: 200,
        error: null,
      },
    ]);
    expect(screen.getAllByText(/Recovered on Attempt 3/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Recovered on Attempt 1/)).toBeNull();
  });

  it('defaults context_cache_enabled to true in ProxyConfigSchema', () => {
    const parsed = ProxyConfigSchema.parse({
      api_key: 'test-key',
      auto_start: false,
      enabled: true,
      port: 8080,
      anthropic_mapping: {},
      upstream_proxy: { enabled: false, url: '' },
    });
    expect(parsed.experimental.context_cache_enabled).toBe(true);
  });

  it('validates attemptCount field in TrafficAuditSummarySchema', () => {
    const summary = TrafficAuditSummarySchema.parse({
      attemptCount: 3,
      attributedAccountId: 'acc-1',
      completedAt: 1000,
      durationMs: 500,
      hasImageOutput: false,
      hasTextOutput: true,
      id: 'req-1',
      inputTokens: 100,
      mappedModel: 'gemini-3.8-flash-tiered',
      method: 'POST',
      model: 'gemini-3.8-flash-tiered',
      outcome: 'completed',
      outputTokens: 50,
      physicalModel: 'gemini-3.8-flash-tiered',
      physicalModelFamily: 'gemini-3.8-flash',
      protocol: 'openai',
      recordKind: 'request',
      status: 200,
      timestamp: 1000,
      trafficClass: 'model',
      url: '/v1/chat/completions',
    });
    expect(summary.attemptCount).toBe(3);
  });
});

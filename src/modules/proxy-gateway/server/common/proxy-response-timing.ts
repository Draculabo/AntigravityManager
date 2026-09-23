import type { FastifyReply, FastifyRequest } from 'fastify';

import {
  getProxyResponseTimingContext,
  type ProxyResponseTimingState,
} from '@/modules/proxy-gateway/audit/traffic-audit-context';

function elapsedSince(startedAt: number): number {
  return Math.max(0, performance.now() - startedAt);
}

export function markProxyCleanComplete(): void {
  const timing = getProxyResponseTimingContext()?.proxyTiming;
  if (timing && timing.cleanMs === null) {
    timing.cleanMs = elapsedSince(timing.startedAt);
  }
}

export function markProxyNormalizationStarted(): void {
  const timing = getProxyResponseTimingContext()?.proxyTiming;
  if (timing) {
    timing.normalizationStartedAt = performance.now();
    timing.normMs = null;
  }
}

export function markProxyNormalizationComplete(): void {
  const timing = getProxyResponseTimingContext()?.proxyTiming;
  if (timing?.normalizationStartedAt !== null && timing?.normalizationStartedAt !== undefined) {
    timing.normMs = elapsedSince(timing.normalizationStartedAt);
    timing.normalizationStartedAt = null;
  }
}

export function recordProxyThinkingFill(startedAt: number): void {
  const timing = getProxyResponseTimingContext()?.proxyTiming;
  if (timing) {
    timing.thinkingMs = elapsedSince(startedAt);
  }
}

export function markProxyUpstreamStarted(): void {
  const timing = getProxyResponseTimingContext()?.proxyTiming;
  if (timing) {
    timing.upstreamStartedAt = performance.now();
    timing.ttftMs = null;
  }
}

export function markProxyUpstreamFirstByte(
  timing = getProxyResponseTimingContext()?.proxyTiming,
): void {
  if (timing?.upstreamStartedAt !== null && timing?.upstreamStartedAt !== undefined) {
    timing.ttftMs ??= elapsedSince(timing.upstreamStartedAt);
  }
}

export function buildProxyResponseTimingHeaders(request?: FastifyRequest): Record<string, string> {
  const context = getProxyResponseTimingContext(request);
  if (!context?.proxyTiming || !context.clientSessionId) {
    return {};
  }
  const timing = context.proxyTiming;
  const milliseconds = (value: number | null): string => Math.max(0, value ?? 0).toFixed(3);
  return {
    'X-Session-Id': context.clientSessionId,
    'X-Antigravity-Session-Id': context.clientSessionId,
    'X-Timing-Clean-Ms': milliseconds(timing.cleanMs),
    'X-Timing-Norm-Ms': milliseconds(timing.normMs),
    'X-Timing-Thinking-Ms': milliseconds(timing.thinkingMs),
    'X-Timing-Ttft-Ms': milliseconds(timing.ttftMs),
  };
}

export function setProxyResponseTimingHeaders(reply: FastifyReply, request?: FastifyRequest): void {
  for (const [name, value] of Object.entries(buildProxyResponseTimingHeaders(request))) {
    reply.header(name, value);
  }
}

export function getCurrentProxyTimingState(): ProxyResponseTimingState | undefined {
  return getProxyResponseTimingContext()?.proxyTiming;
}

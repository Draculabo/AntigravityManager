import type { FastifyRequest } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { auditJsonObject } from './audit-json-object';
import { resolveClientSessionHint } from '../../../server/gateway/common/client-session-hint';
import { tenantIdentity } from '../../../server/gateway/common/signature-session-scope';
import type { RequestHeaders } from '../../../server/gateway/guards/api-key-auth.util';

export function resolveThoughtSession(
  request: Pick<FastifyRequest, 'headers' | 'url' | 'body'>,
  fallbackClientId?: string,
): { clientId: string; key: string; stable: boolean } {
  const headers = request.headers;
  const stableId = resolveStableSessionId(request);
  const clientId = stableId ?? fallbackClientId ?? `request-${randomUUID()}`;
  return {
    clientId,
    key: createThoughtSessionKey(headers, clientId),
    stable: Boolean(stableId),
  };
}

export function createThoughtSessionKey(headers: RequestHeaders, sessionId: string): string {
  return `thought:client:v2:${createHash('sha256')
    .update(JSON.stringify([tenantIdentity(headers), sessionId.trim()]))
    .digest('hex')}`;
}

export function resolveStableSessionId(
  request: Pick<FastifyRequest, 'headers' | 'url' | 'body'>,
): string | null {
  const body = auditJsonObject(request.body);
  return (
    resolveClientSessionHint(
      request.headers,
      request.url,
      body ?? undefined,
      auditJsonObject(body?.metadata) ?? undefined,
    ).id ?? null
  );
}

export function inferProtocol(url: string): string {
  if (url.startsWith('/v1/messages') || url.startsWith('/v1/complete')) {
    return 'anthropic';
  }
  if (url.startsWith('/v1/responses') || url.split('?')[0] === '/responses') {
    return 'openai-responses';
  }
  if (url.startsWith('/v1/')) {
    return 'openai';
  }
  if (url.startsWith('/v1beta/') || url.startsWith('/upload/v1beta/')) {
    return 'gemini';
  }
  if (url.startsWith('/internal/') || url.startsWith('/health')) {
    return 'admin-http';
  }
  return 'compatible';
}

export function isAuditManagementRoute(url: string): boolean {
  return (
    url.startsWith('/internal/audit') ||
    url.startsWith('/internal/thinking') ||
    url.startsWith('/v1/thinking/')
  );
}

export function firstHeader(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }
  return null;
}

export function resolveHttpOutcome(status: number, error: unknown) {
  if (status === 401) {
    return 'auth_failed' as const;
  }
  if (status === 403) {
    const errorString =
      error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : JSON.stringify(error ?? '');
    if (
      errorString.includes('SERVICE_DISABLED') ||
      errorString.includes('has not been used in project') ||
      errorString.includes('is disabled')
    ) {
      return 'upstream_error' as const;
    }
    return 'auth_failed' as const;
  }
  if (status === 408 || (error instanceof Error && /timeout/iu.test(error.message))) {
    return 'timeout' as const;
  }
  if (status === 499) {
    return 'client_cancelled' as const;
  }
  if (status >= 500) {
    return 'internal_error' as const;
  }
  return 'completed' as const;
}

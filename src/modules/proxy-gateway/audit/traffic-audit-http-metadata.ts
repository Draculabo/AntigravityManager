import type { FastifyRequest } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { auditJsonObject } from './audit-json-object';

export function resolveThoughtSession(
  request: FastifyRequest,
  fallbackClientId?: string,
): { clientId: string; key: string; stable: boolean } {
  const headers = request.headers;
  const stableId = resolveStableSessionId(request);
  const clientId = sanitizeSessionId(stableId ?? fallbackClientId ?? `request-${randomUUID()}`);
  return {
    clientId,
    key: createThoughtSessionKey(headers, clientId),
    stable: Boolean(stableId),
  };
}

export function createThoughtSessionKey(
  headers: Record<string, unknown>,
  sessionId: string,
): string {
  const credential =
    firstHeader(headers.authorization) ??
    firstHeader(headers['x-api-key']) ??
    firstHeader(headers['x-goog-api-key']) ??
    'anonymous';
  const tenantHash = createHash('sha256').update(credential, 'utf-8').digest('hex');
  return `${tenantHash}:${sanitizeSessionId(sessionId)}`;
}

export function resolveStableSessionId(request: FastifyRequest): string | null {
  const query = auditJsonObject(request.query);
  const headers = request.headers;
  const body = request.body;
  return (
    readString(query, ['session_id', 'sessionId', 'conversation_id', 'conversationId']) ??
    readString(headers, [
      'x-session-id',
      'session-id',
      'x-conversation-id',
      'conversation-id',
      'openai-conversation-id',
    ]) ??
    readString(body, [
      'session_id',
      'sessionId',
      'conversation_id',
      'conversationId',
      'previous_response_id',
    ]) ??
    readNestedMetadataString(body)
  );
}

function readNestedMetadataString(value: unknown): string | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const metadata = Reflect.get(value, 'metadata');
  return readString(metadata, ['session_id', 'sessionId', 'user_id', 'userId']);
}

function readString(value: unknown, keys: string[]): string | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  for (const key of keys) {
    const candidate = Reflect.get(value, key);
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function sanitizeSessionId(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_.:-]/gu, '_').slice(0, 128);
  return sanitized || `request-${randomUUID()}`;
}

export function inferProtocol(url: string): string {
  if (url.startsWith('/v1/messages') || url.startsWith('/v1/complete')) {
    return 'anthropic';
  }
  if (url.startsWith('/v1/responses')) {
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
  if (status === 401 || status === 403) {
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

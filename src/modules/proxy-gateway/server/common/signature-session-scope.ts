import { createHash } from 'node:crypto';
import type {
  AnthropicChatRequest,
  OpenAIChatRequest,
  GeminiRequest,
} from './interfaces/request-interfaces';
import { extractApiKeyToken, type RequestHeaders } from '../guards/api-key-auth.util';
import { resolveClientSessionHint, type SessionHintDiagnostics } from './client-session-hint';
import {
  openAISessionAnchor,
  anthropicSessionAnchor,
  geminiSessionAnchor,
  type SessionInitialTaskIdentity,
} from './protocol-session-anchor';

export interface SignatureScopeContext {
  headers: RequestHeaders;
  url?: string;
}

export interface SignatureSessionScope {
  storeKey: string;
  cacheKey: string;
  affinityKey: string;
  auditKey: string;
  hint: SessionHintDiagnostics;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Canonical one-way caller identity shared by scoped caches and history ownership. */
export function tenantIdentity(headers: RequestHeaders): string {
  return credentialIdentity(extractApiKeyToken(headers));
}

function credentialIdentity(credential: string | null): string {
  return digest(JSON.stringify(credential === null ? ['anonymous'] : ['credential', credential]));
}

function accountAffinity(tenant: string, id: string): string {
  return `session:affinity:v1:${digest(JSON.stringify([tenant, id]))}`;
}

/** A restored lineage is an account hint, never proof of permission to read that lineage. */
export function resolveLineageAccountAffinity(
  lineageId: string,
  headers: RequestHeaders = {},
): string | undefined {
  const hint = resolveClientSessionHint({}, undefined, { session_id: lineageId });
  return hint.id ? accountAffinity(tenantIdentity(headers), hint.id) : undefined;
}

function scope(
  protocol: 'openai' | 'anthropic' | 'gemini',
  anchor: string,
  sessionId: string | undefined,
  headers: RequestHeaders,
  hint: SessionHintDiagnostics,
): SignatureSessionScope {
  // Retain only digests. Credentials and conversation contents never enter cache keys or logs.
  const credential = extractApiKeyToken(headers);
  const tenant = credentialIdentity(credential);
  const storeKey = `session:store:v2:${digest(JSON.stringify([tenant, sessionId ?? null, anchor]))}`;
  const auditKey = sessionId ? accountAffinity(tenant, sessionId) : storeKey;
  const root =
    sessionId && credential !== null && hint.source === 'header' && hint.field === 'x-session-id'
      ? /^([A-Za-z0-9_-]+):step:[0-9]+$/.exec(sessionId)?.[1]
      : undefined;
  return {
    storeKey,
    cacheKey: `${protocol}:scope:v5:${digest(storeKey)}`,
    affinityKey: root ? accountAffinity(tenant, root) : auditKey,
    auditKey,
    hint,
  };
}

/** Stable across appended turns; a reused client ID cannot erase the conversation anchor. */
export function resolveOpenAISessionScope(
  request: OpenAIChatRequest,
  headers: RequestHeaders = {},
  url?: string,
): SignatureSessionScope {
  const anchor = openAISessionAnchor(request);
  const hint = resolveClientSessionHint(headers, url, request, request.extra);
  return scope('openai', anchor, hint.id, headers, hint.diagnostics);
}

/** The prepared routing root carries the winning hint across omitted-header continuations. */
export function resolveResponsesSessionScope(
  request: OpenAIChatRequest,
  routingRoot: string,
  headers: RequestHeaders = {},
  url?: string,
  identity?: SessionInitialTaskIdentity,
): SignatureSessionScope {
  const hint = resolveClientSessionHint(headers, url, request, request.extra);
  const restored =
    identity?.origin === 'client'
      ? resolveClientSessionHint({}, undefined, { session_id: routingRoot })
      : null;
  const sessionId = identity ? restored?.id : hint.id;
  return scope(
    'openai',
    openAISessionAnchor(request, identity?.initialTaskFingerprint),
    sessionId,
    headers,
    restored?.id ? { source: 'restored-lineage', invalidCandidates: 0 } : hint.diagnostics,
  );
}

/** Tool results do not become a new first-user anchor during a tool continuation. */
export function resolveAnthropicSessionScope(
  request: AnthropicChatRequest,
  headers: RequestHeaders = {},
  url?: string,
): SignatureSessionScope {
  const anchor = anthropicSessionAnchor(request);
  const hint = resolveClientSessionHint(headers, url, request, request.metadata);
  return scope('anthropic', anchor, hint.id, headers, hint.diagnostics);
}

export function resolveGeminiSessionScope(
  request: GeminiRequest,
  headers: RequestHeaders = {},
  url?: string,
): SignatureSessionScope {
  const hint = resolveClientSessionHint(headers, url, request);
  return scope('gemini', geminiSessionAnchor(request), hint.id, headers, hint.diagnostics);
}

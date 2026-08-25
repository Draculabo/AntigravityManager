import type { RequestHeaders } from '../guards/api-key-auth.util';

/**
 * The answer an auth rejection owes a caller, in the shape that caller's SDK reads.
 *
 * Without this the framework's own body reaches the client:
 * `{"message":"API key validation failed","error":"Unauthorized","statusCode":401}`.
 * The `openai` SDK reads `error.type` and `error.code`, `@anthropic-ai/sdk` expects
 * `{"type":"error", ...}` and `@google/genai` expects `{"error":{"code","message",
 * "status"}}` -- none of them can read that body, so a mistyped key, the first error
 * anyone hits, comes back unreadable.
 *
 * The guard rejects before routing, so a per-surface exception filter never sees the
 * request and the surface has to be resolved from the path here.
 */
export type ProxySurface = 'openai' | 'anthropic' | 'gemini';

/** Gemini owns `/v1beta`; the upload variant carries the same surface. */
const GEMINI_PREFIXES = ['/v1beta/', '/upload/v1beta/'];

/** The only path Anthropic owns under `/v1`; everything else there is OpenAI-compatible. */
const ANTHROPIC_PATHS = /^\/v1\/messages(?:$|\/)/iu;

export function resolveAuthErrorSurface(request: {
  headers: RequestHeaders;
  url?: string;
}): ProxySurface {
  const path = normalizePath(request.url ?? '');
  if (GEMINI_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return 'gemini';
  }
  if (ANTHROPIC_PATHS.test(path)) {
    return 'anthropic';
  }

  // `/v1/models` and friends are served to both, so the caller names itself with the
  // header its SDK always sends.
  return hasAnthropicHeader(request.headers) ? 'anthropic' : 'openai';
}

/** The 401 body `surface` expects. The message is the caller's, unchanged. */
export function buildAuthErrorBody(
  surface: ProxySurface,
  message: string,
): Record<string, unknown> {
  if (surface === 'anthropic') {
    return { error: { message, type: 'authentication_error' }, type: 'error' };
  }
  if (surface === 'gemini') {
    return { error: { code: 401, message, status: 'UNAUTHENTICATED' } };
  }
  return {
    error: { code: 'invalid_api_key', message, param: null, type: 'invalid_request_error' },
  };
}

function normalizePath(url: string): string {
  const withoutQuery = url.split('?')[0] ?? '';
  return withoutQuery.endsWith('/') ? withoutQuery : `${withoutQuery}/`;
}

function hasAnthropicHeader(headers: RequestHeaders): boolean {
  return headers['anthropic-version'] !== undefined || headers['anthropic-beta'] !== undefined;
}

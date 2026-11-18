import type { RequestHeaders } from '../guards/api-key-auth.util';

const PRODUCT_HEADERS = [
  'x-claude-code-session-id',
  'x-antigravity-session-id',
  'x-client-session-id',
  'x-cursor-session-id',
  'cursor-session-id',
  'x-vscode-session-id',
  'anthropic-session-id',
] as const;
const ALIASES = [
  'x-session-id',
  'x-conversation-id',
  'conversation-id',
  'x-chat-id',
  'chat-id',
  'x-thread-id',
  'thread-id',
];
const FIELDS = [
  'session_id',
  'sessionId',
  'conversation_id',
  'chat_id',
  'thread_id',
  'client_session_id',
];
type HintSource =
  | 'header'
  | 'query'
  | 'body'
  | 'metadata'
  | 'legacy-user'
  | 'restored-lineage'
  | 'none';
export interface SessionHintDiagnostics {
  source: HintSource;
  field?: string;
  invalidCandidates: number;
}

function identifier(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || /[\p{Cc}\p{Cs}]/u.test(trimmed)) {
    return undefined;
  }
  if (trimmed.length <= 128) {
    return trimmed;
  }
  if (trimmed.length > 256) {
    return undefined;
  }
  return [...trimmed].length <= 128 ? trimmed : undefined;
}

/** One winner, with value-free diagnostics. Invalid hints fall through, never truncate or clean. */
export function resolveClientSessionHint(
  headers: RequestHeaders,
  url?: string,
  body?: object,
  metadata?: object,
): { id?: string; diagnostics: SessionHintDiagnostics } {
  let invalidCandidates = 0;
  const normalized = new Map<string, Array<RequestHeaders[string]>>();
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    const existing = normalized.get(key);
    if (existing) {
      existing.push(value);
    } else {
      normalized.set(key, [value]);
    }
  }
  const generic = [...normalized.keys()]
    .filter(
      (name) =>
        name.endsWith('-session-id') &&
        name !== 'x-session-id' &&
        !PRODUCT_HEADERS.some((product) => product === name) &&
        !/(?:^|-)(?:mcp|request|trace|correlation)(?:-|$)/u.test(name),
    )
    .sort();
  const winner = (id: string, source: HintSource, field: string) => ({
    id,
    diagnostics: { source, field, invalidCandidates },
  });
  for (const name of [...PRODUCT_HEADERS, ...generic, ...ALIASES]) {
    const values = normalized.get(name);
    if (!values) {
      continue;
    }
    const ids = values.map(identifier);
    const id = ids[0];
    if (id && ids.every((value) => value === id)) {
      return winner(id, 'header', name);
    }
    invalidCandidates += 1;
  }
  if (url) {
    let query: URLSearchParams | undefined;
    try {
      query = new URL(url, 'http://localhost').searchParams;
    } catch {
      /* Invalid request URLs supply no session hint. */
    }
    for (const field of FIELDS) {
      const values = query?.getAll(field);
      if (!values?.length) {
        continue;
      }
      const ids = values.map(identifier),
        id = ids[0];
      if (id && ids.every((value) => value === id)) {
        return winner(id, 'query', field);
      }
      invalidCandidates += 1;
    }
  }
  for (const [source, input] of [
    ['body', body],
    ['metadata', metadata],
  ] as const) {
    if (!input) {
      continue;
    }
    for (const field of FIELDS) {
      const value: unknown = Reflect.get(input, field);
      if (value === undefined) {
        continue;
      }
      const id = identifier(value);
      if (id) {
        return winner(id, source, field);
      }
      invalidCandidates += 1;
    }
  }
  // Preserve existing user-hint affinity; it remains a hint rather than authenticated identity.
  for (const field of ['user_id', 'userId']) {
    const value: unknown = metadata ? Reflect.get(metadata, field) : undefined;
    if (value === undefined) {
      continue;
    }
    const id = identifier(value);
    if (id) {
      return winner(id, 'legacy-user', field);
    }
    invalidCandidates += 1;
  }
  return { diagnostics: { source: 'none', invalidCandidates } };
}

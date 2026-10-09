import { createHash, randomUUID } from 'node:crypto';
import type {
  AnthropicChatRequest,
  OpenAIChatRequest,
  OpenAITool,
} from './interfaces/request-interfaces';
import { extractApiKeyToken, type RequestHeaders } from '../guards/api-key-auth.util';

export interface SignatureScopeContext {
  headers: RequestHeaders;
  url?: string;
}

export interface SignatureSessionScope {
  cacheKey: string;
  affinityKey: string;
}

const SESSION_FIELDS = [
  'session_id',
  'sessionId',
  'conversation_id',
  'chat_id',
  'thread_id',
  'client_session_id',
] as const;

function identifier(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function bodyIdentifier(body: object, metadata?: object): string | undefined {
  for (const source of [body, metadata]) {
    if (!source || typeof source !== 'object') {
      continue;
    }
    for (const field of SESSION_FIELDS) {
      const value = identifier(Reflect.get(source, field));
      if (value) {
        return value;
      }
    }
  }
  // User IDs are stable client hints, never sufficient without a content anchor.
  return metadata
    ? (identifier(Reflect.get(metadata, 'user_id')) ?? identifier(Reflect.get(metadata, 'userId')))
    : undefined;
}

function headerIdentifier(headers: RequestHeaders): string | undefined {
  const specialized = Object.keys(headers)
    .filter((name) => name !== 'x-session-id' && name.endsWith('-session-id'))
    .sort();
  for (const name of [
    ...specialized,
    'x-session-id',
    'x-conversation-id',
    'conversation-id',
    'x-chat-id',
    'chat-id',
    'x-thread-id',
    'thread-id',
  ]) {
    const value = identifier(headers[name]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function queryIdentifier(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  let query: URLSearchParams;
  try {
    query = new URL(url, 'http://localhost').searchParams;
  } catch {
    return undefined;
  }
  for (const field of SESSION_FIELDS) {
    const value = identifier(query.get(field));
    if (value) {
      return value;
    }
  }
  return undefined;
}

function scope(
  protocol: 'openai' | 'anthropic',
  anchor: string,
  sessionId: string | undefined,
  headers: RequestHeaders,
): SignatureSessionScope {
  // Retain only digests. Credentials and conversation contents never enter cache keys or logs.
  const tenant = digest(extractApiKeyToken(headers) ?? 'anonymous');
  const key = (content: string | null) =>
    `${protocol}:scope:${digest(JSON.stringify([tenant, sessionId ?? null, content]))}`;
  return { cacheKey: key(anchor), affinityKey: key(sessionId ? null : anchor) };
}

function openAIToolNames(tools: OpenAITool[] = []): string[] {
  return tools.flatMap((tool) =>
    tool.tools ? openAIToolNames(tool.tools) : [tool.function?.name ?? tool.name ?? ''],
  );
}

/** Stable across appended turns; a reused client ID cannot erase the conversation anchor. */
export function resolveOpenAISessionScope(
  request: OpenAIChatRequest,
  headers: RequestHeaders = {},
  url?: string,
): SignatureSessionScope {
  const firstUser = request.messages.find(
    (message) =>
      message.role === 'user' &&
      (typeof message.content === 'string'
        ? Boolean(message.content.trim())
        : message.content?.some((part) => part.type !== 'text' || Boolean(part.text?.trim()))),
  );
  const system = request.messages
    .filter((message) => message.role === 'system' || message.role === 'developer')
    .map((message) => message.content);
  const anchor = digest(
    JSON.stringify([
      firstUser?.content ?? (request.messages.length > 0 ? request.messages : randomUUID()),
      system,
      openAIToolNames(request.tools),
    ]),
  );
  return scope(
    'openai',
    anchor,
    headerIdentifier(headers) ?? queryIdentifier(url) ?? bodyIdentifier(request, request.extra),
    headers,
  );
}

/** Tool results do not become a new first-user anchor during a tool continuation. */
export function resolveAnthropicSessionScope(
  request: AnthropicChatRequest,
  headers: RequestHeaders = {},
  url?: string,
): SignatureSessionScope {
  const firstUser = request.messages.find(
    (message) =>
      message.role === 'user' &&
      (typeof message.content === 'string'
        ? Boolean(message.content.trim())
        : message.content.some(
            (block) =>
              block.type !== 'tool_result' && (block.type !== 'text' || Boolean(block.text.trim())),
          )),
  );
  const content = firstUser?.content;
  const anchor = digest(
    JSON.stringify([
      Array.isArray(content)
        ? content.filter((block) => block.type !== 'tool_result')
        : (content ?? (request.messages.length > 0 ? request.messages : randomUUID())),
      request.system ?? null,
      request.tools?.map((tool) => tool.name) ?? [],
    ]),
  );
  return scope(
    'anthropic',
    anchor,
    headerIdentifier(headers) ?? queryIdentifier(url) ?? bodyIdentifier(request, request.metadata),
    headers,
  );
}

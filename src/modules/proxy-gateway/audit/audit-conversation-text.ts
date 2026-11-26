import type Database from 'better-sqlite3';
import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { z } from 'zod';
import { redactDiagnosticText } from '@/shared/observability/sentryPrivacy';
import { iterateSqliteQuery } from '@/shared/persistence/database/iterate-sqlite-query';
import { auditJsonObject, parseAuditJsonBody } from './audit-json-object';
import { auditPayloadChunks } from './traffic-audit.schema';

export const AUDIT_CONVERSATION_BODY_LIMIT = 1024 * 1024;
export const AUDIT_CONVERSATION_CHUNK_LIMIT = 128;

export const AuditConversationBodySchema = z.object({
  id: z.string(),
  storedBytes: z.number().int().min(1).max(AUDIT_CONVERSATION_BODY_LIMIT),
  chunkCount: z.number().int().min(1).max(AUDIT_CONVERSATION_CHUNK_LIMIT),
});

export function normalizeAuditConversationText(text: string) {
  return text.replace(/[\p{Cc}\p{Bidi_Control}\s]+/gu, ' ').trim();
}

export function prepareAuditConversationBodyReader(db: Database.Database) {
  const orm = drizzle(db);
  return ({ id, storedBytes, chunkCount }: z.infer<typeof AuditConversationBodySchema>) => {
    const query = orm
      .select({ seq: auditPayloadChunks.sequence, payload: auditPayloadChunks.payload })
      .from(auditPayloadChunks)
      .where(
        and(
          eq(auditPayloadChunks.payloadId, id),
          lte(sql<number>`length(${auditPayloadChunks.payload})`, AUDIT_CONVERSATION_BODY_LIMIT),
        ),
      )
      .orderBy(asc(auditPayloadChunks.sequence))
      .limit(chunkCount + 1);
    const chunks: Buffer[] = [];
    let bytes = 0;
    for (const { seq, payload } of iterateSqliteQuery<{ seq: number; payload: unknown }>(
      db,
      query,
    )) {
      if (
        seq !== chunks.length ||
        !Buffer.isBuffer(payload) ||
        bytes + payload.length > storedBytes
      ) {
        return null;
      }
      chunks.push(payload);
      bytes += payload.length;
    }
    return chunks.length === chunkCount && bytes === storedBytes
      ? auditJsonObject(parseAuditJsonBody(Buffer.concat(chunks, bytes)))
      : null;
  };
}

function* textParts(content: unknown): Generator<string> {
  if (typeof content === 'string') {
    yield content;
  } else if (Array.isArray(content)) {
    for (const entry of content) {
      const part = auditJsonObject(entry);
      if (
        typeof part?.text === 'string' &&
        (part.type === 'text' ||
          part.type === 'input_text' ||
          part.type === 'output_text' ||
          part.type === undefined) &&
        part.thought !== true
      ) {
        yield part.text;
      }
    }
  }
}

type JsonBody = NonNullable<ReturnType<typeof auditJsonObject>>;

function* requestTexts(root: JsonBody, userOnly: boolean): Generator<string> {
  const request = auditJsonObject(root.request) ?? root;
  const messages = request.messages ?? request.input ?? request.contents;
  if (typeof messages === 'string') {
    yield messages;
  } else if (Array.isArray(messages)) {
    for (const entry of messages) {
      const message = auditJsonObject(entry);
      if (!message || (message.type !== undefined && message.type !== 'message')) {
        continue;
      }
      if (
        message.role === 'user' ||
        (!userOnly && (message.role === 'assistant' || message.role === 'model'))
      ) {
        yield* textParts(message.content ?? message.parts);
      }
    }
  }
}

export function firstAuditUserText(root: JsonBody) {
  for (const text of requestTexts(root, true)) {
    const normalized = normalizeAuditConversationText(text);
    if (normalized) {
      return redactDiagnosticText(normalized);
    }
  }
}

function* responseTexts(root: JsonBody): Generator<string> {
  const response = auditJsonObject(root.response) ?? root;
  if (response.role === 'assistant') {
    yield* textParts(response.content);
  }
  if (typeof response.output_text === 'string') {
    yield response.output_text;
  }
  for (const output of Array.isArray(response.output) ? response.output : []) {
    const message = auditJsonObject(output);
    if (message?.type === 'message' && message.role === 'assistant') {
      yield* textParts(message.content);
    }
  }
  for (const entry of Array.isArray(response.choices) ? response.choices : []) {
    const message = auditJsonObject(auditJsonObject(entry)?.message);
    if (message?.role === 'assistant') {
      yield* textParts(message.content);
    }
  }
  for (const entry of Array.isArray(response.candidates) ? response.candidates : []) {
    yield* textParts(auditJsonObject(auditJsonObject(entry)?.content)?.parts);
  }
}

function auditConversationContains(
  root: JsonBody,
  direction: 'request' | 'response',
  needle: string,
) {
  for (const text of direction === 'request' ? requestTexts(root, false) : responseTexts(root)) {
    if (redactDiagnosticText(normalizeAuditConversationText(text)).toLowerCase().includes(needle)) {
      return true;
    }
  }
  return false;
}

const sessionBody = AuditConversationBodySchema.extend({
  sessionId: z.string().min(1).max(512),
  direction: z.enum(['request', 'response']),
});

export function matchAuditSessionContent(
  db: Database.Database,
  rows: Iterable<unknown>,
  needle: string,
) {
  const readBody = prepareAuditConversationBodyReader(db);
  const matched = new Set<string>();
  for (const row of rows) {
    const body = sessionBody.parse(row);
    if (matched.has(body.sessionId)) {
      continue;
    }
    const root = readBody(body);
    if (root && auditConversationContains(root, body.direction, needle)) {
      matched.add(body.sessionId);
    }
  }
  return [...matched];
}

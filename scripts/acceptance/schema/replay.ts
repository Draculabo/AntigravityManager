import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { normalizeObjectJsonSchema } from '../../../src/modules/proxy-gateway/antigravity/JsonSchemaUtils';
import {
  SchemaConversionBatch,
  SchemaInputError,
} from '../../../src/modules/proxy-gateway/antigravity/schema/SchemaConversion';

const Descriptor = z.object({
  id: z.string(),
  logical_bytes: z.number().int().nonnegative(),
  chunk_count: z.number().int().nonnegative(),
  sha256: z.string().nullable(),
  sha256_scope: z.string(),
});
const Chunk = z.object({
  seq: z.number().int().nonnegative(),
  encoding: z.enum(['raw', 'gzip']),
  payload: z.instanceof(Uint8Array),
});
const Tool = z.object({
  type: z.string().optional(),
  name: z.string().optional(),
  parameters: z.unknown().optional(),
  input_schema: z.unknown().optional(),
  function: z
    .object({ name: z.string().optional(), parameters: z.unknown().optional() })
    .optional(),
});
const Request = z.object({
  tools: z.array(Tool).optional(),
  response_format: z
    .object({
      type: z.string().optional(),
      json_schema: z.object({ schema: z.unknown() }).optional(),
    })
    .optional(),
  text: z
    .object({
      format: z.object({ type: z.string().optional(), schema: z.unknown().optional() }).optional(),
    })
    .optional(),
});
const RequestShape = z.object({
  tools: z.unknown().optional(),
  messages: z.unknown().optional(),
  input: z.unknown().optional(),
  request: z.unknown().optional(),
  body: z.unknown().optional(),
  contents: z.unknown().optional(),
});

export function replayAuditSchemas(
  databasePath: string,
  limit = 1000,
  cohort: 'all' | 'unmarked' = 'all',
) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const summary = {
    cohort,
    selected: 0,
    replayed: 0,
    schemas: 0,
    degraded: 0,
    rejected: 0,
    excludedIntegrity: 0,
    excludedShape: 0,
    maxNodes: 0,
    maxBytes: 0,
    issueKinds: {} as Partial<Record<SchemaInputError['kind'], number>>,
  };
  try {
    const shapes = { tools: 0, messages: 0, input: 0, request: 0, body: 0, contents: 0 };
    const descriptors = z.array(Descriptor).parse(
      database
        .prepare(
          `SELECT p.id,p.logical_bytes,p.chunk_count,p.sha256,p.sha256_scope
             FROM request_body_refs r JOIN audit_payloads p ON p.id=r.payload_id
             JOIN request_logs l ON l.id=r.request_id
             WHERE r.direction='request' AND l.traffic_class='model'
             AND l.protocol IN ('openai','anthropic','compatible')
             AND p.kind='json' AND p.representation='sanitized_json' AND p.state='complete'
             AND p.partial=0 AND p.oversized=0 AND p.logical_bytes<=4194304
             AND (?='all' OR CASE WHEN json_valid(l.request_headers)=1
               THEN CASE WHEN json_type(l.request_headers)='object'
                 THEN NOT EXISTS (SELECT 1 FROM json_each(l.request_headers)
                   WHERE lower(key)='x-schema-acceptance')
                 ELSE 0 END
               ELSE 0 END)
             ORDER BY p.created_at DESC LIMIT ?`,
        )
        .all(cohort, limit),
    );
    summary.selected = descriptors.length;
    for (const descriptor of descriptors) {
      const chunks = z
        .array(Chunk)
        .parse(
          database
            .prepare(
              'SELECT seq,encoding,payload FROM audit_payload_chunks WHERE payload_id=? ORDER BY seq',
            )
            .all(descriptor.id),
        );
      if (
        chunks.length !== descriptor.chunk_count ||
        chunks.some((chunk, index) => chunk.seq !== index)
      ) {
        summary.excludedIntegrity++;
        continue;
      }
      const text = Buffer.concat(
        chunks.map((chunk) =>
          chunk.encoding === 'gzip'
            ? gunzipSync(chunk.payload, { maxOutputLength: 4_194_304 })
            : Buffer.from(chunk.payload),
        ),
      ).toString('utf8');
      if (
        Buffer.byteLength(text) !== descriptor.logical_bytes ||
        (descriptor.sha256 && createHash('sha256').update(text).digest('hex') !== descriptor.sha256)
      ) {
        summary.excludedIntegrity++;
        continue;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        summary.excludedIntegrity++;
        continue;
      }
      const shape = RequestShape.safeParse(raw);
      if (shape.success) {
        for (const key of ['tools', 'messages', 'input', 'request', 'body', 'contents'] as const) {
          shapes[key] += shape.data[key] === undefined ? 0 : 1;
        }
      }
      const parsed = Request.safeParse(raw);
      if (!parsed.success) {
        summary.excludedShape++;
        continue;
      }
      const schemas: { value: unknown; policy: 'tool' | 'output' }[] = [];
      for (const tool of parsed.data.tools ?? []) {
        if (
          ['web_search', 'google_search', 'builtin_web_search', 'web_search_20250305'].includes(
            tool.type ?? tool.name ?? '',
          ) ||
          tool.type === 'custom'
        ) {
          continue;
        }
        if (!tool.name && !tool.function?.name) {
          continue;
        }
        schemas.push({
          value: tool.function?.parameters ?? tool.input_schema ?? tool.parameters,
          policy: 'tool',
        });
      }
      const format = parsed.data.response_format;
      if (format?.type === 'json_schema') {
        schemas.push({ value: format.json_schema?.schema, policy: 'output' });
      }
      if (parsed.data.text?.format?.type === 'json_schema') {
        schemas.push({ value: parsed.data.text.format.schema, policy: 'output' });
      }
      if (schemas.length === 0) {
        summary.excludedShape++;
        continue;
      }
      // Audit redaction/truncation is not evidence of an original production Schema defect.
      if (
        schemas.some((schema) =>
          /\[(?:REDACTED|TRUNCATED|CIRCULAR)\]/i.test(JSON.stringify(schema.value) ?? ''),
        )
      ) {
        summary.excludedIntegrity++;
        continue;
      }
      const batch = new SchemaConversionBatch();
      summary.replayed++;
      try {
        schemas.forEach((schema, ordinal) => {
          normalizeObjectJsonSchema(
            schema.value,
            batch,
            schema.policy,
            schema.policy === 'tool' ? ordinal : null,
          );
          summary.schemas++;
        });
      } catch (error) {
        if (!(error instanceof SchemaInputError)) {
          throw error;
        }
        summary.rejected++;
      }
      summary.degraded += batch.degraded ? 1 : 0;
      summary.maxNodes = Math.max(summary.maxNodes, batch.nodes);
      summary.maxBytes = Math.max(summary.maxBytes, batch.bytes);
      for (const issue of batch.issues) {
        summary.issueKinds[issue.kind] = (summary.issueKinds[issue.kind] ?? 0) + 1;
      }
    }
    return { ...summary, shapes, available: summary.replayed > 0 };
  } finally {
    database.close();
  }
}

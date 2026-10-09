import { isPlainObject } from 'lodash-es';

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonSchemaMap;
export interface JsonSchemaMap {
  [key: string]: JsonValue;
}
export type SchemaIssueKind =
  | 'invalid-input'
  | 'input-budget'
  | 'request-budget'
  | 'expansion-budget'
  | 'invalid-reference'
  | 'unsupported-reference'
  | 'reference-cycle'
  | 'invalid-root';
export interface SchemaIssue {
  kind: SchemaIssueKind;
  recovered: boolean;
  toolOrdinal: number | null;
}
export interface SchemaLimits {
  depth: number;
  schemaNodes: number;
  requestNodes: number;
  schemaBytes: number;
  requestBytes: number;
}
export const DEFAULT_SCHEMA_LIMITS: Readonly<SchemaLimits> = {
  depth: 64,
  schemaNodes: 10_000,
  requestNodes: 50_000,
  schemaBytes: 1_048_576,
  requestBytes: 4_194_304,
};
export class SchemaInputError extends Error {
  constructor(
    readonly kind: SchemaIssueKind,
    message = `Invalid request schema: ${kind}`,
  ) {
    super(message);
    this.name = 'SchemaInputError';
  }
}

/** Request-owned accounting, independent of account retries and provider state. */
export class SchemaConversionBatch {
  readonly issues: SchemaIssue[] = [];
  issueCount = 0;
  nodes = 0;
  bytes = 0;
  degraded = false;

  constructor(readonly limits: Readonly<SchemaLimits> = DEFAULT_SCHEMA_LIMITS) {}

  issue(kind: SchemaIssueKind, recovered: boolean, toolOrdinal: number | null): void {
    this.issueCount++;
    this.degraded ||= recovered;
    if (this.issues.length < 32) {
      this.issues.push({ kind, recovered, toolOrdinal });
    }
  }

  charge(nodes: number, bytes: number): void {
    this.nodes += nodes;
    this.bytes += bytes;
    if (this.nodes > this.limits.requestNodes || this.bytes > this.limits.requestBytes) {
      throw new SchemaInputError('request-budget');
    }
  }
}

export function isSchemaMap(value: unknown): value is JsonSchemaMap {
  return isPlainObject(value);
}

/** Validate iteratively before recursive codecs, cloning or JSON serialization. */
export function validateSchemaInput(
  value: unknown,
  batch: SchemaConversionBatch,
  phase: 'input' | 'output' = 'input',
): asserts value is JsonSchemaMap {
  if (!isSchemaMap(value)) {
    throw new SchemaInputError('invalid-input');
  }
  const pending: { value: unknown; depth: number; exit?: boolean }[] = [{ value, depth: 0 }];
  const active = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  while (pending.length > 0) {
    const entry = pending.pop()!;
    const current = entry.value;
    if (entry.exit && typeof current === 'object' && current !== null) {
      active.delete(current);
      continue;
    }
    nodes++;
    if (nodes > batch.limits.schemaNodes || entry.depth > batch.limits.depth) {
      throw new SchemaInputError(phase === 'input' ? 'input-budget' : 'expansion-budget');
    }
    if (typeof current === 'object' && current !== null) {
      if ((!Array.isArray(current) && !isSchemaMap(current)) || active.has(current)) {
        throw new SchemaInputError('invalid-input');
      }
      active.add(current);
      pending.push({ value: current, depth: entry.depth, exit: true });
      const children = Object.entries(current);
      bytes += 2 + children.length;
      for (const [key, child] of children) {
        bytes += Buffer.byteLength(JSON.stringify(key)) + 1;
        pending.push({ value: child, depth: entry.depth + 1 });
      }
    } else if (
      current === null ||
      typeof current === 'string' ||
      typeof current === 'boolean' ||
      (typeof current === 'number' && Number.isFinite(current))
    ) {
      bytes += Buffer.byteLength(JSON.stringify(current));
    } else {
      throw new SchemaInputError('invalid-input');
    }
    if (bytes > batch.limits.schemaBytes) {
      throw new SchemaInputError(phase === 'input' ? 'input-budget' : 'expansion-budget');
    }
  }
  batch.charge(nodes, bytes);
}

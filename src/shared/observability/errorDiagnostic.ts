import { randomUUID } from 'node:crypto';

import { redactDiagnosticText } from './sentryPrivacy';

export const DIAGNOSTIC_RECORD_VERSION = 1;
export const DEFAULT_DIAGNOSTIC_STACK_CHUNK_BYTES = 64 * 1024;
const MAX_CAUSE_DEPTH = 16;

export interface DiagnosticCause {
  name: string;
  message: string;
  stack: string | null;
  cycle: boolean;
}

export interface DiagnosticErrorRecord {
  version: number;
  id: string;
  createdAt: string;
  role: 'app' | 'core' | 'unknown';
  source: string;
  module: string | null;
  functionName: string | null;
  stage: string | null;
  protocol: string | null;
  requestId: string | null;
  attemptId: string | null;
  category: string;
  status: number | null;
  message: string;
  stack: string | null;
  stackChunks: readonly string[];
  stackComplete: boolean;
  causes: readonly DiagnosticCause[];
}

export interface CreateDiagnosticErrorRecordInput {
  error: unknown;
  source: string;
  category: string;
  role?: DiagnosticErrorRecord['role'];
  module?: string;
  functionName?: string;
  stage?: string;
  protocol?: string;
  requestId?: string;
  attemptId?: string;
  status?: number;
  now?: Date;
}

function errorName(value: unknown): string {
  return value instanceof Error && value.name ? value.name : 'Error';
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === 'string') {
    return value;
  }
  return 'Unknown error';
}

function errorStack(value: unknown): string | null {
  return value instanceof Error && typeof value.stack === 'string' ? value.stack : null;
}

function causeOf(value: unknown): unknown {
  if (!(value instanceof Error)) {
    return undefined;
  }
  return 'cause' in value ? value.cause : undefined;
}

/** Splits UTF-8 text without dropping a code point or changing its content. */
export function splitDiagnosticText(
  text: string,
  maxBytes = DEFAULT_DIAGNOSTIC_STACK_CHUNK_BYTES,
): string[] {
  const limit = Math.max(1, Math.floor(maxBytes));
  if (!text) {
    return [];
  }
  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const character of text) {
    const bytes = Buffer.byteLength(character, 'utf8');
    if (current && currentBytes + bytes > limit) {
      chunks.push(current);
      current = '';
      currentBytes = 0;
    }
    current += character;
    currentBytes += bytes;
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

function collectCauses(error: unknown): DiagnosticCause[] {
  const causes: DiagnosticCause[] = [];
  const seen = new Set<object>();
  let current = causeOf(error);
  for (let depth = 0; current !== undefined && depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current === 'object' && current !== null) {
      if (seen.has(current)) {
        causes.push({ name: 'CauseCycle', message: '[cause cycle]', stack: null, cycle: true });
        break;
      }
      seen.add(current);
    }
    causes.push({
      name: redactDiagnosticText(errorName(current)),
      message: redactDiagnosticText(errorMessage(current)),
      stack: errorStack(current) ? redactDiagnosticText(errorStack(current)!) : null,
      cycle: false,
    });
    current = causeOf(current);
  }
  if (current !== undefined && causes.length >= MAX_CAUSE_DEPTH) {
    causes.push({
      name: 'CauseDepthLimit',
      message: '[cause chain truncated after depth limit]',
      stack: null,
      cycle: false,
    });
  }
  return causes;
}

export function createDiagnosticErrorRecord(
  input: CreateDiagnosticErrorRecordInput,
  stackChunkBytes = DEFAULT_DIAGNOSTIC_STACK_CHUNK_BYTES,
): DiagnosticErrorRecord {
  const stack = errorStack(input.error);
  const redactedStack = stack ? redactDiagnosticText(stack) : null;
  return {
    version: DIAGNOSTIC_RECORD_VERSION,
    id: randomUUID(),
    createdAt: (input.now ?? new Date()).toISOString(),
    role: input.role ?? 'unknown',
    source: redactDiagnosticText(input.source),
    module: input.module ? redactDiagnosticText(input.module) : null,
    functionName: input.functionName ? redactDiagnosticText(input.functionName) : null,
    stage: input.stage ? redactDiagnosticText(input.stage) : null,
    protocol: input.protocol ? redactDiagnosticText(input.protocol) : null,
    requestId: input.requestId ? redactDiagnosticText(input.requestId) : null,
    attemptId: input.attemptId ? redactDiagnosticText(input.attemptId) : null,
    category: redactDiagnosticText(input.category),
    status: Number.isInteger(input.status) ? input.status! : null,
    message: redactDiagnosticText(errorMessage(input.error)),
    stack: redactedStack,
    stackChunks: redactedStack ? splitDiagnosticText(redactedStack, stackChunkBytes) : [],
    stackComplete: Boolean(redactedStack),
    causes: collectCauses(input.error),
  };
}

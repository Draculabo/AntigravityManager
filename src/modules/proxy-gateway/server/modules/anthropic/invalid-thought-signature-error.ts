import { isString } from 'lodash-es';
import { UpstreamRequestError } from '../../common/exceptions/upstream-request.exception';

export type InvalidThoughtSignatureEvidenceSource =
  | 'structured_detail'
  | 'message'
  | 'parsed_body'
  | 'text_fallback';

export interface InvalidThoughtSignatureClassification {
  source: InvalidThoughtSignatureEvidenceSource;
}

const INVALID_THOUGHT_SIGNATURE = /invalid thought signature\.?/i;
const SIGNATURE_FIELD = /(?:thought[_-]?signature|thinking\.signature)/i;
const INVALID_QUALIFIER = /(?:invalid|corrupt(?:ed)?|required|missing)/i;

function hasDirectEvidence(text: string): boolean {
  return (
    INVALID_THOUGHT_SIGNATURE.test(text) ||
    (SIGNATURE_FIELD.test(text) && INVALID_QUALIFIER.test(text))
  );
}

function classifyStructuredDetails(error: UpstreamRequestError): boolean {
  return (error.details ?? []).some((detail) => {
    const reason = detail.reason ?? '';
    if (hasDirectEvidence(reason)) {
      return true;
    }
    return Object.entries(detail.metadata ?? {}).some(
      ([key, value]) =>
        (SIGNATURE_FIELD.test(key) && INVALID_QUALIFIER.test(value)) ||
        (INVALID_QUALIFIER.test(key) && SIGNATURE_FIELD.test(value)) ||
        hasDirectEvidence(value),
    );
  });
}

function parseBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function hasParsedBodyEvidence(value: unknown, path = '', depth = 0): boolean {
  if (depth > 8) {
    return false;
  }
  if (isString(value)) {
    return (
      hasDirectEvidence(value) || (SIGNATURE_FIELD.test(path) && INVALID_QUALIFIER.test(value))
    );
  }
  if (Array.isArray(value)) {
    return value.some((entry) => hasParsedBodyEvidence(entry, path, depth + 1));
  }
  if (!value || typeof value !== 'object') {
    return false;
  }
  const entries = Object.entries(value);
  const siblingText = entries
    .filter((item): item is [string, string] => isString(item[1]))
    .map(([key, child]) => `${key} ${child}`)
    .join(' ');
  if (hasDirectEvidence(siblingText)) {
    return true;
  }
  return entries.some(([key, child]) =>
    hasParsedBodyEvidence(child, path ? `${path}.${key}` : key, depth + 1),
  );
}

export function classifyInvalidThoughtSignatureError(
  error: unknown,
): InvalidThoughtSignatureClassification | null {
  if (!(error instanceof UpstreamRequestError) || error.status !== 400) {
    return null;
  }
  if (classifyStructuredDetails(error)) {
    return { source: 'structured_detail' };
  }
  if (hasDirectEvidence(error.message)) {
    return { source: 'message' };
  }
  if (error.body) {
    const parsedBody = parseBody(error.body);
    if (parsedBody !== null && hasParsedBodyEvidence(parsedBody)) {
      return { source: 'parsed_body' };
    }
    if (INVALID_THOUGHT_SIGNATURE.test(error.body)) {
      return { source: 'text_fallback' };
    }
  }
  return null;
}

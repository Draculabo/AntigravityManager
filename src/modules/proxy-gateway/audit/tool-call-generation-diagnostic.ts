import {
  isMalformedFunctionCallFinishReason,
  MALFORMED_FUNCTION_CALL_RECOVERY_TEXT,
} from '../antigravity/GeminiFinishReason';
import { auditJsonObject } from './audit-json-object';

/** Record a generation warning without changing the successful transport outcome. */
export function toolCallGenerationDiagnostic(value: unknown): string | undefined {
  const envelope = auditJsonObject(value);
  const response = auditJsonObject(envelope?.response) ?? envelope;
  const candidates = response?.candidates;
  if (!Array.isArray(candidates)) {
    return undefined;
  }
  for (const value of candidates) {
    const candidate = auditJsonObject(value);
    const reason = candidate?.finishReason;
    if (typeof reason === 'string' && isMalformedFunctionCallFinishReason(reason)) {
      return `MALFORMED_FUNCTION_CALL: ${MALFORMED_FUNCTION_CALL_RECOVERY_TEXT}`;
    }
  }
  return undefined;
}

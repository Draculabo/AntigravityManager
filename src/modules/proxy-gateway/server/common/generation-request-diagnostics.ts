import type { GeminiInternalRequest } from '../../antigravity/types';
import { getTrafficAuditRequestContext } from '../../audit/traffic-audit-context';
import { logger } from '@/shared/logging/logger';
import { estimateRequestContext, type RequestContextEstimate } from './request-context-estimate';
import { snapshotPromptTransformations } from './prompt-transformation-diagnostics';

/** Called after final attempt rebinding and serialization, before the physical dispatch. */
export function recordGenerationRequestAttempt(
  body: GeminiInternalRequest,
  serialized: string,
  semanticEstimate: RequestContextEstimate = estimateRequestContext(body),
): void {
  const report = {
    phase: 'physical-send',
    attempt: getTrafficAuditRequestContext()?.attemptSequence ?? null,
    semanticEstimate,
    sentEstimate: estimateRequestContext(body),
    serializedBytes: Buffer.byteLength(serialized, 'utf8'),
    cachedPrefix: Boolean(body.request.cachedContent),
    transformations: snapshotPromptTransformations(),
  };
  logger.debug(`[ContextEstimate] ${JSON.stringify(report)}`);
}

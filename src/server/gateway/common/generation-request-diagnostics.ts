import type { GeminiInternalRequest } from '../../../modules/proxy-gateway/antigravity/types';
import { getTrafficAuditRequestContext } from '../../../modules/proxy-gateway/audit/traffic-audit-context';
import { logger } from '@/shared/logging/logger';
import { estimateRequestContext, type RequestContextEstimate } from './request-context-estimate';
import { snapshotPromptTransformations } from './prompt-transformation-diagnostics';
import { snapshotThoughtRestoreDiagnostics } from '../../../modules/proxy-gateway/thought-store/thought-restore-diagnostics';

/** Called after final attempt rebinding and serialization, before the physical dispatch. */
export function recordGenerationRequestAttempt(
  body: GeminiInternalRequest,
  serialized: string,
  semanticEstimate: RequestContextEstimate = estimateRequestContext(body),
): void {
  const report = {
    phase: 'physical-send',
    requestId: getTrafficAuditRequestContext()?.parent?.id ?? null,
    attempt: getTrafficAuditRequestContext()?.attemptSequence ?? null,
    semanticEstimate,
    sentEstimate: estimateRequestContext(body),
    serializedBytes: Buffer.byteLength(serialized, 'utf8'),
    cachedPrefix: Boolean(body.request.cachedContent),
    transformations: snapshotPromptTransformations(),
    thoughtRestore: snapshotThoughtRestoreDiagnostics(),
  };
  logger.debug(`[ContextEstimate] ${JSON.stringify(report)}`);
}

/** Preparation can finish through cancellation or invalidation before any physical send. */
export function recordThoughtRestoreCompletion(): void {
  const thoughtRestore = snapshotThoughtRestoreDiagnostics();
  if (!thoughtRestore) {
    return;
  }
  const report = {
    phase: 'thought-restore-complete',
    requestId: getTrafficAuditRequestContext()?.parent?.id ?? null,
    attempt: getTrafficAuditRequestContext()?.attemptSequence ?? null,
    thoughtRestore,
  };
  logger.debug(`[ContextEstimate] ${JSON.stringify(report)}`);
}

import { trafficAuditService } from '../audit/traffic-audit.service';
import { thoughtStoreService } from '../thought-store/thought-store.service';
import { responsesSessionOwner } from '../../../server/gateway/modules/openai/responses/responses-session-owner';
import { errorProcessOwner } from '@/modules/error-diagnostics/public';

/** Attempt every owner, including when the gateway was never started or is already stopped. */
export async function shutdownDiagnosticStores(): Promise<void> {
  const results = await Promise.allSettled([
    trafficAuditService.shutdown(),
    thoughtStoreService.shutdown(),
    responsesSessionOwner.shutdown(),
    errorProcessOwner.shutdown(),
  ]);
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Diagnostic stores shutdown failed');
  }
}

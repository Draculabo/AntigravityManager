import { trafficAuditService } from '../audit/traffic-audit.service';
import { thoughtStoreService } from '../thought-store/thought-store.service';

/** Attempt both stores, including when the gateway was never started or is already stopped. */
export async function shutdownDiagnosticStores(): Promise<void> {
  const results = await Promise.allSettled([
    trafficAuditService.shutdown(),
    thoughtStoreService.shutdown(),
  ]);
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Diagnostic stores shutdown failed');
  }
}

import { logger } from '@/shared/logging/logger';

export interface CoreShutdownResources {
  management: { beginShutdown?(): void; close(): Promise<void> };
  accountMutations?: {
    closeAccountMutationAdmission(): void;
    drainAccountMutations(): Promise<void>;
  };
  core: { stop(): Promise<void> };
  lease?: { close(): Promise<void> };
  oauth?: { stop(): Promise<void> };
  warmup?: { cancel(): void; drain(): Promise<void> };
  monitor?: { closeAdmission(): void; drain(): Promise<void> };
  diagnostics?: { shutdown(): Promise<void> };
  observability?: { shutdown(): Promise<void> };
}

/** Keep shutdown idempotent while attempting both resource closures. */
export function createCoreShutdown({
  management,
  accountMutations,
  core,
  lease,
  oauth,
  warmup,
  monitor,
  diagnostics,
  observability,
}: CoreShutdownResources): () => Promise<void> {
  let shutdownPromise: Promise<void> | null = null;
  return async () => {
    shutdownPromise ??= (async () => {
      management.beginShutdown?.();
      accountMutations?.closeAccountMutationAdmission();
      monitor?.closeAdmission();
      warmup?.cancel();
      const oauthStop = oauth?.stop() ?? Promise.resolve();
      const managementClose = management.close();
      const [oauthResult, managementResult] = await Promise.allSettled([
        oauthStop,
        managementClose,
      ]);
      const [accountMutationsResult] = await Promise.allSettled([
        accountMutations?.drainAccountMutations() ?? Promise.resolve(),
      ]);
      const [warmupResult] = await Promise.allSettled([warmup?.drain() ?? Promise.resolve()]);
      const [monitorResult] = await Promise.allSettled([monitor?.drain() ?? Promise.resolve()]);
      const [coreResult] = await Promise.allSettled([core.stop()]);
      const [diagnosticsResult] = await Promise.allSettled([
        diagnostics?.shutdown() ?? Promise.resolve(),
      ]);
      // Reporting is best-effort; its bounded flush must not prevent lease release.
      await observability?.shutdown().catch(() => logger.warn('Core error reporting flush failed'));
      const failures = [
        oauthResult,
        managementResult,
        accountMutationsResult,
        warmupResult,
        monitorResult,
        coreResult,
        diagnosticsResult,
      ].flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
      if (
        lease &&
        oauthResult.status === 'fulfilled' &&
        managementResult.status === 'fulfilled' &&
        accountMutationsResult.status === 'fulfilled' &&
        warmupResult.status === 'fulfilled' &&
        monitorResult.status === 'fulfilled' &&
        coreResult.status === 'fulfilled' &&
        diagnosticsResult.status === 'fulfilled'
      ) {
        try {
          await lease.close();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Core shutdown failed');
      }
    })();
    await shutdownPromise;
  };
}

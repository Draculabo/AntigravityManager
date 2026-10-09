import { configureCoreOwnerPresentation } from '@/modules/cloud-account/services/account-owner-presentation.service';
import { localAccountImportCoordinator } from '@/modules/cloud-account/local-import/local-account-import-coordinator.service';
import { CoreService } from './core-service';
import { getManagementEndpoint } from './management/endpoint';
import { ManagementServer } from './management/server';
import { createCoreShutdown } from './shutdown';
import { ProfileLease } from './ownership/profile-lease';
import { startOwnedCore } from './owned-startup';
import { logger } from '@/shared/logging/logger';
import { HeadlessOAuthSessionService } from '@/modules/cloud-account/services/headless-oauth-session.service';
import { reloadNestServerAccountLeaseCache } from '@/server/main';
import { createCoreRpcOperations } from './rpc/router';
import { cloudAccountWeeklyWarmupRunner } from '@/modules/cloud-account/services/cloud-account-weekly-warmup-runner';
import { createWeeklyWarmupExecutor } from '@/modules/proxy-gateway/weekly-warmup-executor';
import { CloudMonitorService } from '@/modules/cloud-account/services/CloudMonitorService';
import { shutdownDiagnosticStores } from '@/modules/proxy-gateway/diagnostics/shutdown';
import { assertCoreRuntimeResources } from './runtime-resources';
import { initializeCoreErrorReporting, flushErrorReporting } from './error-reporting';

async function runCore(): Promise<void> {
  if (process.argv.includes('--help')) {
    process.stdout.write('Usage: antigravity-manager-core [--help]\n');
    return;
  }

  const core = new CoreService();
  const lease = new ProfileLease('core');
  const oauth = new HeadlessOAuthSessionService(undefined, reloadNestServerAccountLeaseCache);
  const rpc = createCoreRpcOperations(core);
  const management = new ManagementServer({
    endpoint: getManagementEndpoint(),
    getStatus: () => core.getStatus(),
    shutdown: () => shutdown(),
    onShutdownError: (error) => {
      logger.error('Core shutdown failed', error);
      process.exitCode = 1;
    },
    oauth,
    rpc,
  });
  const shutdown = createCoreShutdown({
    management,
    accountMutations: rpc,
    core,
    lease,
    oauth,
    warmup: cloudAccountWeeklyWarmupRunner,
    monitor: CloudMonitorService,
    diagnostics: { shutdown: shutdownDiagnosticStores },
    observability: { shutdown: flushErrorReporting },
  });

  const handleSignal = (): void => {
    shutdown().catch((error: unknown) => {
      logger.error('Core shutdown failed', error);
      process.exitCode = 1;
    });
  };

  try {
    await assertCoreRuntimeResources(__dirname);
    configureCoreOwnerPresentation();
    localAccountImportCoordinator.openAdmission();
    cloudAccountWeeklyWarmupRunner.configure(createWeeklyWarmupExecutor());
    await startOwnedCore({
      lease,
      management,
      core,
      onManagementReady: () => {
        initializeCoreErrorReporting();
        cloudAccountWeeklyWarmupRunner.start();
        CloudMonitorService.openAdmission();
        CloudMonitorService.syncSchedule();
        process.once('SIGINT', handleSignal);
        process.once('SIGTERM', handleSignal);
      },
    });
    logger.info('Standalone core service started');
  } catch (error) {
    logger.error('Standalone core service failed to start', error);
    process.exitCode = 1;
    await shutdown().catch((closeError: unknown) => {
      logger.error('Could not fully release core resources', closeError);
    });
  }
}

void runCore();

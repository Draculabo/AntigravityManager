import { prepareClassicHotSwitch, assertClassicRestartOwnership } from '../classicHotSwitch';
import { startFromContext } from '../launch';
import { stopFromContext } from '../stop';
import { processError } from '../processErrors';
import type { LaunchContext } from '../types';
import type { ClassicTermsSwitch } from '../terms/classicTermsSwitch';
import type { SwitchStage, SwitchTrace } from '@/shared/observability/switchDiagnostic';
import { SwitchTraceRecorder } from './switchTrace';

interface ClassicSwitchOptions {
  context: LaunchContext;
  useCredentialStore: boolean;
  timeoutMs: number;
  terms: ClassicTermsSwitch | null;
  write(applyProfile?: boolean): Promise<void>;
  finalize(): Promise<void>;
  onStage(stage: 'target-write' | 'process-close' | 'process-start'): void;
  onPhase(stage: SwitchStage): void;
  onLaunch(): void;
  onTrace?(trace: SwitchTrace): void;
}

/** One hot attempt followed by at most one restart of the same captured installation/profile. */
export async function executeClassicSwitch(options: ClassicSwitchOptions): Promise<void> {
  const trace = new SwitchTraceRecorder();
  let hotError: unknown;
  let recovered = false;
  let launchAttempted = false;
  let termsAttempted = false;
  let outcome: SwitchTrace['outcome'] = 'failed';
  const phase = <T>(stage: SwitchStage, mode: 'hot' | 'restart', action: () => Promise<T>) => {
    options.onPhase(stage);
    return trace.phase(stage, mode, action, mode === 'hot' ? 'restart' : 'stop');
  };
  const write = async (applyProfile = true) => {
    options.onStage('target-write');
    trace.effects.credentials = 'uncertain';
    await options.write(applyProfile);
    trace.effects.credentials = 'confirmed';
  };
  try {
    let hotConfirmed = false;
    try {
      const session =
        options.useCredentialStore && options.terms
          ? await phase('hot-prepare', 'hot', () => prepareClassicHotSwitch(options.context))
          : null;
      if (session) {
        await phase('terms-capture', 'hot', async () => options.terms?.captureForHotSwitch());
        await phase('hot-write', 'hot', () => write());
        await phase('service-stop', 'hot', async () => {
          trace.effects.services = 'uncertain';
          await session.stopServices();
          trace.effects.services = 'retired';
        });
        await phase('credential-reassert', 'hot', () => write(false));
        await phase('service-replacement', 'hot', async () => {
          await session.confirmReplacement();
          trace.effects.services = 'replaced';
        });
        await phase('terms-confirm', 'hot', async () => {
          // A live Classic can keep the old account's consent slot despite a fresh AI process.
          // Only the official writer may update it while running; stopped-client recovery can restore history.
          if (!(await options.terms!.confirmHotSwitch())) {
            throw processError('switched-hot-unconfirmed');
          }
        });
        hotConfirmed = true;
      }
    } catch (error) {
      hotError = error;
      recovered = true;
    }
    if (!hotConfirmed) {
      if (recovered && options.context.processes.length) {
        // Service observations cannot authorize restart. Re-establish main ownership separately.
        await phase('restart-ownership', 'restart', () =>
          assertClassicRestartOwnership(options.context),
        );
      }
      await phase('client-close', 'restart', async () => {
        options.onStage('process-close');
        trace.effects.client = 'exit-uncertain';
        await stopFromContext(options.context, options.timeoutMs, { forceAfterTimeout: true });
        trace.effects.client = 'stopped';
      });
      await phase('restart-write', 'restart', () => write());
      await phase('terms-restore', 'restart', async () => {
        termsAttempted = Boolean(options.terms);
        await options.terms?.apply();
      });
      await phase('client-start', 'restart', async () => {
        options.onStage('process-start');
        options.onLaunch();
        launchAttempted = true;
        trace.effects.client = 'startup-uncertain';
        try {
          await startFromContext(options.context);
        } catch (error) {
          throw processError('switched-startup-unconfirmed', error);
        }
        trace.effects.client = 'started';
      });
    }
    await phase('account-finalize', hotConfirmed ? 'hot' : 'restart', options.finalize);
    outcome = hotConfirmed ? 'hot-success' : recovered ? 'recovered-by-restart' : 'restart-success';
  } catch (error) {
    let finalError = error;
    if (!launchAttempted && termsAttempted && options.terms) {
      try {
        await phase('terms-rollback', 'restart', () => options.terms!.rollback());
      } catch (rollbackError) {
        finalError = new AggregateError([error, rollbackError], 'Classic terms recovery failed', {
          cause: error,
        });
      }
    }
    if (hotError !== undefined && error !== hotError) {
      // The final error remains the causal owner; retain the initiating failure as its sibling.
      throw new AggregateError([finalError, hotError], 'Classic switch recovery failed', {
        cause: finalError,
      });
    }
    throw finalError;
  } finally {
    const report = trace.finish(outcome);
    try {
      options.onTrace?.(report);
    } catch {
      /* Reporting cannot change account state. */
    }
  }
}

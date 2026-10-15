import { logger } from '@/shared/logging/logger';
import {
  ReportingReceiptSchema,
  type OperationReport,
  type ReportingReceipt,
} from './operationDiagnostic';

export interface ErrorReportingRuntime {
  initialize(): void;
  report: NonNullable<Parameters<typeof logger.setSentryReporter>[0]>;
  flush(timeoutMs: number): Promise<boolean>;
}
let runtime: ErrorReportingRuntime | undefined;
let available = false;
let initialized = false;
let consent = false;

export function configureErrorReportingRuntime(
  adapter: ErrorReportingRuntime,
  enabled: boolean,
  hasDsn: boolean,
): void {
  runtime = adapter;
  available = hasDsn;
  initialized = false;
  setErrorReportingEnabled(enabled);
}

/** Enabling after a disabled startup initializes the SDK and installs the reporter. */
export function setErrorReportingEnabled(enabled: boolean): void {
  consent = enabled;
  logger.setErrorReportingEnabled(false);
  if (!enabled || !available || !runtime) {
    return;
  }
  try {
    if (!initialized) {
      runtime.initialize();
      initialized = true;
    }
    logger.setSentryReporter(runtime.report);
    logger.setErrorReportingEnabled(true);
  } catch {
    logger.setSentryReporter(null);
    logger.warn('Error reporting initialization failed');
  }
}

/** SDK capture is synchronous; a returned identifier is not proof of remote delivery. */
export function reportOperationFailure(operation: OperationReport): ReportingReceipt {
  if (!consent) {
    return { state: 'not-reported', reason: 'disabled' };
  }
  if (!available) {
    return { state: 'not-reported', reason: 'unconfigured' };
  }
  if (!runtime || !initialized) {
    return { state: 'not-reported', reason: 'unavailable' };
  }
  try {
    const eventId = runtime.report({
      level: 'error',
      message: 'Operation failed',
      logs: [],
      operation,
    });
    const receipt = ReportingReceiptSchema.safeParse({ state: 'captured', eventId });
    return receipt.success ? receipt.data : { state: 'not-reported', reason: 'unavailable' };
  } catch {
    return { state: 'failed' };
  }
}

/** A transport that ignores its SDK deadline must not retain profile ownership. */
export async function flushErrorReporting(timeoutMs = 2_000): Promise<void> {
  if (!runtime || !initialized) {
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      runtime.flush(timeoutMs),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } catch {
    logger.warn('Error reporting flush failed');
  } finally {
    clearTimeout(timer);
    consent = false;
    logger.setErrorReportingEnabled(false);
  }
}

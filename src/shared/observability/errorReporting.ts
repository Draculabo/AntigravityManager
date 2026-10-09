import { logger } from '@/shared/logging/logger';

export interface ErrorReportingRuntime {
  initialize(): void;
  report: NonNullable<Parameters<typeof logger.setSentryReporter>[0]>;
  flush(timeoutMs: number): Promise<boolean>;
}
let runtime: ErrorReportingRuntime | undefined;
let available = false;
let initialized = false;

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
    logger.setErrorReportingEnabled(false);
  }
}

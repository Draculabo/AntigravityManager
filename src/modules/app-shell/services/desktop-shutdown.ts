export interface DesktopShutdownDependencies {
  stopMonitor(): void;
  drainWarmups(): Promise<void>;
  drainAccountSwitches(): Promise<void>;
  stopAuth(): Promise<unknown>;
  stopGateway(): Promise<unknown>;
  destroyTray(): void;
  exit(): void;
  warn(message: string): void;
  cleanupTimeoutMs?(): number;
}

/** Shares one bounded teardown between tray exit and Electron's normal quit path. */
export function createDesktopShutdownCoordinator(dependencies: DesktopShutdownDependencies) {
  let shutdown: Promise<void> | null = null;

  return {
    request(): Promise<void> {
      if (shutdown) {
        return shutdown;
      }

      dependencies.stopMonitor();
      shutdown = (async () => {
        const authStopped = Promise.resolve().then(() => dependencies.stopAuth());
        const warmupsDrained = dependencies.drainWarmups();
        const switchesDrained = dependencies.drainAccountSwitches();
        const cleanup = Promise.all([authStopped, warmupsDrained, switchesDrained])
          .then(() => dependencies.stopGateway())
          .catch(() => {
            dependencies.warn('Desktop shutdown cleanup failed; forcing exit');
          });
        let timeout: NodeJS.Timeout | undefined;
        const timeoutMs = dependencies.cleanupTimeoutMs?.() ?? 3000;
        const timeoutReached = new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, timeoutMs);
        });

        const result = await Promise.race([
          cleanup.then(() => 'cleaned' as const),
          timeoutReached.then(() => 'timeout' as const),
        ]);
        if (timeout) {
          clearTimeout(timeout);
        }
        if (result === 'timeout') {
          dependencies.warn(
            `Desktop shutdown cleanup timed out after ${timeoutMs}ms; forcing exit`,
          );
        }

        dependencies.destroyTray();
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 100);
        });
        dependencies.exit();
      })();

      return shutdown;
    },
  };
}

import type { LoggerService } from '@nestjs/common';
import { generationDeadlineAt } from './generation-deadline';

export function createStreamIdleTimer(
  logger: Pick<LoggerService, 'error'>,
  upstream: NodeJS.ReadableStream,
  label: string,
  onTimeout: () => void,
  timeoutMs = 300_000,
  signal?: AbortSignal,
) {
  let timer: NodeJS.Timeout | undefined;

  const clear = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const destroyUpstream = (): void => {
    if ('destroy' in upstream && typeof upstream.destroy === 'function') {
      upstream.destroy();
    }
  };

  return {
    reset: () => {
      clear();
      if (generationDeadlineAt(signal) !== undefined) {
        return;
      }
      timer = setTimeout(() => {
        logger.error(
          `[${label}] Idle timeout after ${Math.round(timeoutMs / 1000)}s, terminating stream`,
        );
        onTimeout();
        destroyUpstream();
      }, timeoutMs);
    },
    clear,
    dispose: () => {
      clear();
      destroyUpstream();
    },
  };
}

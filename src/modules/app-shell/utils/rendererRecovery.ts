import { app, BrowserWindow } from 'electron';

export type RendererGoneReason =
  | 'clean-exit'
  | 'abnormal-exit'
  | 'killed'
  | 'crashed'
  | 'oom'
  | 'launch-failed'
  | 'integrity-failure'
  | 'memory-eviction';

const RECOVERABLE_REASONS = new Set<RendererGoneReason>([
  'abnormal-exit',
  'killed',
  'crashed',
  'oom',
  'memory-eviction',
]);

export function shouldRecoverRenderer(reason: RendererGoneReason, isQuitting: boolean): boolean {
  return !isQuitting && RECOVERABLE_REASONS.has(reason);
}

export function installRendererRecovery(window: BrowserWindow): void {
  let isQuitting = false;
  let isRecovering = false;

  const markQuitting = () => {
    isQuitting = true;
  };
  app.once('before-quit', markQuitting);

  window.once('closed', () => {
    app.removeListener('before-quit', markQuitting);
  });

  window.webContents.on('did-finish-load', () => {
    isRecovering = false;
  });

  window.webContents.on('render-process-gone', (_event, details) => {
    if (
      isRecovering ||
      window.isDestroyed() ||
      !shouldRecoverRenderer(details.reason, isQuitting)
    ) {
      return;
    }

    isRecovering = true;
    window.webContents.reload();
  });
}

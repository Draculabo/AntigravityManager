import { ipcMain } from 'electron/main';
import { IPC_CHANNELS } from '@/shared/constants';
import { electronPerformanceRecorder, isPerformanceRecorderEnabled } from './main-recorder';
import { RendererPerformanceSnapshotSchema } from './types';

export function registerPerformanceRecorderIpc(): void {
  if (!isPerformanceRecorderEnabled()) {
    return;
  }

  ipcMain.handle(IPC_CHANNELS.START_PERFORMANCE_RECORDING, async (_event, label: unknown) => {
    const normalizedLabel = typeof label === 'string' ? label.slice(0, 64) : 'session';
    return electronPerformanceRecorder.start(normalizedLabel);
  });
  ipcMain.handle(IPC_CHANNELS.STOP_PERFORMANCE_RECORDING, async (_event, snapshot: unknown) => {
    return electronPerformanceRecorder.stop(RendererPerformanceSnapshotSchema.parse(snapshot));
  });
}

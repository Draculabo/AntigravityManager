import { AsyncLocalStorage } from 'node:async_hooks';
import type { IpcCaptureCapability } from './ipc-capture.schema';

const storage = new AsyncLocalStorage<{ endpoint: string; capability: IpcCaptureCapability }>();
export function runWithRemoteIpcCapture<T>(
  endpoint: string,
  capability: IpcCaptureCapability,
  work: () => T,
): T {
  return storage.run({ endpoint, capability }, work);
}
export function getRemoteIpcCapture(endpoint: string): IpcCaptureCapability | undefined {
  const context = storage.getStore();
  if (context && context.endpoint !== endpoint) {
    throw new Error('IPC capture owner changed during the request');
  }
  return context?.capability;
}

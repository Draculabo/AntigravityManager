import { ipc } from '@/ipc/manager';

export function getAntigravityClientCachePaths() {
  return ipc.client.antigravityClientCache.paths();
}

export function clearAntigravityClientCache() {
  return ipc.client.antigravityClientCache.clear();
}

import { ipc } from '@/ipc/manager';
import type { AntigravityAppTarget } from '@/shared/platform/antigravityAppTarget';

export function openLogDirectory() {
  return ipc.client.system.openLogDirectory();
}

export function selectAntigravityExecutable(target?: AntigravityAppTarget) {
  return ipc.client.system.selectAntigravityExecutable({ target });
}

export function selectAgyCliExecutable() {
  return ipc.client.system.selectAgyCliExecutable();
}

export function detectAgyCliExecutable() {
  return ipc.client.agyBinaryPatch.detectExecutable({ bypassConfig: true });
}

export function patchConfiguredAgyBinary() {
  return ipc.client.agyBinaryPatch.patchConfigured();
}

export function getAntigravityArgs(target?: AntigravityAppTarget) {
  return ipc.client.system.getAntigravityArgs({ target });
}

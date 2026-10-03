import { getConfiguredAntigravityExecutablePath, isWsl } from '@/shared/platform/paths';
import type { GuiTarget } from './types';

/** WSL can launch either a Linux app or a mounted Windows executable. */
export function usesWindowsRuntime(target: GuiTarget, executablePath?: string): boolean {
  if (process.platform === 'win32') {
    return true;
  }
  if (!isWsl()) {
    return false;
  }
  const executable = executablePath ?? getConfiguredAntigravityExecutablePath(target, false);
  // Preserve Windows discovery when no explicit Linux installation has been selected.
  return !executable || /^(?:[a-z]:[\\/]|\/mnt\/[a-z]\/).*\.exe$/i.test(executable);
}

import { afterEach, expect, it, vi } from 'vitest';
import { usesWindowsRuntime } from '@/modules/antigravity-runtime/runtimePlatform';

vi.mock('@/shared/platform/paths', () => ({
  isWsl: () => true,
  getConfiguredAntigravityExecutablePath: () => null,
}));
const platform = process.platform;
afterEach(() =>
  Object.defineProperty(process, 'platform', { value: platform, configurable: true }),
);

it('selects native Linux and Windows interop independently for each configured WSL target', () => {
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  expect([
    usesWindowsRuntime('classic', '/opt/Antigravity/antigravity'),
    usesWindowsRuntime('ide', '/mnt/c/Apps/Antigravity IDE.exe'),
    usesWindowsRuntime('classic', 'C:\\Apps\\Antigravity.exe'),
    usesWindowsRuntime('classic'),
  ]).toEqual([false, true, true, true]);
});

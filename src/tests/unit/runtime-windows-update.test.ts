import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertNoWindowsUpdate } from '@/modules/antigravity-runtime/windowsUpdate';

const query = vi.hoisted(() => vi.fn());
vi.mock('@/shared/platform/nativeProcessQuery', () => ({ readNativeProcessSnapshot: query }));
const platform = process.platform;
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
});

describe('Windows client update guard', () => {
  it.each(['Antigravity-x64.exe', 'Antigravity-arm64.exe'])(
    'blocks Classic startup during %s',
    async (name) => {
      query.mockResolvedValue([{ pid: 10, name, cmd: [], startTime: 1n }]);
      await expect(assertNoWindowsUpdate('classic')).rejects.toMatchObject({
        messageKey: 'process-runtime.update-in-progress',
      });
      expect(query).toHaveBeenCalledExactlyOnceWith(1000);
    },
  );
  it('keeps Classic and IDE update checks separate', async () => {
    query.mockResolvedValue([{ pid: 10, name: 'Antigravity IDE-x64.exe', cmd: [], startTime: 1n }]);
    await expect(assertNoWindowsUpdate('classic')).resolves.toBeUndefined();
    await expect(assertNoWindowsUpdate('ide')).rejects.toMatchObject({
      messageKey: 'process-runtime.update-in-progress',
    });
  });
  it('permits a fresh startup after the installer exits', async () => {
    query
      .mockResolvedValueOnce([{ pid: 10, name: 'Antigravity-x64.exe', cmd: [], startTime: 1n }])
      .mockResolvedValueOnce([]);
    await expect(assertNoWindowsUpdate('classic')).rejects.toMatchObject({
      messageKey: 'process-runtime.update-in-progress',
    });
    await expect(assertNoWindowsUpdate('classic')).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(2);
  });
  it('does not treat an unreadable process query as confirmation that updates finished', async () => {
    query.mockRejectedValue(new Error('private diagnostics'));
    await expect(assertNoWindowsUpdate('classic')).rejects.toMatchObject({
      messageKey: 'process-runtime.probe-failed',
      message: 'Antigravity process operation: probe-failed',
    });
  });
  it.each(['linux', 'darwin'])('does not query Windows installers on %s', async (value) => {
    Object.defineProperty(process, 'platform', { value, configurable: true });
    await expect(assertNoWindowsUpdate('classic')).resolves.toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });
});

import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  getAntigravityClientCachePaths: vi.fn(),
  clearAntigravityClientCache: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('@/modules/antigravity-runtime/actions/cache', () => mocks);
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { AntigravityClientCacheSettings } from '@/modules/antigravity-runtime/components/AntigravityClientCacheSettings';
beforeEach(() => {
  vi.resetAllMocks();
  mocks.getAntigravityClientCachePaths.mockResolvedValue(['/synthetic/cache']);
});
afterEach(cleanup);
describe('client cache confirmation', () => {
  it('does not reopen a dismissed dialog after its location read finishes', async () => {
    const deferred = Promise.withResolvers<string[]>();
    mocks.getAntigravityClientCachePaths.mockReturnValue(deferred.promise);
    render(createElement(AntigravityClientCacheSettings));
    fireEvent.click(screen.getByRole('button', { name: 'settings.cache.clear' }));
    await screen.findByRole('status');
    fireEvent.click(screen.getByRole('button', { name: 'settings.cache.cancel' }));
    await act(async () => deferred.resolve(['/synthetic/cache']));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mocks.clearAntigravityClientCache).not.toHaveBeenCalled();
  });
  it('distinguishes an unreadable location from missing cache and requires a successful retry', async () => {
    mocks.getAntigravityClientCachePaths.mockRejectedValueOnce(new Error('private-path'));
    render(createElement(AntigravityClientCacheSettings));
    fireEvent.click(screen.getByRole('button', { name: 'settings.cache.clear' }));
    expect((await screen.findByRole('alert')).textContent).toContain('settings.cache.paths-failed');
    expect(screen.queryByText('settings.cache.noPaths')).toBeNull();
    expect(screen.getByRole('button', { name: 'settings.cache.confirm' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.queryByText('private-path')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'action.retry' }));
    await screen.findByText('/synthetic/cache');
    expect(screen.getByRole('button', { name: 'settings.cache.confirm' })).not.toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'settings.cache.cancel' }));
    expect(mocks.clearAntigravityClientCache).not.toHaveBeenCalled();
  });
  it('runs cleanup once, blocks closing while pending and reports a partial result as a warning', async () => {
    const result = {
      clearedPaths: ['/synthetic/cache'],
      errors: ['Synthetic locked directory'],
      totalSizeFreed: 1024 * 1024,
    };
    const deferred = Promise.withResolvers<typeof result>();
    mocks.clearAntigravityClientCache.mockReturnValue(deferred.promise);
    render(createElement(AntigravityClientCacheSettings));
    fireEvent.click(screen.getByRole('button', { name: 'settings.cache.clear' }));
    await screen.findByText('/synthetic/cache');
    fireEvent.click(screen.getByRole('button', { name: 'settings.cache.confirm' }));
    expect(screen.getByRole('button', { name: 'common.close' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'settings.cache.cancel' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'settings.cache.clearing' }));
    expect(mocks.clearAntigravityClientCache).toHaveBeenCalledTimes(1);
    await act(async () => deferred.resolve(result));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocks.toast).toHaveBeenCalledWith({
      title: 'settings.cache.partial-title',
      description: 'settings.cache.partial-description',
      variant: 'warning',
    });
  });
});

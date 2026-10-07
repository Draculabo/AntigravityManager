import { createRouterClient } from '@orpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openReleaseNotesLink, releaseNotes } from '@/modules/app-shell/ipc/app/releaseNotes';

const { getReleaseNotes, openExternal } = vi.hoisted(() => ({
  getReleaseNotes: vi.fn(),
  openExternal: vi.fn(),
}));
vi.mock('@/modules/app-shell/update/releaseNotesService', () => ({ getReleaseNotes }));
vi.mock('electron', () => ({ shell: { openExternal } }));

const client = createRouterClient({ releaseNotes, openReleaseNotesLink });

beforeEach(() => vi.clearAllMocks());

describe('release-note IPC operations', () => {
  it('validates the target and carries only the typed description result', async () => {
    const result = {
      status: 'ready',
      tagName: 'v1.2.3',
      notes: 'Published changes',
      publishedAt: null,
    };
    getReleaseNotes.mockResolvedValue(result);
    expect(await client.releaseNotes({ tagName: 'v1.2.3' })).toEqual(result);
    await expect(client.releaseNotes({ tagName: '../another-resource' })).rejects.toThrow();
    expect(getReleaseNotes).toHaveBeenCalledTimes(1);
  });

  it('validates external destinations before opening the browser', async () => {
    openExternal.mockResolvedValue(undefined);
    const url = 'https://github.com/Draculabo/AntigravityManager/compare/v1.0.0...v1.2.3';
    expect(await client.openReleaseNotesLink({ url })).toEqual({ status: 'opened' });
    expect(await client.openReleaseNotesLink({ url: 'https://other.example' })).toEqual({
      status: 'error',
    });
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(url);
  });

  it('returns a fixed result when the operating system cannot open the browser', async () => {
    openExternal.mockRejectedValue(new Error('OS details that must not cross IPC'));
    expect(await client.openReleaseNotesLink({ url: 'https://github.com/contributor' })).toEqual({
      status: 'error',
    });
  });
});

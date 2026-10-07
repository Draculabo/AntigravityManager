import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ReleaseNotesTargetSchema } from '@/modules/app-shell/update/releaseNotes.schema';
import { getReleaseNotes } from '@/modules/app-shell/update/releaseNotesService';

const { requestJson, warn } = vi.hoisted(() => ({ requestJson: vi.fn(), warn: vi.fn() }));
vi.mock('@/shared/http/axios-json-client', () => ({
  createAxiosHttpClient: () => ({ requestJson }),
}));
vi.mock('@/shared/logging/logger', () => ({ logger: { warn } }));

const tagName = 'v1.2.3';
const metadataUrl = `https://github.com/Draculabo/AntigravityManager/releases/download/${tagName}/updater.json`;
const apiUrl = `https://api.github.com/repos/Draculabo/AntigravityManager/releases/tags/${tagName}`;
const publishedAt = '2026-10-08T00:00:00Z';

function respondWith(...payloads: unknown[]) {
  requestJson.mockImplementation(async (_url: string, options: { responseSchema: z.ZodType }) => {
    const payload = payloads.shift();
    if (payload instanceof Error) {
      throw payload;
    }
    return options.responseSchema.parse(payload);
  });
}

describe('target release notes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('preserves the full target description from version-pinned metadata', async () => {
    const notes = '# Changes\n\n- "quoted" changes\\paths\n- 中文\n';
    respondWith({ version: '1.2.3', notes, pub_date: publishedAt });
    expect(await getReleaseNotes({ tagName })).toEqual({
      status: 'ready',
      tagName,
      notes,
      publishedAt,
    });
    expect(requestJson.mock.calls.map(([url]) => url)).toEqual([metadataUrl]);
  });

  it.each([
    { version: '1.2.3', notes: 'See release page for details.' },
    { version: '1.2.3' },
    { version: '1.2.4', notes: 'Wrong release' },
    { version: '1.2.3', notes: 123 },
    new Error('Metadata unavailable'),
  ])(
    'falls back to the exact tag for legacy, invalid, mismatched or unavailable metadata: %j',
    async (metadata) => {
      respondWith(metadata, {
        tag_name: tagName,
        body: 'Target changes',
        published_at: publishedAt,
        draft: false,
      });
      expect(await getReleaseNotes({ tagName })).toEqual({
        status: 'ready',
        tagName,
        notes: 'Target changes',
        publishedAt,
      });
      expect(requestJson.mock.calls.map(([url]) => url)).toEqual([metadataUrl, apiUrl]);
    },
  );

  it('represents an explicitly empty metadata description without another request', async () => {
    respondWith({ version: '1.2.3', notes: '' });
    expect(await getReleaseNotes({ tagName })).toEqual({
      status: 'empty',
      tagName,
      publishedAt: null,
    });
    expect(requestJson.mock.calls.map(([url]) => url)).toEqual([metadataUrl]);
  });

  it('represents a published release with a null body as empty', async () => {
    respondWith(new Error('No asset'), {
      tag_name: tagName,
      body: null,
      published_at: null,
      draft: false,
    });
    expect(await getReleaseNotes({ tagName })).toEqual({
      status: 'empty',
      tagName,
      publishedAt: null,
    });
  });

  it.each([
    { tag_name: 'v1.2.4', body: 'Wrong version', published_at: publishedAt, draft: false },
    { tag_name: tagName, body: 'Unpublished', published_at: null, draft: true },
    {
      tag_name: tagName,
      body: 'x'.repeat(256 * 1024 + 1),
      published_at: publishedAt,
      draft: false,
    },
    new Error('Provider failure with private diagnostics'),
  ])('returns a value-free error for an unusable target release', async (release) => {
    respondWith(new Error('No asset'), release);
    expect(await getReleaseNotes({ tagName })).toEqual({ status: 'error', tagName });
  });

  it('forwards cancellation and does not start the fallback after cancellation', async () => {
    const controller = new AbortController();
    requestJson.mockImplementation(async (_url, options) => {
      controller.abort();
      expect(options.request.signal.aborted).toBe(true);
      throw new Error('Cancelled');
    });
    expect(await getReleaseNotes({ tagName }, controller.signal)).toEqual({
      status: 'error',
      tagName,
    });
    expect(requestJson.mock.calls.map(([url]) => url)).toEqual([metadataUrl]);
  });

  it('rejects non-version input at the public request boundary', () => {
    for (const invalid of ['latest', '../v1.2.3', 'v1.2.3/other', 'https://example.com']) {
      expect(ReleaseNotesTargetSchema.safeParse({ tagName: invalid }).success).toBe(false);
    }
  });
});

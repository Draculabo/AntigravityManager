import { describe, expect, it } from 'vitest';
import { buildUpdaterMetadata } from '../../../scripts/generate-updater-metadata.mjs';

describe('published release metadata', () => {
  it('preserves multiline Markdown and serializes quotes, backslashes and Unicode safely', () => {
    const body = '# Changes\n\n- "Quotes" and \\paths\n- 中文\n\nFull changelog';
    const release = {
      tagName: 'v1.2.3',
      body,
      publishedAt: '2026-10-08T00:00:00Z',
      url: 'https://github.com/Draculabo/AntigravityManager/releases/tag/v1.2.3',
    };
    expect(JSON.parse(JSON.stringify(buildUpdaterMetadata(release)))).toEqual({
      version: '1.2.3',
      notes: body,
      pub_date: release.publishedAt,
      url: release.url,
    });
  });

  it('publishes an empty description rather than a placeholder for a null body', () => {
    expect(
      buildUpdaterMetadata({
        tagName: 'v1.2.3',
        body: null,
        publishedAt: '2026-10-08T00:00:00Z',
        url: 'https://github.com/Draculabo/AntigravityManager/releases/tag/v1.2.3',
      }),
    ).toEqual({
      version: '1.2.3',
      notes: '',
      pub_date: '2026-10-08T00:00:00Z',
      url: 'https://github.com/Draculabo/AntigravityManager/releases/tag/v1.2.3',
    });
  });

  it('rejects a release URL that does not identify the selected target', () => {
    expect(() =>
      buildUpdaterMetadata({
        tagName: 'v1.2.3',
        body: 'Changes',
        publishedAt: null,
        url: 'https://github.com/Draculabo/AntigravityManager/releases/tag/v1.2.4',
      }),
    ).toThrow('Release URL does not match');
  });
});

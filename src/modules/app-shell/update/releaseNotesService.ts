import axios from 'axios';
import semver from 'semver';
import { createAxiosHttpClient } from '@/shared/http/axios-json-client';
import { logger } from '@/shared/logging/logger';
import {
  GitHubReleaseNotesSchema,
  ReleaseNotesMetadataSchema,
  type ReleaseNotesResult,
  type ReleaseNotesTarget,
} from './releaseNotes.schema';
import { RELEASE_REPOSITORY_URL } from './releaseNotesLinks';

const http = createAxiosHttpClient(
  axios.create({
    timeout: 15_000,
    maxContentLength: 2 * 1024 * 1024,
    headers: { 'User-Agent': 'AntigravityManager', Accept: 'application/json' },
  }),
);

function toResult(tagName: string, notes: string, publishedAt: string | null): ReleaseNotesResult {
  if (!notes.trim()) {
    return { status: 'empty', tagName, publishedAt };
  }
  return { status: 'ready', tagName, notes, publishedAt };
}

/** The update's tag is fixed before retrieval: a newer release must never supply its description. */
export async function getReleaseNotes(
  target: ReleaseNotesTarget,
  signal?: AbortSignal,
): Promise<ReleaseNotesResult> {
  const { tagName } = target;
  const requestSignal = AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]);

  try {
    const metadata = await http.requestJson(
      `${RELEASE_REPOSITORY_URL}/releases/download/${encodeURIComponent(tagName)}/updater.json`,
      {
        operation: 'release-notes-metadata',
        responseSchema: ReleaseNotesMetadataSchema,
        request: { signal: requestSignal },
      },
    );
    if (
      semver.valid(metadata.version) === tagName.slice(1) &&
      metadata.notes !== undefined &&
      metadata.notes.trim() !== 'See release page for details.'
    ) {
      return toResult(tagName, metadata.notes, metadata.pub_date ?? null);
    }
  } catch {
    if (!requestSignal.aborted) {
      logger.warn(`ReleaseNotes: metadata unavailable for ${tagName}; trying the tagged release`);
    }
  }

  if (requestSignal.aborted) {
    return { status: 'error', tagName };
  }

  try {
    const release = await http.requestJson(
      `https://api.github.com/repos/Draculabo/AntigravityManager/releases/tags/${encodeURIComponent(tagName)}`,
      {
        operation: 'release-notes-github-api',
        responseSchema: GitHubReleaseNotesSchema,
        request: { signal: requestSignal, headers: { Accept: 'application/vnd.github+json' } },
      },
    );
    if (release.tag_name !== tagName || release.draft) {
      return { status: 'error', tagName };
    }
    return toResult(tagName, release.body ?? '', release.published_at);
  } catch {
    if (!requestSignal.aborted) {
      logger.warn(`ReleaseNotes: tagged release retrieval failed for ${tagName}`);
    }
    return { status: 'error', tagName };
  }
}

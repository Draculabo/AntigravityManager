import path from 'node:path';
import { z } from 'zod';
import { collectReleaseData, repositoryName } from './github-release-data.mjs';
import { readDocument, renderReleaseDocument } from './release-document.mjs';
import { verifyReviewedRange } from './release-source.mjs';

const ReleaseSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/),
  gitHead: z.string().regex(/^[a-f0-9]{40}$/),
});

/** Publish the reviewed release story, with statistics and attribution computed from its range. */
export async function generateNotes(_pluginConfig, context) {
  const parsed = ReleaseSchema.safeParse(context.nextRelease);
  if (!parsed.success) {
    throw new Error('Release notes require a semantic version and an exact release commit.');
  }
  const release = parsed.data;
  const document = await readDocument(
    path.join(context.cwd, 'release-notes', `v${release.version}.json`),
  );
  if (
    document.version !== release.version ||
    document.source.baseTag !== (context.lastRelease.gitTag || null)
  ) {
    throw new Error('Release document version/base does not match the semantic-release range.');
  }
  const commits = verifyReviewedRange(
    context.cwd,
    document.source,
    release.gitHead,
    release.version,
  );
  const data = await collectReleaseData({
    repository: repositoryName(context.options.repositoryUrl),
    baseTag: document.source.baseTag,
    headSha: release.gitHead,
    commits,
    branch: context.branch.name,
    env: context.env,
  });
  return renderReleaseDocument(document, data);
}

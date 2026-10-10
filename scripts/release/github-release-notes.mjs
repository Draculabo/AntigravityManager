import { z } from 'zod';
import { collectReleaseData, repositoryName } from './github-release-data.mjs';
import { renderReleaseDocument } from './release-document.mjs';
import { sourceCommits } from './release-source.mjs';
import { createAutomaticStory } from './automatic-release-story.mjs';

const ReleaseSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/),
  gitHead: z.string().regex(/^[a-f0-9]{40}$/),
});

/** Generate the release story inside semantic-release from its exact source range. */
export async function generateNotes(_pluginConfig, context) {
  const parsed = ReleaseSchema.safeParse(context.nextRelease);
  if (!parsed.success) {
    throw new Error('Release notes require a semantic version and an exact release commit.');
  }
  const release = parsed.data;
  const baseTag = context.lastRelease.gitTag || null;
  const commits = sourceCommits(context.cwd, baseTag, release.gitHead, release.version);
  const data = await collectReleaseData({
    repository: repositoryName(context.options.repositoryUrl),
    baseTag,
    headSha: release.gitHead,
    commits,
    branch: context.branch.name,
    env: context.env,
  });
  return renderReleaseDocument(createAutomaticStory(release.version, data), data);
}

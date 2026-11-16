import { commitTrailer } from './release-candidate.mjs';

export function recordingPlugins(plugins, candidate) {
  return plugins.map((plugin) => {
    if (plugin === './scripts/release/github-release-notes.mjs') {
      return ['./scripts/release/candidate-release-plugin.mjs', { candidate }];
    }
    if (Array.isArray(plugin) && plugin[0] === '@semantic-release/git') {
      return [
        plugin[0],
        { ...plugin[1], message: `${plugin[1].message}\n\n${commitTrailer(candidate)}` },
      ];
    }
    return plugin;
  });
}

export function verifyRelease({ candidate }, { branch, nextRelease, lastRelease }) {
  if (
    branch.name !== candidate.channel ||
    nextRelease.gitHead !== candidate.source ||
    nextRelease.gitTag !== candidate.tag ||
    (lastRelease.gitTag || null) !== candidate.previousTag
  ) {
    throw new Error(`The release candidate ${candidate.tag} at ${candidate.source} is stale`);
  }
}

export function generateNotes({ candidate }) {
  return candidate.notes;
}

/**
 * Semantic Release Configuration
 *
 * Analyze Conventional Commits for version selection and automatically publish
 * release notes with verified source references and contributor attribution.
 */

const releaseRules = [
  {
    release: 'minor',
    type: 'feat',
  },
  {
    release: 'patch',
    type: 'fix',
  },
  {
    release: 'patch',
    type: 'perf',
  },
  {
    release: 'patch',
    type: 'style',
  },
  {
    release: 'patch',
    type: 'refactor',
  },
  {
    release: 'patch',
    type: 'build',
  },
  { release: 'patch', scope: 'README', type: 'docs' },
  { release: 'patch', scope: 'README.md', type: 'docs' },
  { release: false, type: 'docs' },
  {
    release: false,
    type: 'test',
  },
  {
    release: false,
    type: 'ci',
  },
  {
    release: false,
    type: 'chore',
  },
  {
    release: false,
    type: 'wip',
  },
  {
    release: 'major',
    type: 'BREAKING CHANGE',
  },
  {
    release: 'major',
    scope: 'BREAKING CHANGE',
  },
  {
    release: 'major',
    subject: '*BREAKING CHANGE*',
  },
  { release: 'patch', subject: '*force release*' },
  { release: 'patch', subject: '*force patch*' },
  { release: 'minor', subject: '*force minor*' },
  { release: 'major', subject: '*force major*' },
  { release: false, subject: '*skip release*' },
];

const releaseConfig = {
  branches: ['main', { name: 'beta', prerelease: true }],
  plugins: [
    [
      '@semantic-release/commit-analyzer',
      {
        preset: 'conventionalcommits',
        releaseRules: releaseRules,
      },
    ],
    './scripts/release/github-release-notes.mjs',
    [
      '@semantic-release/changelog',
      {
        changelogFile: 'CHANGELOG.md',
        changelogTitle: '<a name="readme-top"></a>\n\n# Changelog',
      },
    ],
    '@semantic-release/npm', // Updates package.json and npm-shrinkwrap.json
    [
      '@semantic-release/github',
      {
        successComment: false,
        failComment: false,
        labels: false,
        releaseNameTemplate: 'v<%= nextRelease.version %>',
      },
    ],
    [
      '@semantic-release/git',
      {
        assets: ['CHANGELOG.md', 'package.json', 'package-lock.json', 'npm-shrinkwrap.json'],
        message: 'chore(release): ${nextRelease.version}\n\n${nextRelease.notes}',
      },
    ],
  ],
};

module.exports = releaseConfig;

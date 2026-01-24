/**
 * Semantic Release Configuration
 *
 * This configuration uses the specific release rules requested by the user,
 * but adapts the plugin configuration to work with standard Conventional Commits
 * instead of Gitmoji (since the project history doesn't use emojis).
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

module.exports = {
  branches: ['main', 'master'],
  plugins: [
    [
      '@semantic-release/commit-analyzer',
      {
        preset: 'conventionalcommits',
        releaseRules: releaseRules,
      },
    ],
    [
      '@semantic-release/release-notes-generator',
      {
        preset: 'conventionalcommits',
        presetConfig: {
          types: [
            { type: 'feat', section: '✨ Features' },
            { type: 'fix', section: '🐛 Bug Fixes' },
            { type: 'perf', section: '⚡ Performance Improvements' },
            { type: 'revert', section: '⏪ Reverts' },
            { type: 'docs', section: '📝 Documentation' },
            { type: 'style', section: '💄 Styles' },
            { type: 'refactor', section: '♻️ Code Refactoring' },
            { type: 'test', section: '✅ Tests' },
            { type: 'build', section: '👷 Build System' },
            { type: 'ci', section: '🔧 Continuous Integration' },
          ],
        },
      },
    ],
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
        releaseName: 'v${nextRelease.version}',
      },
    ],
    [
      '@semantic-release/git',
      {
        assets: ['CHANGELOG.md', 'package.json', 'package-lock.json', 'npm-shrinkwrap.json'],
        message: 'chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}',
      },
    ],
  ],
};

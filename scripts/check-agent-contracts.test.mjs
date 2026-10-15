import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateAgentContracts } from './check-agent-contracts.mjs';

const REQUIRED_GOVERNANCE_FILES = [
  'AGENTS.md',
  'docs/AGENTS.md',
  'docs/architecture.md',
  'docs/development.md',
  'docs/security.md',
  'docs/testing.md',
  'docs/error-handling.md',
  'docs/test-reliability.md',
  'scripts/AGENTS.md',
  'scripts/README.md',
  'lefthook.yml',
  'src/modules/AGENTS.md',
  'src/modules/proxy-gateway/AGENTS.md',
  'src/shared/persistence/AGENTS.md',
  '.agents/notes/README.md',
  '.agents/skills/agm-code-review/SKILL.md',
  '.agents/skills/agm-validate-change/SKILL.md',
];

async function writeFixtureFile(rootDir, relativePath, content) {
  const filePath = path.join(rootDir, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}

async function createValidFixture() {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'agm-agent-contracts-'));

  await writeFixtureFile(
    rootDir,
    'package.json',
    JSON.stringify({ scripts: { 'check:agent-contracts': 'node check.mjs' } }),
  );

  for (const relativePath of REQUIRED_GOVERNANCE_FILES) {
    await writeFixtureFile(rootDir, relativePath, '# Reference\n');
  }

  await writeFixtureFile(
    rootDir,
    'AGENTS.md',
    '# Instructions\n\nSee [architecture](docs/architecture.md). Run `npm run check:agent-contracts`.\n',
  );

  return rootDir;
}

test('accepts a complete governance fixture', async (context) => {
  const rootDir = await createValidFixture();
  context.after(async () => rm(rootDir, { recursive: true, force: true }));

  assert.deepEqual(validateAgentContracts(rootDir), { errors: [] });
});

test('requires the semantic review skill', async (context) => {
  const rootDir = await createValidFixture();
  context.after(async () => rm(rootDir, { recursive: true, force: true }));
  await rm(path.join(rootDir, '.agents/skills/agm-code-review/SKILL.md'));

  assert.deepEqual(validateAgentContracts(rootDir), {
    errors: ['missing required governance file: .agents/skills/agm-code-review/SKILL.md'],
  });
});

test('requires script instructions and failure/reliability references', async (context) => {
  const rootDir = await createValidFixture();
  context.after(async () => rm(rootDir, { recursive: true, force: true }));
  for (const relativePath of [
    'docs/error-handling.md',
    'docs/test-reliability.md',
    'scripts/AGENTS.md',
    'scripts/README.md',
  ]) {
    await rm(path.join(rootDir, relativePath));
  }

  assert.deepEqual(validateAgentContracts(rootDir), {
    errors: [
      'missing required governance file: docs/error-handling.md',
      'missing required governance file: docs/test-reliability.md',
      'missing required governance file: scripts/AGENTS.md',
      'missing required governance file: scripts/README.md',
    ],
  });
});

test('checks links in the test reliability reference', async (context) => {
  const rootDir = await createValidFixture();
  context.after(async () => rm(rootDir, { recursive: true, force: true }));
  await writeFixtureFile(
    rootDir,
    'docs/test-reliability.md',
    '# Reliability\n\nSee [missing](missing.md).\n',
  );

  assert.deepEqual(validateAgentContracts(rootDir), {
    errors: ['docs/test-reliability.md: missing local link target: missing.md'],
  });
});

test('checks executable command references in the script guide', async (context) => {
  const rootDir = await createValidFixture();
  context.after(async () => rm(rootDir, { recursive: true, force: true }));
  await writeFixtureFile(
    rootDir,
    'scripts/README.md',
    '# Scripts\n\nRun `npm run check:missing`.\n',
  );

  assert.deepEqual(validateAgentContracts(rootDir), {
    errors: ['scripts/README.md: references missing npm script: check:missing'],
  });
});

test('rejects a broken local Markdown link', async (context) => {
  const rootDir = await createValidFixture();
  context.after(async () => rm(rootDir, { recursive: true, force: true }));
  await writeFixtureFile(
    rootDir,
    'docs/architecture.md',
    '# Architecture\n\nSee [missing](missing.md).\n',
  );

  assert.deepEqual(validateAgentContracts(rootDir), {
    errors: ['docs/architecture.md: missing local link target: missing.md'],
  });
});

test('rejects a reference to a missing npm script', async (context) => {
  const rootDir = await createValidFixture();
  context.after(async () => rm(rootDir, { recursive: true, force: true }));
  await writeFixtureFile(
    rootDir,
    'docs/development.md',
    '# Development\n\nRun `npm run check:missing`.\n',
  );

  assert.deepEqual(validateAgentContracts(rootDir), {
    errors: ['docs/development.md: references missing npm script: check:missing'],
  });
});

test('rejects an Agent Note whose status does not match its lifecycle', async (context) => {
  const rootDir = await createValidFixture();
  context.after(async () => rm(rootDir, { recursive: true, force: true }));
  await writeFixtureFile(
    rootDir,
    '.agents/notes/implemented/process/2026-08-25-example.md',
    [
      '# Agent Note: Example',
      '',
      'Status: proposed',
      '',
      '## Problem',
      '',
      '## Decision',
      '',
      '## Alternatives considered',
      '',
      '## Consequences',
      '',
      '## Verification',
      '',
    ].join('\n'),
  );

  assert.deepEqual(validateAgentContracts(rootDir), {
    errors: [
      'implemented/process/2026-08-25-example.md: status must match lifecycle "implemented"',
    ],
  });
});

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
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
  'docs/development/agent-skills.md',
  'docs/testing/agent-routing.md',
  'docs/upgrade-guides/README.md',
  'scripts/AGENTS.md',
  'scripts/README.md',
  'lefthook.yml',
  'src/modules/AGENTS.md',
  'src/modules/proxy-gateway/AGENTS.md',
  'src/shared/persistence/AGENTS.md',
  '.agents/notes/README.md',
  '.agents/lessons.md',
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
    const content = relativePath.endsWith('/SKILL.md')
      ? `---\nname: ${path.basename(path.dirname(relativePath))}\ndescription: Fixture workflow.\n---\n`
      : '# Reference\n';
    await writeFixtureFile(rootDir, relativePath, content);
  }

  await writeFixtureFile(
    rootDir,
    'scripts/agent-skills/policy.json',
    JSON.stringify({
      version: 1,
      roots: ['.agents/skills'],
      origins: [],
      mirrors: [],
    }),
  );
  await writeFixtureFile(
    rootDir,
    'scripts/agent-routing/cases.json',
    JSON.stringify({
      version: 1,
      cases: [
        {
          id: 'fixture',
          context: 'Read-only request.',
          messages: [{ role: 'user', text: 'Explain the module.' }],
          acceptedRoutes: ['Read-only.'],
          requiredActions: ['Inspect source.'],
          prohibitedActions: ['Edit files.'],
          sources: ['AGENTS.md'],
        },
      ],
    }),
  );

  await writeFixtureFile(
    rootDir,
    'AGENTS.md',
    '# Instructions\n\nSee [architecture](docs/architecture.md) and [Agent lessons](.agents/lessons.md). Run `pnpm run check:agent-contracts`.\n',
  );
  await writeFixtureFile(
    rootDir,
    '.agents/lessons.md',
    [
      '# Agent Lessons',
      '',
      '## When to capture',
      '',
      'Capture evidence-backed repeat prevention gaps.',
      '',
      '## Candidate format',
      '',
      'Use the required fields for every candidate.',
      '',
      '## Promotion',
      '',
      'Promote recurring lessons to their owning rule.',
      '',
      '## Active candidates',
      '',
      'No active candidates.',
      '',
    ].join('\n'),
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

test('rejects malformed skill metadata through the governance entry', async (context) => {
  const rootDir = await createValidFixture();
  context.after(() => rm(rootDir, { recursive: true, force: true }));
  await writeFixtureFile(
    rootDir,
    '.agents/skills/agm-code-review/SKILL.md',
    '# Missing metadata\n',
  );
  assert.deepEqual(validateAgentContracts(rootDir), {
    errors: ['.agents/skills/agm-code-review/SKILL.md: missing YAML frontmatter'],
  });
});

test('rejects mirror drift through the governance entry', async (context) => {
  const rootDir = await createValidFixture();
  context.after(() => rm(rootDir, { recursive: true, force: true }));
  await writeFixtureFile(
    rootDir,
    'scripts/agent-skills/policy.json',
    JSON.stringify({
      version: 1,
      roots: ['.agents/skills', '.codex/skills', '.claude/skills'],
      origins: [],
      mirrors: [
        {
          roots: ['.codex/skills', '.claude/skills'],
          prefix: 'openspec-',
          owner: 'OpenSpec CLI',
          reason: 'Generated entries.',
          removeWhen: 'The generator uses a common entry.',
        },
      ],
    }),
  );
  const entry = '---\nname: example\ndescription: Fixture workflow.\n---\n';
  await writeFixtureFile(rootDir, '.codex/skills/openspec-example/SKILL.md', entry);
  await writeFixtureFile(rootDir, '.claude/skills/openspec-example/SKILL.md', `${entry}Drift\n`);
  assert.deepEqual(validateAgentContracts(rootDir), {
    errors: [
      '.codex/skills/openspec-example/SKILL.md <> .claude/skills/openspec-example/SKILL.md: mirror entry content differs (OpenSpec CLI)',
    ],
  });
  const cli = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./check-agent-contracts.mjs', import.meta.url)), rootDir],
    {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    },
  );
  assert.equal(cli.status, 1, cli.stderr);
  assert.match(cli.stderr, /mirror entry content differs/);
});

test('does not read a required skill body through an external link', async (context) => {
  const rootDir = await createValidFixture();
  const external = await mkdtemp(path.join(tmpdir(), 'agm-external-entry-'));
  context.after(() => rm(rootDir, { recursive: true, force: true }));
  context.after(() => rm(external, { recursive: true, force: true }));
  await writeFixtureFile(
    external,
    'SKILL.md',
    '---\nname: external\ndescription: External.\n---\n[Private reference](missing-outside.md)\n',
  );
  const directory = path.join(rootDir, '.agents/skills/agm-code-review');
  await rm(directory, { recursive: true });
  await symlink(external, directory, 'junction');
  assert.deepEqual(validateAgentContracts(rootDir), {
    errors: [
      '.agents/skills/agm-code-review/SKILL.md: managed path resolves outside the repository',
    ],
  });
});

test('requires the lessons route for triggered failure reviews', async (context) => {
  const rootDir = await createValidFixture();
  context.after(async () => rm(rootDir, { recursive: true, force: true }));
  await writeFixtureFile(
    rootDir,
    'AGENTS.md',
    '# Instructions\n\nSee [architecture](docs/architecture.md). Run `pnpm run check:agent-contracts`.\n',
  );

  assert.deepEqual(validateAgentContracts(rootDir), {
    errors: ['AGENTS.md must link triggered failure reviews to .agents/lessons.md'],
  });
});

test('rejects a routing corpus with a missing rubric through the governance entry', async (context) => {
  const rootDir = await createValidFixture();
  context.after(() => rm(rootDir, { recursive: true, force: true }));
  await writeFixtureFile(rootDir, 'scripts/agent-routing/cases.json', '{"version":1,"cases":[{}]}');
  const result = validateAgentContracts(rootDir);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /^scripts\/agent-routing\/cases.json:/);
});

test('requires evidence and a prevention check for every active lesson candidate', async (context) => {
  const rootDir = await createValidFixture();
  context.after(async () => rm(rootDir, { recursive: true, force: true }));
  await writeFixtureFile(
    rootDir,
    '.agents/lessons.md',
    [
      '# Agent Lessons',
      '',
      '## When to capture',
      'Capture evidenced gaps.',
      '## Candidate format',
      'Use all required fields.',
      '## Promotion',
      'Promote recurring rules.',
      '## Active candidates',
      '### Candidate: ci-fixture-portability',
      '- **Rule:** Keep platform policy fixtures explicit.',
      '- **Cause:** Host platform was assumed.',
      '- **Prevention:** [Run the targeted suite](../docs/testing.md).',
      '- **Occurrences:** CI failure on Linux, 2026-10-15.',
      '- **Owner:** [Testing strategy](../docs/testing.md).',
      '- **Since:** 2026-10-15',
      '- **Applies while:** The test fixture depends on the host platform.',
      '',
    ].join('\n'),
  );

  assert.deepEqual(validateAgentContracts(rootDir), {
    errors: [
      '.agents/lessons.md: candidate "ci-fixture-portability" needs a non-empty Evidence field',
    ],
  });
});

test('accepts a complete active lesson candidate', async (context) => {
  const rootDir = await createValidFixture();
  context.after(async () => rm(rootDir, { recursive: true, force: true }));
  await writeFixtureFile(
    rootDir,
    '.agents/lessons.md',
    [
      '# Agent Lessons',
      '',
      '## When to capture',
      'Capture evidenced gaps.',
      '## Candidate format',
      'Use all required fields.',
      '## Promotion',
      'Promote recurring rules.',
      '## Active candidates',
      '### Candidate: ci-fixture-portability',
      '- **Rule:** Keep platform policy fixtures explicit.',
      '- **Evidence:** [Failing CI run](https://example.com/ci/123).',
      '- **Cause:** Host platform was assumed.',
      '- **Prevention:** [Run the targeted suite](../docs/testing.md).',
      '- **Occurrences:** 1 independent incident, 2026-10-15.',
      '- **Owner:** [Testing strategy](../docs/testing.md).',
      '- **Since:** 2026-10-15',
      '- **Applies while:** The test fixture depends on the host platform.',
      '',
    ].join('\n'),
  );

  assert.deepEqual(validateAgentContracts(rootDir), { errors: [] });
});

test('requires lesson applicability and a real ISO calendar date', async (context) => {
  const rootDir = await createValidFixture();
  context.after(() => rm(rootDir, { recursive: true, force: true }));
  const base =
    '# Agent Lessons\n## When to capture\n## Candidate format\n## Promotion\n## Active candidates\n' +
    '### Candidate: recurring-gap\n- **Rule:** Check ownership.\n- **Evidence:** Confirmed failure.\n' +
    '- **Cause:** Wrong owner.\n- **Prevention:** Exercise the owned check.\n' +
    '- **Occurrences:** 1 incident.\n- **Owner:** [Testing](../docs/testing.md).\n';
  await writeFixtureFile(rootDir, '.agents/lessons.md', base);
  assert.deepEqual(validateAgentContracts(rootDir), {
    errors: [
      '.agents/lessons.md: candidate "recurring-gap" needs a non-empty Since field',
      '.agents/lessons.md: candidate "recurring-gap" needs a non-empty Applies while field',
    ],
  });
  await writeFixtureFile(
    rootDir,
    '.agents/lessons.md',
    `${base}- **Since:** 2026-02-30\n- **Applies while:** The ownership mechanism remains.\n`,
  );
  assert.deepEqual(validateAgentContracts(rootDir), {
    errors: ['.agents/lessons.md: candidate "recurring-gap" Since must be a valid YYYY-MM-DD date'],
  });
  await writeFixtureFile(
    rootDir,
    '.agents/lessons.md',
    `${base}- **Since:** 2026-02-28\n- **Applies while:** The ownership mechanism remains.\n`,
  );
  assert.deepEqual(validateAgentContracts(rootDir), { errors: [] });
  await writeFixtureFile(
    rootDir,
    '.agents/lessons.md',
    `${base}- **Since:** 2026-02-28\n- **Applies while:** \t\n- **Extra:** Other text.\n`,
  );
  assert.deepEqual(validateAgentContracts(rootDir), {
    errors: ['.agents/lessons.md: candidate "recurring-gap" needs a non-empty Applies while field'],
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
    '# Scripts\n\nRun `pnpm run check:missing`.\n',
  );

  assert.deepEqual(validateAgentContracts(rootDir), {
    errors: ['scripts/README.md: references missing pnpm script: check:missing'],
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

test('rejects a reference to a missing pnpm script', async (context) => {
  const rootDir = await createValidFixture();
  context.after(async () => rm(rootDir, { recursive: true, force: true }));
  await writeFixtureFile(
    rootDir,
    'docs/development.md',
    '# Development\n\nRun `pnpm run check:missing`.\n',
  );

  assert.deepEqual(validateAgentContracts(rootDir), {
    errors: ['docs/development.md: references missing pnpm script: check:missing'],
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

test('accepts a frozen archive body and checks current reciprocal replacement metadata', async (context) => {
  const rootDir = await createValidFixture();
  context.after(() => rm(rootDir, { recursive: true, force: true }));
  const sections =
    '\n## Problem\nOriginal context.\n\n## Decision\nRecorded choice.\n\n## Alternatives considered\nAlternative.\n\n## Consequences\nEffect.\n\n## Verification\nObserved evidence.\n';
  await writeFixtureFile(
    rootDir,
    '.agents/notes/archived/process/2026-10-01-old.md',
    '# Agent Note: Old\n\nStatus: implemented\nArchived: 2026-10-15\nSuperseded by: [Current](../../implemented/process/2026-10-15-current.md)\n' +
      sections +
      '\nHistorical [path](removed.md) and `pnpm run removed-command`.\n',
  );
  await writeFixtureFile(
    rootDir,
    '.agents/notes/implemented/process/2026-10-15-current.md',
    '# Agent Note: Current\n\nStatus: implemented\nSupersedes: [Old](../../archived/process/2026-10-01-old.md)\n' +
      sections,
  );
  assert.deepEqual(validateAgentContracts(rootDir), { errors: [] });
  await writeFixtureFile(
    rootDir,
    '.agents/notes/implemented/process/2026-10-15-current.md',
    '# Agent Note: Current\n\nStatus: implemented\n' + sections,
  );
  assert.deepEqual(validateAgentContracts(rootDir), {
    errors: [
      '.agents/notes/archived/process/2026-10-01-old.md: replacement must link back with Supersedes.',
    ],
  });
});

test('proposed notes cannot be represented as completed archives', async (context) => {
  const rootDir = await createValidFixture();
  context.after(() => rm(rootDir, { recursive: true, force: true }));
  await writeFixtureFile(
    rootDir,
    '.agents/notes/archived/process/2026-10-01-old.md',
    '# Agent Note: Old\n\nStatus: proposed\nArchived: 2026-10-15\n\n## Problem\n## Decision\n## Alternatives considered\n## Consequences\n## Verification\n',
  );
  assert.deepEqual(validateAgentContracts(rootDir), {
    errors: [
      'archived/process/2026-10-01-old.md: status must match lifecycle "implemented"',
      '.agents/notes/archived/process/2026-10-01-old.md: a retired note must name one complete replacement.',
    ],
  });
});

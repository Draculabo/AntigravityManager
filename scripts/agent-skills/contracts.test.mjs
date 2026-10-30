import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspectSkills } from './contracts.mjs';

const entry =
  '---\nname: example\ndescription: Example workflow.\nmetadata:\n  author: openspec\n  generatedBy: "1.1.1"\n---\n\n# Example\n';

async function write(root, relative, content) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function fixture(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'agm-skills-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const policy = {
    version: 1,
    roots: ['.agents/skills', '.codex/skills', '.claude/skills'],
    origins: [],
    mirrors: [
      {
        roots: ['.codex/skills', '.claude/skills'],
        prefix: 'openspec-',
        owner: 'OpenSpec CLI',
        reason: 'Generated entry documents.',
        removeWhen: 'The generator adopts a shared entry.',
      },
    ],
  };
  await write(root, 'scripts/agent-skills/policy.json', JSON.stringify(policy));
  await write(
    root,
    '.agents/skills/local/SKILL.md',
    '---\nname: local\ndescription: Local workflow.\n---\n',
  );
  await write(root, '.codex/skills/openspec-example/SKILL.md', entry);
  await write(root, '.claude/skills/openspec-example/SKILL.md', entry);
  return { root, policy };
}

test('discovers project and generated skills without mutating entries', async (context) => {
  const { root } = await fixture(context);
  const report = inspectSkills(root);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.advisories, []);
  assert.deepEqual(
    report.skills.map(({ path: file, name, source, owner, generatedBy }) => ({
      path: file,
      name,
      source,
      owner,
      generatedBy,
    })),
    [
      {
        path: '.agents/skills/local/SKILL.md',
        name: 'local',
        source: 'project',
        owner: 'Antigravity Manager',
        generatedBy: null,
      },
      {
        path: '.codex/skills/openspec-example/SKILL.md',
        name: 'example',
        source: 'generated',
        owner: 'openspec',
        generatedBy: '1.1.1',
      },
      {
        path: '.claude/skills/openspec-example/SKILL.md',
        name: 'example',
        source: 'generated',
        owner: 'openspec',
        generatedBy: '1.1.1',
      },
    ],
  );
  assert.equal(
    await readFile(path.join(root, '.codex/skills/openspec-example/SKILL.md'), 'utf8'),
    entry,
  );
});

test('compares mirrors with normalized newlines and preserves harness-specific metadata', async (context) => {
  const { root } = await fixture(context);
  await write(root, '.claude/skills/openspec-example/SKILL.md', entry.replaceAll('\n', '\r\n'));
  await write(
    root,
    '.agents/skills/local/SKILL.md',
    '---\nname: local\ndescription: Local workflow.\ndisable-model-invocation: true\ncustom-harness-field: [a, b]\n---\n',
  );
  assert.deepEqual(inspectSkills(root).errors, []);
});

test('rejects a mirror body change and an entry present on only one side', async (context) => {
  const { root } = await fixture(context);
  await write(root, '.claude/skills/openspec-example/SKILL.md', `${entry}Changed body.\n`);
  await write(root, '.codex/skills/openspec-added/SKILL.md', entry);
  assert.deepEqual(inspectSkills(root).errors, [
    '.claude/skills/openspec-added/SKILL.md: missing valid mirror entry (OpenSpec CLI)',
    '.codex/skills/openspec-example/SKILL.md <> .claude/skills/openspec-example/SKILL.md: mirror entry content differs (OpenSpec CLI)',
  ]);
});

test('reports deleted mirror entries and missing declared roots', async (context) => {
  const { root } = await fixture(context);
  await rm(path.join(root, '.claude/skills'), { recursive: true });
  const report = inspectSkills(root);
  assert.equal(report.errors.length, 2);
  assert.match(report.errors[0], /^\.claude\/skills:/);
  assert.equal(
    report.errors[1],
    '.claude/skills/openspec-example/SKILL.md: missing valid mirror entry (OpenSpec CLI)',
  );
});

for (const [name, content, reason] of [
  ['missing frontmatter', '# Local\n', 'missing YAML frontmatter'],
  ['broken YAML', '---\nname: [\n---\n', 'invalid YAML frontmatter'],
  [
    'duplicate YAML keys',
    '---\nname: a\nname: b\ndescription: Text\n---\n',
    'invalid YAML frontmatter',
  ],
  [
    'blank description',
    '---\nname: local\ndescription: " "\n---\n',
    'frontmatter needs non-empty name and description and valid optional metadata',
  ],
  [
    'non-string name',
    '---\nname: 123\ndescription: Text\n---\n',
    'frontmatter needs non-empty name and description and valid optional metadata',
  ],
]) {
  test(`rejects ${name}`, async (context) => {
    const { root } = await fixture(context);
    await write(root, '.agents/skills/local/SKILL.md', content);
    assert.deepEqual(inspectSkills(root).errors, [`.agents/skills/local/SKILL.md: ${reason}`]);
  });
}

test('origin overrides identify installed upstream entries and reject stale targets', async (context) => {
  const { root, policy } = await fixture(context);
  policy.origins.push({ path: '.agents/skills/local', owner: 'Upstream package' });
  await write(root, 'scripts/agent-skills/policy.json', JSON.stringify(policy));
  assert.equal(inspectSkills(root).skills[0].source, 'upstream');
  assert.equal(inspectSkills(root).skills[0].owner, 'Upstream package');
  await rm(path.join(root, '.agents/skills/local/SKILL.md'));
  assert.deepEqual(inspectSkills(root).errors, [
    '.agents/skills/local: origin override has no valid skill entry',
  ]);
});

test('undeclared duplicate names are advisory and empty harness directories are ignored', async (context) => {
  const { root } = await fixture(context);
  await mkdir(path.join(root, '.claude/skills/empty'), { recursive: true });
  await write(
    root,
    '.claude/skills/independent/SKILL.md',
    '---\nname: local\ndescription: Another harness workflow.\n---\n',
  );
  const report = inspectSkills(root);
  assert.deepEqual(report.errors, []);
  assert.equal(report.skills.length, 4);
  assert.deepEqual(report.advisories, [
    '.agents/skills/local/SKILL.md <> .claude/skills/independent/SKILL.md: same name without a declared mirror; review invocation overlap',
  ]);
});

test('invalid policy paths are rejected before filesystem discovery', async (context) => {
  const { root, policy } = await fixture(context);
  policy.roots.push('../personal-skills');
  await write(root, 'scripts/agent-skills/policy.json', JSON.stringify(policy));
  const report = inspectSkills(root);
  assert.equal(report.skills.length, 0);
  assert.equal(report.errors.length, 1);
  assert.match(report.errors[0], /^scripts\/agent-skills\/policy.json:/);
});

test('links may share an internal entry but cannot expand the managed repository', async (context) => {
  const { root } = await fixture(context);
  const external = await mkdtemp(path.join(tmpdir(), 'agm-external-skill-'));
  context.after(() => rm(external, { recursive: true, force: true }));
  await write(external, 'SKILL.md', entry);
  await symlink(
    path.join(root, '.agents/skills/local'),
    path.join(root, '.claude/skills/linked'),
    'junction',
  );
  assert.deepEqual(inspectSkills(root).advisories, []);
  await symlink(external, path.join(root, '.claude/skills/external'), 'junction');
  assert.deepEqual(inspectSkills(root).errors, [
    '.claude/skills/external/SKILL.md: managed path resolves outside the repository',
  ]);
});

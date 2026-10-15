import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { validateDocumentLifecycle } from './agent-document-lifecycle.mjs';

const validator = fileURLToPath(new URL('./check-agent-contracts.mjs', import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agm document lifecycle '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const notes = [];
  const guides = [];
  return {
    root,
    async write(file, content) {
      const target = path.join(root, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
      if (file.startsWith('.agents/notes/') && !notes.includes(target)) {
        notes.push(target);
      }
      if (file.startsWith('docs/upgrade-guides/') && !guides.includes(target)) {
        guides.push(target);
      }
    },
    validate: () => validateDocumentLifecycle(root, notes, guides),
  };
}

const old = '.agents/notes/archived/process/2026-10-01-old.md';
const current = '.agents/notes/implemented/process/2026-10-15-current.md';
const oldText =
  '# Agent Note: Old\n\nStatus: implemented\nArchived: 2026-10-15\nSuperseded by: [Current](../../implemented/process/2026-10-15-current.md)\n\n';
const currentText =
  '# Agent Note: Current\n\nStatus: implemented\nSupersedes: [Old](../../archived/process/2026-10-01-old.md)\n\n';
const guide =
  '# Upgrade guide: Synthetic config rename\n\nTarget version: next\n\n## Affected users\nProfiles using the synthetic setting.\n\n## Required action\nRename the setting before startup.\n\n## Data and recovery\nBack up the original configuration; restore it if validation fails.\n\n## Downgrade\nRestore the original configuration before using the old release.\n\n## Verification\nA synthetic migration and reopen test checks the setting value.\n';

test('accepts a complete upgrade guide and matching release directory', async (t) => {
  const f = await fixture(t);
  await f.write('docs/upgrade-guides/next/config.md', guide);
  await f.write(
    'docs/upgrade-guides/0.26.0/config.md',
    guide.replace('Target version: next', 'Target version: 0.26.0'),
  );
  assert.deepEqual(f.validate(), []);
});

for (const section of [
  'Affected users',
  'Required action',
  'Data and recovery',
  'Downgrade',
  'Verification',
]) {
  test(`rejects a guide with placeholder ${section} instructions`, async (t) => {
    const f = await fixture(t);
    const sections = guide.split(/^## /m);
    const content = sections
      .map((part) => (part.startsWith(section + '\n') ? section + '\nTBD\n\n' : part))
      .join('## ');
    await f.write('docs/upgrade-guides/next/config.md', content);
    assert.deepEqual(f.validate(), [
      `docs/upgrade-guides/next/config.md: provide a nonempty "## ${section}" section.`,
    ]);
  });
}

test('rejects guide version/path mismatch and misplaced guides', async (t) => {
  const f = await fixture(t);
  await f.write('docs/upgrade-guides/0.26.0/config.md', guide);
  await f.write('docs/upgrade-guides/loose.md', guide);
  assert.deepEqual(f.validate(), [
    'docs/upgrade-guides/0.26.0/config.md: Target version must match its directory.',
    'docs/upgrade-guides/loose.md: guides belong in <next-or-version>/<topic>.md.',
    'docs/upgrade-guides/loose.md: Target version must match its directory.',
  ]);
});

test('accepts reciprocal supersession without rewriting the archived historical body', async (t) => {
  const f = await fixture(t);
  await f.write(old, oldText + '## Problem\n[Historical reference](gone.md).\n');
  await f.write(current, currentText);
  assert.deepEqual(f.validate(), []);
});

test('rejects a missing reverse relationship', async (t) => {
  const f = await fixture(t);
  await f.write(old, oldText);
  await f.write(current, '# Agent Note: Current\n\nStatus: implemented\n');
  assert.deepEqual(f.validate(), [`${old}: replacement must link back with Supersedes.`]);
});

test('rejects nonexistent or self-referential successor links', async (t) => {
  const f = await fixture(t);
  await f.write(
    current,
    '# Agent Note: Current\n\nStatus: implemented\nSuperseded by: [Self](2026-10-15-current.md)\n',
  );
  assert.deepEqual(f.validate(), [
    `${current}: Superseded by must link to a different existing Agent Note.`,
  ]);
});

test('reports malformed encoded replacement links without crashing the validator', async (t) => {
  const f = await fixture(t);
  await f.write(
    current,
    '# Agent Note: Current\n\nStatus: implemented\nSupersedes: [Invalid](%ZZ.md)\n',
  );
  assert.deepEqual(f.validate(), [
    `${current}: Supersedes must link to a different existing Agent Note.`,
  ]);
});

test('rejects archive dates that are not real calendar dates', async (t) => {
  const f = await fixture(t);
  await f.write(old, oldText.replace('Archived: 2026-10-15', 'Archived: 2026-02-30'));
  await f.write(current, currentText);
  assert.deepEqual(f.validate(), [
    `${old}: archived notes require one valid Archived: yyyy-mm-dd declaration.`,
  ]);
});

test('rejects supersession cycles', async (t) => {
  const f = await fixture(t);
  await f.write(
    old,
    oldText + 'Supersedes: [Current](../../implemented/process/2026-10-15-current.md)\n',
  );
  await f.write(
    current,
    currentText + 'Superseded by: [Old](../../archived/process/2026-10-01-old.md)\n',
  );
  assert.deepEqual(f.validate(), [
    `${old}: supersession must not form a cycle.`,
    `${current}: supersession must not form a cycle.`,
  ]);
});

test('preserves a valid multi-generation replacement chain', async (t) => {
  const f = await fixture(t);
  const middle = '.agents/notes/archived/process/2026-10-10-middle.md';
  await f.write(
    old,
    oldText.replace('../../implemented/process/2026-10-15-current.md', '2026-10-10-middle.md'),
  );
  await f.write(
    middle,
    '# Agent Note: Middle\n\nStatus: implemented\nArchived: 2026-10-15\nSupersedes: [Old](2026-10-01-old.md)\nSuperseded by: [Current](../../implemented/process/2026-10-15-current.md)\n',
  );
  await f.write(current, currentText.replace('2026-10-01-old.md', '2026-10-10-middle.md'));
  assert.deepEqual(f.validate(), []);
});

test('real governance CLI reports missing upgrade instructions as failure', async (t) => {
  const f = await fixture(t);
  await f.write(
    'docs/upgrade-guides/next/broken.md',
    '# Upgrade guide: Broken\n\nTarget version: next\n',
  );
  const result = spawnSync(process.execPath, [validator, f.root], {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /provide a nonempty "## Data and recovery" section/);
});

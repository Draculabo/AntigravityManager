import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateRoutingCases } from './contracts.mjs';

const relative = 'scripts/agent-routing/cases.json';
async function fixture(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'agm-routing-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'scripts/agent-routing'), { recursive: true });
  await writeFile(path.join(root, 'AGENTS.md'), '# Fixture instructions\n');
  const corpus = {
    version: 1,
    cases: [
      {
        id: 'explain-only',
        context: 'No mutation requested.',
        messages: [{ role: 'user', text: 'Explain this module.' }],
        acceptedRoutes: ['Read-only explanation.'],
        requiredActions: ['Inspect relevant source.'],
        prohibitedActions: ['Edit files.'],
        sources: ['AGENTS.md'],
      },
    ],
  };
  const save = () => writeFile(path.join(root, relative), JSON.stringify(corpus));
  await save();
  return { root, corpus, save };
}

test('the current corpus has valid structure and existing rule sources', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  assert.deepEqual(validateRoutingCases(root), []);
});

test('validates multi-turn fixtures without keyword classification', async (context) => {
  const { root, corpus, save } = await fixture(context);
  corpus.cases[0].messages.unshift(
    { role: 'user', text: 'Use the named workflow.' },
    { role: 'assistant', text: 'Ready to continue.' },
  );
  await save();
  const before = await readFile(path.join(root, relative), 'utf8');
  assert.deepEqual(validateRoutingCases(root), []);
  assert.equal(await readFile(path.join(root, relative), 'utf8'), before);
});

test('rejects a rubric without prohibited actions', async (context) => {
  const { root, corpus, save } = await fixture(context);
  corpus.cases[0].prohibitedActions = [];
  await save();
  const errors = validateRoutingCases(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /prohibitedActions/);
});

test('rejects duplicate ids and an assistant-ended conversation', async (context) => {
  const { root, corpus, save } = await fixture(context);
  corpus.cases.push(structuredClone(corpus.cases[0]));
  corpus.cases[1].messages.push({ role: 'assistant', text: 'Already answered.' });
  await save();
  assert.deepEqual(validateRoutingCases(root), [
    `${relative}: duplicate case id explain-only`,
    `${relative}: explain-only must end with a user request`,
  ]);
});

test('rejects stale and out-of-repository rule sources', async (context) => {
  const { root, corpus, save } = await fixture(context);
  corpus.cases[0].sources = ['removed.md', '../personal-instructions.md'];
  await save();
  const errors = validateRoutingCases(root);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /^scripts\/agent-routing\/cases.json: explain-only source removed.md:/);
  assert.equal(
    errors[1],
    `${relative}: explain-only has a non-relative source ../personal-instructions.md`,
  );
});

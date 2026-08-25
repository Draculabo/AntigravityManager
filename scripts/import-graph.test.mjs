import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collectImportGraph, collectRuntimeReachablePaths } from './import-graph.mjs';

function runGit(rootDir, args) {
  const result = spawnSync('git', args, { cwd: rootDir, encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
}

async function writeFixtureFile(rootDir, relativePath, content) {
  const filePath = path.join(rootDir, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}

async function createImportGraphFixture() {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'agm-import-graph-'));
  runGit(rootDir, ['init']);
  runGit(rootDir, ['config', 'user.name', 'Agent Test']);
  runGit(rootDir, ['config', 'user.email', 'agent-test@example.com']);
  await writeFixtureFile(
    rootDir,
    'tsconfig.json',
    JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }),
  );
  await writeFixtureFile(
    rootDir,
    'src/entry.ts',
    [
      "import { value } from '@/value';",
      "import type { Value } from '@/types';",
      "export { feature } from './feature';",
      "void import('./lazy');",
      "void require('node:fs');",
      'void value;',
    ].join('\n'),
  );
  await writeFixtureFile(rootDir, 'src/value.ts', 'export const value = 1;\n');
  await writeFixtureFile(rootDir, 'src/types.ts', 'export interface Value { value: number }\n');
  await writeFixtureFile(rootDir, 'src/feature.ts', 'export const feature = 1;\n');
  await writeFixtureFile(rootDir, 'src/lazy.ts', 'export const lazy = 1;\n');
  runGit(rootDir, ['add', '.']);
  runGit(rootDir, ['commit', '-m', 'fixture']);

  return rootDir;
}

test('resolves aliases and excludes type-only imports from runtime reachability', async (context) => {
  const rootDir = await createImportGraphFixture();
  context.after(async () => rm(rootDir, { recursive: true, force: true }));

  const graph = collectImportGraph(rootDir);

  assert.deepEqual(collectRuntimeReachablePaths(graph, ['src/entry.ts']), [
    'src/entry.ts',
    'src/feature.ts',
    'src/lazy.ts',
    'src/value.ts',
  ]);
});

test('analyzes the current worktree across unstaged deletes and untracked additions', async (context) => {
  const rootDir = await createImportGraphFixture();
  context.after(async () => rm(rootDir, { recursive: true, force: true }));
  await rm(path.join(rootDir, 'src/value.ts'));
  await writeFixtureFile(rootDir, 'src/replacement.ts', 'export const replacement = 2;\n');
  await writeFixtureFile(
    rootDir,
    'src/entry.ts',
    "import { replacement } from '@/replacement';\nvoid replacement;\n",
  );

  const graph = collectImportGraph(rootDir);

  assert.deepEqual(
    graph.files.map((file) => file.path),
    ['src/entry.ts', 'src/feature.ts', 'src/lazy.ts', 'src/replacement.ts', 'src/types.ts'],
  );
  assert.equal(graph.files[0].dependencies[0].target, 'src/replacement.ts');
});

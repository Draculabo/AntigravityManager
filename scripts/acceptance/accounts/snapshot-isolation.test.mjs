import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { assertSnapshotIsolation } from './snapshot-isolation.mjs';

const runner = fileURLToPath(new URL('../run.mjs', import.meta.url));

test('runner refuses inherited snapshot destinations before loading a native runtime', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-snapshot-isolation-'));
  try {
    const home = path.join(root, 'home');
    const agent = path.join(home, '.antigravity-agent');
    const external = path.join(root, 'original-snapshot.json');
    await fs.mkdir(agent, { recursive: true });
    await fs.writeFile(external, 'original fixture bytes');
    await fs.writeFile(
      path.join(agent, 'antigravity_accounts.json'),
      JSON.stringify({ fixture: { backup_file: external } }),
    );
    const accounts = path.join(root, 'accounts.json');
    await fs.writeFile(accounts, JSON.stringify(['fixture-a', 'fixture-b']));
    const args = [
      runner,
      'accounts',
      'switch',
      '--owner',
      'cli',
      '--target',
      'classic',
      '--local-snapshots',
      '--runtime-root',
      root,
      '--profile-home',
      home,
      '--accounts-file',
      accounts,
      '--output',
      path.join(root, 'report.json'),
    ];
    const options = { encoding: 'utf8', timeout: 15_000, maxBuffer: 100_000, windowsHide: true };
    const result = spawnSync(process.execPath, args, options);
    assert.equal(result.status, 1);
    assert.match(result.stdout + result.stderr, /fixture-snapshot-outside-profile/);
    assert.equal(await fs.readFile(external, 'utf8'), 'original fixture bytes');
    assert.equal(
      await fs.stat(path.join(root, 'report.json')).then(
        () => true,
        () => false,
      ),
      false,
    );
    await fs.writeFile(path.join(agent, 'antigravity_accounts.json'), 'private-fixture-identity {');
    const invalid = spawnSync(process.execPath, args, options);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stdout + invalid.stderr, /fixture-snapshot-index-invalid/);
    assert(!`${invalid.stdout}${invalid.stderr}`.includes('private-fixture-identity'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('snapshot isolation accepts new owned destinations and rejects linked external backups', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-snapshot-isolation-'));
  try {
    const home = path.join(root, 'home');
    const agent = path.join(home, '.antigravity-agent');
    const backups = path.join(agent, 'backups');
    const index = path.join(agent, 'antigravity_accounts.json');
    await fs.mkdir(agent, { recursive: true });
    await assertSnapshotIsolation(home);
    await fs.writeFile(
      index,
      JSON.stringify({ fixture: { backup_file: path.join(backups, 'new.json') } }),
    );
    await assertSnapshotIsolation(home);
    const original = path.join(root, 'original');
    await fs.mkdir(original);
    await fs.symlink(original, backups, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(assertSnapshotIsolation(home), /fixture-snapshot-outside-profile/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('snapshot isolation refuses relative and traversal destinations', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-snapshot-isolation-'));
  try {
    const agent = path.join(root, '.antigravity-agent');
    await fs.mkdir(agent);
    for (const destination of [
      'backups/file.json',
      path.join(agent, 'backups', '..', 'external.json'),
    ]) {
      await fs.writeFile(
        path.join(agent, 'antigravity_accounts.json'),
        JSON.stringify({ fixture: { backup_file: destination } }),
      );
      await assert.rejects(assertSnapshotIsolation(root), /fixture-snapshot-outside-profile/);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

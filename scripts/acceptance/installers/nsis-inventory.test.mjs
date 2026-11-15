import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createPackage } from '@electron/asar';

const run = promisify(execFile);
const entry = fileURLToPath(new URL('./nsis-inventory.mjs', import.meta.url));
const out = fileURLToPath(new URL('../../../out/', import.meta.url));

async function fixture(t) {
  await mkdir(out, { recursive: true });
  const parent = await realpath(out);
  const root = await mkdtemp(path.join(parent, 'nsis-inventory-test-'));
  t.after(async () => {
    const resolved = await realpath(root);
    assert.equal(path.dirname(resolved), parent);
    assert(path.basename(resolved).startsWith('nsis-inventory-test-'));
    await rm(resolved, { recursive: true });
  });
  const app = path.join(root, 'packed app');
  const installer = path.join(root, 'candidate installer.exe');
  const report = path.join(root, 'report.json');
  await mkdir(path.join(app, 'resources', 'standalone'), { recursive: true });
  await writeFile(installer, 'installer fixture');
  return {
    root,
    app,
    report,
    run: (output = report) =>
      run(process.execPath, [entry, app, installer, output], { timeout: 15_000, maxBuffer: 4000 }),
  };
}

function digest(text) {
  return createHash('sha256').update(text).digest('hex');
}

test('reports payload files and identifies duplicates by bytes rather than file size alone', async (t) => {
  const input = await fixture(t);
  const asarSource = path.join(input.root, 'asar-source');
  await mkdir(asarSource);
  await writeFile(path.join(asarSource, 'index.js'), 'module.exports = 1;');
  const archive = path.join(input.app, 'resources', 'app.asar');
  await createPackage(asarSource, archive);
  const asarBytes = (await stat(archive)).size;
  await writeFile(path.join(input.app, 'copy.bin'), 'same');
  await writeFile(path.join(input.app, 'resources', 'standalone', 'duplicate.bin'), 'same');
  await writeFile(path.join(input.app, 'resources', 'standalone', 'different.bin'), 'diff');

  await input.run();
  const output = await readFile(input.report, 'utf8');
  assert.deepEqual(JSON.parse(output), {
    schemaVersion: 1,
    installer: {
      name: 'candidate installer.exe',
      bytes: 17,
      sha256: digest('installer fixture'),
    },
    payload: {
      bytes: asarBytes + 12,
      files: 4,
      asar: { bytes: asarBytes, entries: 1 },
      groups: [
        { name: 'copy.bin', bytes: 4, files: 1 },
        { name: 'resources/app.asar', bytes: asarBytes, files: 1 },
        { name: 'resources/standalone', bytes: 8, files: 2 },
      ],
      duplicateBytes: 4,
      duplicateGroups: [
        {
          bytesPerFile: 4,
          sha256: digest('same'),
          paths: ['copy.bin', 'resources/standalone/duplicate.bin'],
        },
      ],
    },
  });

  const secondReport = path.join(input.root, 'second.json');
  await input.run(secondReport);
  assert.equal(await readFile(secondReport, 'utf8'), output);
  await assert.rejects(input.run(), /EEXIST/);
  assert.equal(await readFile(input.report, 'utf8'), output);
});

test('rejects an incomplete payload without writing a report', async (t) => {
  const input = await fixture(t);
  await assert.rejects(input.run(), /missing resources\/app\.asar/);
  await assert.rejects(readFile(input.report), { code: 'ENOENT' });
});

test('rejects a directory link inside the payload and also in the report path', async (t) => {
  const input = await fixture(t);
  const target = path.join(input.root, 'target');
  await mkdir(target);
  await writeFile(path.join(target, 'private-fixture.txt'), 'outside payload');
  const insideLink = path.join(input.app, 'linked-directory');
  const outputLink = path.join(input.root, 'linked-output');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  await symlink(target, insideLink, linkType);
  await symlink(target, outputLink, linkType);

  await assert.rejects(input.run(), /linked or unsupported entry/);
  await assert.rejects(
    input.run(path.join(outputLink, 'report.json')),
    /linked or unsupported entry/,
  );
  await assert.rejects(readFile(path.join(target, 'report.json')), { code: 'ENOENT' });
});

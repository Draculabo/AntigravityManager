import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, open, opendir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRawHeader } from '@electron/asar';

const maxEntries = 100_000;
const maxReportBytes = 16 * 1024 * 1024;
const maxAsarHeaderBytes = 16 * 1024 * 1024;

function relativeInside(root, target) {
  const relative = path.relative(root, target);
  assert(
    relative &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative),
    'Artifact paths must be below the repository out directory',
  );
  return relative;
}

async function inspectPath(target) {
  const info = await lstat(target);
  assert(info.isDirectory() || info.isFile(), 'Artifact contains a linked or unsupported entry');
  assert(!path.relative(target, await realpath(target)), 'Artifact contains a redirected entry');
  return info;
}

async function inspectBelow(root, target) {
  let current = root;
  for (const part of relativeInside(root, target).split(path.sep)) {
    current = path.join(current, part);
    await inspectPath(current);
  }
}

async function fileDigest(file) {
  const handle = await open(file, 'r');
  try {
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
    }
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

async function readAsarInventory(archive, bytes) {
  const handle = await open(archive, 'r');
  const prefix = Buffer.alloc(8);
  try {
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
    const headerBytes = prefix.readUInt32LE(4);
    assert(
      bytesRead === prefix.length &&
        prefix.readUInt32LE(0) === 4 &&
        headerBytes <= maxAsarHeaderBytes &&
        headerBytes <= bytes - prefix.length,
      'Application ASAR header is invalid or exceeds the inventory limit',
    );
  } finally {
    await handle.close();
  }

  const { header } = getRawHeader(archive);
  assert(header?.files && typeof header.files === 'object', 'Application ASAR has no file index');
  const directories = [header.files];
  let entries = 0;
  while (directories.length) {
    for (const entry of Object.values(directories.pop())) {
      assert(++entries <= maxEntries, 'Application ASAR exceeds the inventory entry limit');
      if (entry?.files && typeof entry.files === 'object') {
        directories.push(entry.files);
      }
    }
  }
  return { bytes, entries };
}

async function readPayloadInventory(payload) {
  const groups = new Map();
  const bySize = new Map();
  const directories = [payload];
  let entries = 0;
  let files = 0;
  let bytes = 0;
  let asar;
  while (directories.length) {
    const directory = directories.pop();
    for await (const entry of await opendir(directory)) {
      assert(++entries <= maxEntries, 'Packaged app exceeds the inventory entry limit');
      const absolute = path.join(directory, entry.name);
      const info = await inspectPath(absolute);
      if (info.isDirectory()) {
        directories.push(absolute);
        continue;
      }
      const relative = path.relative(payload, absolute).split(path.sep).join('/');
      const parts = relative.split('/');
      const name = parts[0] === 'resources' ? parts.slice(0, 2).join('/') : parts[0];
      const group = groups.get(name) ?? { name, bytes: 0, files: 0 };
      group.bytes += info.size;
      group.files++;
      groups.set(name, group);
      bytes += info.size;
      files++;
      const sameSize = bySize.get(info.size) ?? [];
      sameSize.push(relative);
      bySize.set(info.size, sameSize);
      if (relative === 'resources/app.asar') {
        asar = await readAsarInventory(absolute, info.size);
      }
    }
  }
  assert(asar && files > 0, 'Packaged app is missing resources/app.asar');

  const duplicateGroups = [];
  let duplicateBytes = 0;
  for (const [bytesPerFile, candidates] of bySize) {
    if (candidates.length < 2) {
      continue;
    }
    const byDigest = new Map();
    for (const candidate of candidates.sort()) {
      const digest = await fileDigest(path.join(payload, candidate));
      const matches = byDigest.get(digest) ?? [];
      matches.push(candidate);
      byDigest.set(digest, matches);
    }
    for (const [sha256, paths] of byDigest) {
      if (paths.length > 1) {
        duplicateGroups.push({ bytesPerFile, sha256, paths });
        duplicateBytes += bytesPerFile * (paths.length - 1);
      }
    }
  }
  duplicateGroups.sort((a, b) => b.bytesPerFile - a.bytesPerFile || (a.sha256 < b.sha256 ? -1 : 1));
  return {
    bytes,
    files,
    asar,
    groups: [...groups.keys()].sort().map((name) => groups.get(name)),
    duplicateBytes,
    duplicateGroups,
  };
}

assert.equal(
  process.argv.length,
  5,
  'Supply the packaged app directory, NSIS installer, and a new report JSON path',
);
const project = await realpath(fileURLToPath(new URL('../../../', import.meta.url)));
const out = path.join(project, 'out');
assert((await inspectPath(out)).isDirectory(), 'Repository out must be a directory');
const [payload, installer, output] = process.argv
  .slice(2)
  .map((argument) => path.resolve(argument));
assert(/\.exe$/i.test(installer), 'NSIS installer must be an .exe file');
assert(/\.json$/i.test(output), 'Inventory report must be a .json file');
relativeInside(out, output);
const withinPayload = path.relative(payload, output);
assert(
  withinPayload === '..' ||
    withinPayload.startsWith(`..${path.sep}`) ||
    path.isAbsolute(withinPayload),
  'Inventory report must be outside the packaged app directory',
);
await inspectBelow(out, payload);
await inspectBelow(out, installer);
if (path.relative(out, path.dirname(output))) {
  await inspectBelow(out, path.dirname(output));
}
assert((await lstat(payload)).isDirectory(), 'Packaged app must be a directory');
const installerInfo = await lstat(installer);
assert(installerInfo.isFile() && installerInfo.size > 0, 'NSIS installer must be a nonempty file');

const report = {
  schemaVersion: 1,
  installer: {
    name: path.basename(installer),
    bytes: installerInfo.size,
    sha256: await fileDigest(installer),
  },
  payload: await readPayloadInventory(payload),
};
const json = `${JSON.stringify(report, null, 2)}\n`;
assert(
  Buffer.byteLength(json) <= maxReportBytes,
  'Packaged app inventory exceeds the report limit',
);
await writeFile(output, json, { flag: 'wx' });
console.log('NSIS artifact inventory written.');

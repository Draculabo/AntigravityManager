import assert from 'node:assert/strict';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import forgeConfig from '@electron-forge/core/dist/util/forge-config.js';

assert.equal(process.platform, 'win32');
assert.equal(process.arch, 'x64');
assert.equal(process.argv.length, 4, 'Supply packaged application and isolated make directory');
const directory = await realpath(path.resolve(process.argv[2]));
const output = path.resolve(process.argv[3]);
const project = await realpath(process.cwd());
assert(output.startsWith(`${project}${path.sep}out${path.sep}`));
assert.equal(await realpath(path.dirname(output)), path.join(project, 'out'));
await mkdir(output);
assert.equal(await realpath(output), output);
const packageJSON = JSON.parse(await readFile('package.json', 'utf8'));
const parts = packageJSON.version.split('.').map(Number);
assert.equal(parts.length, 3);
assert(parts.every(Number.isSafeInteger) && parts[2] > 0);
const previous = `${parts[0]}.${parts[1]}.${parts[2] - 1}`;
const config = await forgeConfig.default(project);
const maker = config.makers.find((candidate) => candidate.name === 'wix');
assert(maker, 'Use the configured WiX maker rather than its package defaults');
await maker.prepareConfig('x64');
assert.equal(maker.config.arch, 'x64');
assert.match(maker.config.upgradeCode, /^[a-f0-9-]{36}$/i);
// Only installer version metadata differs. This tests MSI upgrade mechanics, not historical data migrations.
const artifacts = await maker.make({
  dir: directory,
  makeDir: output,
  targetArch: 'x64',
  packageJSON: { ...packageJSON, version: previous },
  appName: config.packagerConfig.name,
});
console.log(`Previous-version installer fixture: ${artifacts[0]}`);

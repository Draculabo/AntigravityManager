import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { x as extractTar } from 'tar';
import { publishStandaloneRuntime, RuntimeRecoveryError } from './publish-standalone-runtime.mjs';
import { materializeRuntime } from './trace-standalone-runtime.mjs';

// Match the Node ABI exercised by the standalone native acceptance suite.
export const nodeVersion = (
  await readFile(new URL('../../.nvmrc', import.meta.url), 'utf8')
).trim();
assert.match(nodeVersion, /^24\.\d+\.\d+$/, 'Expected a pinned Node 24 release');
const project = process.cwd();
const platform = process.argv[2] ?? process.platform;
const arch = process.argv[3] ?? process.arch;
assert.equal(platform, process.platform, 'Native packaging requires a matching host platform');
assert.equal(arch, process.arch, 'Native packaging requires a matching host architecture');
assert(['win32', 'darwin', 'linux'].includes(platform));
assert(['x64', 'arm64'].includes(arch));
const pnpmCli = process.env.npm_execpath;
assert(
  pnpmCli && process.env.npm_config_user_agent?.startsWith('pnpm/10.'),
  'Run this script through the pinned pnpm run prepare:standalone command',
);
const parent = path.join(project, 'dist', '.runtime', `${platform}-${arch}`);
await mkdir(parent, { recursive: true });
const resolvedParent = await realpath(parent);
assert(resolvedParent.startsWith(`${await realpath(project)}${path.sep}`));
const stage = await mkdtemp(path.join(resolvedParent, 'stage-'));
const destination = path.join(resolvedParent, 'standalone');
const root = path.join(stage, 'standalone');
const installRoot = path.join(stage, 'untraced');
const nodeDirectory = path.join(installRoot, 'node');
const nodeExecutable = path.join(nodeDirectory, platform === 'win32' ? 'node.exe' : 'node');
let preserveStage = false;

async function run(executable, args, cwd, env = process.env) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = '';
    const collect = (chunk) => {
      tail = (tail + chunk.toString()).slice(-6000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => {
      child.kill();
    }, 600_000);
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Runtime preparation failed (${code}): ${tail}`));
      }
    });
  });
}

async function download(relative, destinationFile, expectedHash) {
  const response = await fetch(`https://nodejs.org/dist/v${nodeVersion}/${relative}`, {
    signal: AbortSignal.timeout(120_000),
  });
  assert(response.ok && response.body, `Node download failed: ${response.status}`);
  const digest = createHash('sha256');
  let bytes = 0;
  const verifier = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > 150 * 1024 * 1024) {
        callback(new Error('Node download exceeds capacity'));
        return;
      }
      digest.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), verifier, createWriteStream(destinationFile));
  assert.equal(digest.digest('hex'), expectedHash, 'Official Node checksum mismatch');
}

async function hash(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) {
    digest.update(chunk);
  }
  return digest.digest('hex');
}

try {
  console.log(`Preparing standalone Node ${nodeVersion} for ${platform}-${arch}`);
  await mkdir(nodeDirectory, { recursive: true });
  const checksumsResponse = await fetch(`https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt`, {
    signal: AbortSignal.timeout(30_000),
  });
  assert(checksumsResponse.ok);
  const checksums = await checksumsResponse.text();
  assert(checksums.length < 100_000);
  const asset =
    platform === 'win32'
      ? `win-${arch}/node.exe`
      : `node-v${nodeVersion}-${platform}-${arch}.tar.gz`;
  const checksum = checksums
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .find((entry) => entry[1] === asset)?.[0];
  assert(checksum && /^[a-f0-9]{64}$/.test(checksum), 'Official Node asset missing');
  if (platform === 'win32') {
    await download(asset, nodeExecutable, checksum);
    const licenseResponse = await fetch(
      `https://raw.githubusercontent.com/nodejs/node/v${nodeVersion}/LICENSE`,
      { signal: AbortSignal.timeout(30_000) },
    );
    assert(licenseResponse.ok);
    const license = await licenseResponse.text();
    assert(license.length > 1000 && license.length < 500_000);
    await writeFile(path.join(nodeDirectory, 'LICENSE'), license);
  } else {
    const archive = path.join(stage, 'node.tar.gz');
    await download(asset, archive, checksum);
    const extracted = path.join(stage, 'node-source');
    await mkdir(extracted);
    await extractTar({ file: archive, cwd: extracted, strip: 1 });
    await cp(path.join(extracted, 'bin', 'node'), nodeExecutable);
    await cp(path.join(extracted, 'LICENSE'), path.join(nodeDirectory, 'LICENSE'));
  }
  const environment = {
    ...process.env,
    PATH: `${nodeDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
    npm_config_runtime: 'node',
    npm_config_target: nodeVersion,
    npm_config_arch: arch,
    npm_config_platform: platform,
    npm_config_cache: path.join(stage, 'package-cache'),
    npm_config_devdir: path.join(stage, 'node-gyp-cache'),
  };
  delete environment.NODE_PATH;
  delete environment.NODE_OPTIONS;
  delete environment.npm_config_nodedir;
  delete environment.npm_config_ignore_scripts;
  delete environment.npm_config_registry;
  environment.npm_config_registry = 'https://registry.npmjs.org/';
  // Install from the same frozen lockfile, then rebuild only this isolated Node tree.
  await cp(path.join(project, 'package.json'), path.join(installRoot, 'package.json'));
  for (const file of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    await cp(path.join(project, file), path.join(installRoot, file));
  }
  await cp(path.join(project, 'patches'), path.join(installRoot, 'patches'), { recursive: true });
  await cp(path.join(project, '.npmrc'), path.join(installRoot, '.npmrc'));
  console.log('Installing locked production dependencies into isolated runtime');
  const isJsPnpm = pnpmCli.endsWith('.js') || pnpmCli.endsWith('.cjs') || pnpmCli.endsWith('.mjs');
  const runPnpm = (nodeRunner, args, cwd, env) => {
    if (isJsPnpm) {
      return run(nodeRunner, [pnpmCli, ...args], cwd, env);
    }
    return run(pnpmCli, args, cwd, env);
  };
  await runPnpm(
    nodeExecutable,
    ['install', '--prod', '--frozen-lockfile', '--ignore-scripts'],
    installRoot,
    environment,
  );
  await runPnpm(
    nodeExecutable,
    ['rebuild', 'better-sqlite3', 'keytar', 'koffi', '@napi-rs/keyring'],
    installRoot,
    environment,
  );
  await runPnpm(process.execPath, ['run', 'build:core'], project);
  await runPnpm(process.execPath, ['run', 'build:cli'], project);
  const bundleCopy = { recursive: true, filter: (file) => !file.endsWith('.map') };
  await cp(path.join(project, 'dist', 'core'), path.join(installRoot, 'core'), bundleCopy);
  await cp(path.join(project, 'dist', 'cli'), path.join(installRoot, 'cli'), bundleCopy);
  await cp(path.join(project, 'src', 'assets'), path.join(installRoot, 'assets'), {
    recursive: true,
  });
  await cp(path.join(project, 'LICENSE'), path.join(installRoot, 'LICENSE'));
  await materializeRuntime(installRoot, root);
  const runtimeNodeDirectory = path.join(root, 'node');
  const runtimeNode = path.join(runtimeNodeDirectory, platform === 'win32' ? 'node.exe' : 'node');
  const runtimeEnvironment = {
    ...environment,
    PATH: `${runtimeNodeDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
  };
  // Resolve from the resource root with all repository search-path overrides removed.
  await run(
    runtimeNode,
    [
      '-e',
      "const assert=require('node:assert/strict'); assert.equal(process.versions.node,process.argv[1]); const D=require('better-sqlite3'); const db=new D(':memory:'); assert.equal(db.prepare('SELECT 7 AS value').get().value,7); db.close(); require('keytar'); require('koffi'); require('@napi-rs/keyring');",
      nodeVersion,
    ],
    root,
    runtimeEnvironment,
  );
  await run(runtimeNode, [path.join(root, 'cli', 'main.cjs'), '--help'], root, runtimeEnvironment);
  await run(runtimeNode, [path.join(root, 'core', 'main.cjs'), '--help'], root, runtimeEnvironment);
  const manifest = {
    version: 1,
    nodeVersion,
    platform,
    arch,
    nodeAsset: asset,
    nodeAssetSha256: checksum,
    nodeExecutableSha256: await hash(runtimeNode),
    lockSha256: await hash(path.join(root, 'pnpm-lock.yaml')),
    coreSha256: await hash(path.join(root, 'core', 'main.cjs')),
    cliSha256: await hash(path.join(root, 'cli', 'main.cjs')),
    auditWorkerSha256: await hash(path.join(root, 'core', 'traffic-audit.worker.js')),
    thoughtWorkerSha256: await hash(path.join(root, 'core', 'thought-store.worker.js')),
  };
  await writeFile(
    path.join(root, 'runtime-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  try {
    await publishStandaloneRuntime(root, destination, { platform, arch });
  } catch (error) {
    if (error instanceof RuntimeRecoveryError) {
      preserveStage = true;
    }
    throw error;
  }
  console.log(`Standalone runtime validated: ${destination}`);
} finally {
  assert.equal(path.dirname(await realpath(stage)), resolvedParent);
  assert(path.basename(stage).startsWith('stage-'));
  if (!preserveStage) {
    await rm(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

import assert from 'node:assert/strict';
import {
  cp,
  mkdir,
  readFile,
  readlink,
  readdir,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeFileTrace } from '@vercel/nft';
import { c as archiveTar, x as extractTar } from 'tar';
import { pipeline } from 'node:stream/promises';

const entries = [
  'core/main.cjs',
  'cli/main.cjs',
  'core/traffic-audit.worker.js',
  'core/thought-store.worker.js',
];

// These optional paths are already excluded by the core build aliases or have JS fallbacks.
const optionalFrameworkImports = new Set([
  '@fastify/static',
  '@fastify/view',
  '@nestjs/websockets/socket-module',
  'amqp-connection-manager',
  'amqplib',
  'ioredis',
  'kafkajs',
  'mqtt',
  'nats',
  'bufferutil',
  'utf-8-validate',
  // debug catches a missing color detector and continues without terminal colors.
  'supports-color',
]);

/** Trace already-built entries against the separately rebuilt Node dependency tree. */
export async function traceRuntime(root) {
  root = await realpath(root);
  const scoped = (file) => file === root || file.startsWith(`${root}${path.sep}`);
  async function withinRoot(file, operation) {
    if (!scoped(path.resolve(file))) {
      return null;
    }
    try {
      return await operation(file);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EINVAL') {
        return null;
      }
      throw error;
    }
  }
  const require = createRequire(path.join(root, 'package.json'));
  const nativeLoaders = [
    'better-sqlite3',
    'keytar',
    'koffi',
    '@napi-rs/keyring',
    '@draculabo/sysinfo-process-enhanced',
  ].map((name) => require.resolve(name));
  const keyringTarget = `@napi-rs/keyring-${process.platform}-${process.arch}${process.platform === 'win32' ? '-msvc' : process.platform === 'linux' ? '-gnu' : ''}`;
  const koffiTarget = `@koromix/koffi-${process.platform}-${process.arch}`;
  const sysinfoTarget = `@draculabo/sysinfo-process-enhanced-${process.platform}-${process.arch}${process.platform === 'win32' ? '-msvc' : process.platform === 'linux' ? '-gnu' : ''}`;
  const binaries = [
    path.join(root, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node'),
    path.join(root, 'node_modules/keytar/build/Release/keytar.node'),
    require.resolve(keyringTarget),
    require.resolve(sysinfoTarget),
    path.join(root, `node_modules/${koffiTarget}/${process.platform}_${process.arch}/koffi.node`),
  ];
  for (const binary of binaries) {
    assert((await stat(binary)).isFile(), 'Required target native binary is missing');
  }
  const optionalNativeImports = new Set();
  for (const name of ['koffi', '@napi-rs/keyring', '@draculabo/sysinfo-process-enhanced']) {
    const metadata = JSON.parse(
      await readFile(path.join(root, 'node_modules', name, 'package.json'), 'utf8'),
    );
    for (const optional of Object.keys(metadata.optionalDependencies ?? {})) {
      if (optional !== keyringTarget && optional !== koffiTarget && optional !== sysinfoTarget) {
        optionalNativeImports.add(optional);
        optionalNativeImports.add(`${optional}/package.json`);
      }
      if (optional.startsWith('@napi-rs/keyring-')) {
        optionalNativeImports.add(`./keyring.${optional.slice('@napi-rs/keyring-'.length)}.node`);
      }
      if (optional.startsWith('@draculabo/sysinfo-process-enhanced-')) {
        optionalNativeImports.add(
          `./sysinfo.${optional.slice('@draculabo/sysinfo-process-enhanced-'.length)}.node`,
        );
      }
    }
  }
  // The native loader also probes a colocated/WASI fallback before its installed target package.
  optionalNativeImports.add('./keyring.wasi.cjs');
  optionalNativeImports.add('./sysinfo.wasi.cjs');
  const result = await nodeFileTrace(
    [...entries.map((file) => path.join(root, file)), ...nativeLoaders, ...binaries],
    {
      base: root,
      processCwd: root,
      fileIOConcurrency: 128,
      // Windows relative() returns an absolute path when a reference crosses drives.
      // NFT's default ../ filter alone does not exclude those host paths before globbing.
      ignore: (file) => path.isAbsolute(file) || file === '..' || file.startsWith(`..${path.sep}`),
      stat: (file) => withinRoot(file, stat),
      readlink: (file) => withinRoot(file, readlink),
      readFile: (file) =>
        withinRoot(file, async (target) => {
          assert(scoped(await realpath(target)), 'Trace followed a link outside its runtime root');
          return readFile(target, 'utf8');
        }),
    },
  );
  const warnings = [...result.warnings].map((warning) => warning.message);
  for (const warning of warnings) {
    const missing = /^Failed to resolve dependency "([^"]+)":/.exec(warning)?.[1];
    const license = /^Failed to parse .*[/\\]LICENSE as (module|script):/.test(warning);
    // ASAR uses Electron's original-fs only under Electron, and Node's fs under Node.
    const electronAsarBuiltin =
      missing === 'original-fs' &&
      warning.includes(
        `loaded from ${path.join(root, 'node_modules/@electron/asar/lib/wrapped-fs.js')}`,
      );
    // The generated napi-rs loader probes unpublished platforms too. Its target is mandatory above.
    const napiAlternative =
      missing &&
      warning.includes(`loaded from ${require.resolve('@napi-rs/keyring')}`) &&
      missing !== keyringTarget &&
      missing !== `${keyringTarget}/package.json` &&
      (/^@napi-rs\/keyring-(android|darwin|freebsd|linux|openharmony|win32|wasm32)-[a-z0-9-]+(\/package\.json)?$/.test(
        missing,
      ) ||
        /^\.\/keyring\.(android|darwin|freebsd|linux|openharmony|win32)-[a-z0-9-]+\.node$/.test(
          missing,
        ));
    const sysinfoAlternative =
      missing &&
      warning.includes(`loaded from ${require.resolve('@draculabo/sysinfo-process-enhanced')}`) &&
      missing !== sysinfoTarget &&
      missing !== `${sysinfoTarget}/package.json` &&
      (/^@draculabo\/sysinfo-process-enhanced-(android|darwin|freebsd|linux|win32|wasm32)-[a-z0-9-]+(\/package\.json)?$/.test(
        missing,
      ) ||
        /^\.\/sysinfo\.(android|darwin|freebsd|linux|win32)-[a-z0-9-]+\.node$/.test(missing));
    assert(
      license ||
        electronAsarBuiltin ||
        (missing &&
          (optionalFrameworkImports.has(missing) ||
            optionalNativeImports.has(missing) ||
            napiAlternative ||
            sysinfoAlternative)),
      `Unreviewed runtime trace warning: ${warning}`,
    );
  }
  const files = new Set(result.fileList);
  for (const file of result.fileList) {
    if (path.basename(file) === 'package.json') {
      const directory = path.dirname(file);
      for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
        if (entry.isFile() && /^(licen[sc]e|copying|copyright)(\..+)?$/i.test(entry.name)) {
          files.add(path.join(directory, entry.name));
        }
      }
    }
  }
  for (const file of files) {
    const target = path.resolve(root, file);
    assert(target.startsWith(`${root}${path.sep}`), 'Trace escaped its runtime root');
  }
  return {
    files: [...files].sort(),
    warnings: warnings.map((warning) => warning.split(root).join('.')).sort(),
  };
}

export async function materializeRuntime(root, output) {
  const trace = await traceRuntime(root);
  await mkdir(output);
  await pipeline(archiveTar({ cwd: root }, trace.files), extractTar({ cwd: output }));
  for (const resource of ['node', 'assets', 'package.json', 'package-lock.json', 'LICENSE']) {
    await cp(path.join(root, resource), path.join(output, resource), { recursive: true });
  }
  await writeFile(
    path.join(output, 'runtime-trace.json'),
    `${JSON.stringify({ version: 1, tracer: '@vercel/nft@1.11.0', ...trace }, null, 2)}\n`,
  );
  console.log(
    `Standalone runtime trace retained ${trace.files.length} files; all ${trace.warnings.length} optional/asset warnings reviewed`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 3);
  const root = path.resolve(process.argv[2]);
  const manifest = JSON.parse(await readFile(path.join(root, 'runtime-manifest.json'), 'utf8'));
  assert.equal(manifest.version, 1);
  const trace = await traceRuntime(root);
  let bytes = 0;
  for (const file of trace.files) {
    bytes += (await stat(path.join(root, file))).size;
  }
  await writeFile(
    path.join(process.cwd(), 'dist', '.runtime', 'trace-analysis.json'),
    JSON.stringify({ ...trace, bytes }, null, 2),
  );
  console.log(
    `Traced files=${trace.files.length}, bytes=${bytes}, warnings=${trace.warnings.length}`,
  );
  for (const warning of trace.warnings.slice(0, 12)) {
    console.log(warning);
  }
}

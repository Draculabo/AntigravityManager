import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { buildNativeEntry, runNativeEntry, withNativeFixture } from '../helpers/native-fixture.mjs';

const args = process.argv.slice(2);
const smokeOnly = args.length === 1 && args[0] === '--smoke';
assert(
  smokeOnly || args.length === 0 || (args.length === 2 && args[0] === '--runtime-root'),
  'Usage: npm run test:acceptance -- runtime diagnostics [--smoke | --runtime-root <directory>]',
);

if (smokeOnly) {
  await checkBuiltWorkers();
} else {
  const runtimeRoot = path.resolve(args[1] ?? process.cwd());
  await withNativeFixture(runtimeRoot, 'agm-terminal-native-', async (fixture) => {
    await buildNativeEntry(
      fixture,
      'scripts/acceptance/runtime/diagnostics-terminal-native-entry.ts',
      'terminal.cjs',
    );
    runNativeEntry(fixture, 'terminal.cjs', 'Native diagnostic service check failed');
  });
}

async function checkBuiltWorkers() {
  const buildDirectory = path.resolve('dist/core');
  const temporaryRoot = path.resolve(tmpdir());
  const directory = await mkdtemp(path.join(temporaryRoot, 'agm-core-workers-'));

  async function checkWorker(name, metric) {
    const entry = path.join(buildDirectory, `${name}.worker.js`);
    await access(entry);
    const worker = new Worker(entry, {
      workerData: { databasePath: path.join(directory, `${name}.db`) },
    });
    let nextId = 0;
    function request(operation) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error('Worker smoke check timed out')), 10_000);
        function finish(error, result) {
          clearTimeout(timer);
          worker.off('error', onError);
          worker.off('exit', onExit);
          worker.off('message', onMessage);
          if (error) {
            reject(error);
          } else {
            resolve(result);
          }
        }
        function onError(error) {
          finish(error);
        }
        function onExit(code) {
          finish(new Error(`Worker exited before replying: ${code}`));
        }
        function onMessage(reply) {
          if (reply.id === id) {
            finish(reply.error ? new Error(reply.error) : null, reply.result);
          }
        }
        worker.on('error', onError);
        worker.on('exit', onExit);
        worker.on('message', onMessage);
        worker.postMessage({ id, operation, payload: null });
      });
    }
    try {
      const stats = await request('stats');
      assert.equal(typeof stats, 'object');
      assert.notEqual(stats, null);
      assert.equal(stats[metric], 0);
      await request('shutdown');
      process.stdout.write(`${name}: built entry, SQLite open, empty stats and shutdown passed\n`);
    } finally {
      await worker.terminate();
    }
  }

  try {
    await checkWorker('traffic-audit', 'rows');
    await checkWorker('thought-store', 'sessions');
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), temporaryRoot);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

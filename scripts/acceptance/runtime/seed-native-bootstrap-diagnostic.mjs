import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

export async function seedNativeBootstrapDiagnostic(home, workerPath) {
  const errorDirectory = path.join(home, '.antigravity-agent', 'error-diagnostics');
  await mkdir(errorDirectory, { recursive: true });
  const errorWorker = new Worker(workerPath, {
    workerData: { databasePath: path.join(errorDirectory, 'core.errors.db'), role: 'core' },
  });
  let errorCommandId = 0;
  const errorCommand = (operation, payload) =>
    new Promise((resolve, reject) => {
      const id = ++errorCommandId;
      const done = (error, value) => {
        clearTimeout(timeout);
        errorWorker.off('message', reply);
        errorWorker.off('error', failed);
        errorWorker.off('exit', exited);
        if (error) {
          reject(error);
        } else {
          resolve(value);
        }
      };
      const failed = (error) => done(error);
      const exited = (code) => done(new Error(`Error fixture worker exited: ${code}`));
      const reply = (message) => {
        if (message.id === id) {
          done(message.error ? new Error(message.error) : null, message.result);
        }
      };
      const timeout = setTimeout(
        () => done(new Error(`Native bootstrap diagnostic fixture timed out during ${operation}`)),
        20_000,
      );
      errorWorker.on('message', reply);
      errorWorker.on('error', failed);
      errorWorker.on('exit', exited);
      errorWorker.postMessage({ id, operation, payload });
    });
  try {
    const generation = randomUUID();
    await errorCommand('initialize', { generation, allocationBytes: 250 * 1024 * 1024 });
    const stack = 'Error: isolated diagnostic\n' + '    at 诊断😀 (fixture.ts:1:2)\n'.repeat(5000);
    await errorCommand('insert', {
      generation,
      body: JSON.stringify({
        version: 1,
        id: '55555555-5555-4555-8555-555555555555',
        createdAt: '2020-01-01T00:00:00Z',
        role: 'core',
        source: 'native-bootstrap',
        module: null,
        functionName: null,
        stage: null,
        protocol: null,
        requestId: null,
        attemptId: null,
        category: 'fixture',
        status: null,
        message: 'isolated diagnostic',
        stack,
        stackComplete: true,
        causes: [],
      }),
    });
    await errorCommand('shutdown', null);
  } finally {
    await errorWorker.terminate();
  }
}

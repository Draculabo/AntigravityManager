import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { setImmediate as turn, setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { build } from 'vite';
import { waitForOwnedCore } from './live-startup.mjs';

const workspace = fs.mkdtempSync(path.resolve('out/schema-work-package/startup-control-'));
await build({
  configFile: false,
  logLevel: 'error',
  resolve: { alias: { '@': path.resolve('src') } },
  build: {
    ssr: true,
    target: 'node22',
    outDir: workspace,
    emptyOutDir: false,
    rollupOptions: {
      input: 'scripts/acceptance/schema/runtime-control.ts',
      output: { format: 'cjs', entryFileNames: 'control.cjs', exports: 'named' },
    },
  },
});
const { ServiceLauncher, ServiceNotRunningError } = createRequire(import.meta.url)(
  path.join(workspace, 'control.cjs'),
);
const running = { state: 'running', pid: 1, gateway: { running: false, port: null } };

async function virtualOutcome(context, execute) {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  syncBuiltinESMExports();
  let outcome;
  const promise = execute().then(
    (value) => {
      outcome = { value };
    },
    (error) => {
      outcome = { error };
    },
  );
  await turn();
  for (let elapsed = 0; !outcome && elapsed < 60_000; elapsed += 100) {
    context.mock.timers.tick(100);
    await turn();
  }
  assert.ok(outcome, 'Readiness must settle within its bounded virtual window');
  await promise;
  return outcome;
}

test('acceptance accepts the same 35-second startup as the production launcher', async (context) => {
  const management = {
    status: async () => {
      if (Date.now() < 35_000) {
        throw new ServiceNotRunningError();
      }
      return running;
    },
    shutdown: async () => {},
  };
  const launcher = new ServiceLauncher({
    management,
    probeProfileOwner: async () => null,
    launchCore: async () => ({ hasExited: () => false }),
    now: () => Date.now(),
    wait: (milliseconds) => delay(milliseconds),
  });
  const production = await virtualOutcome(context, () => launcher.start());
  assert.equal(production.error, undefined);
  assert.deepEqual(production.value.status, running);
  context.mock.timers.reset();
  const result = {};
  const acceptance = await virtualOutcome(context, () =>
    waitForOwnedCore({ management, childHasExited: () => false, result }),
  );
  assert.equal(acceptance.error, undefined);
  assert.deepEqual(result.startupReadiness.states, { running: 1 });
  assert.equal(result.startupReadiness.elapsedMs, 35_000);
});

test('missing management never counts as readiness and times out at 45 seconds', async (context) => {
  const result = {};
  const outcome = await virtualOutcome(context, () =>
    waitForOwnedCore({
      management: {
        status: async () => {
          throw new ServiceNotRunningError();
        },
      },
      childHasExited: () => false,
      result,
    }),
  );
  assert.equal(outcome.error?.message, 'Owned core readiness timed out');
  assert.equal(result.startupReadiness.elapsedMs, 45_000);
  assert.deepEqual(result.startupReadiness.states, {});
  assert.equal(
    result.startupReadiness.errors.ServiceNotRunningError,
    result.startupReadiness.probes,
  );
});

test('child exit fails before any readiness request', async () => {
  const result = {};
  await assert.rejects(
    waitForOwnedCore({
      management: {
        status: async () => {
          throw new Error('Unexpected probe');
        },
      },
      childHasExited: () => true,
      result,
    }),
    /Owned core exited during startup/,
  );
  assert.equal(result.startupReadiness.probes, 0);
});

test('a stalled management probe cannot extend the total readiness deadline', async (context) => {
  const result = {};
  const outcome = await virtualOutcome(context, () =>
    waitForOwnedCore({
      management: { status: () => new Promise(() => {}) },
      childHasExited: () => false,
      result,
    }),
  );
  assert.equal(outcome.error?.message, 'Owned core readiness timed out');
  assert.equal(result.startupReadiness.elapsedMs, 45_000);
  assert.equal(result.startupReadiness.probes, 1);
  assert.deepEqual(result.startupReadiness.states, {});
});

test('a response delivered after the deadline cannot count as readiness', async (context) => {
  const result = {};
  const outcome = await virtualOutcome(context, () =>
    waitForOwnedCore({
      management: {
        status: async () => {
          context.mock.timers.tick(45_001);
          return running;
        },
      },
      childHasExited: () => false,
      result,
    }),
  );
  assert.equal(outcome.error?.message, 'Owned core readiness timed out');
  assert.equal(result.startupReadiness.elapsedMs, 45_001);
  assert.deepEqual(result.startupReadiness.states, {});
});

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID, createHash } from 'node:crypto';
import { build } from 'vite';
import { z } from 'zod';
import { readLiveConfiguration } from './live-configuration.mjs';
import { waitForOwnedCore } from './live-startup.mjs';

// Exercise the same runtime and readiness check without gateway requests or diagnostic events.
const count = z.coerce
  .number()
  .int()
  .min(1)
  .max(10)
  .parse(process.argv[2] ?? 5);
const trace = z.enum(['trace']).optional().parse(process.argv[3]) === 'trace';
const root = process.cwd();
const workspace = fs.mkdtempSync(path.resolve('out/schema-work-package/startup-'));
const runtime = path.resolve('dist/.runtime', `${process.platform}-${process.arch}`, 'standalone');
const executable = path.join(runtime, process.platform === 'win32' ? 'node/node.exe' : 'node/node');
const coreEntry = path.join(runtime, 'core/main.cjs');
const { reporting, preferencePath } = readLiveConfiguration(root);
const release = `schema-startup-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
const result = {
  release,
  productionRuntime: true,
  startupPhaseProbe: trace,
  gatewayRequestsSubmitted: 0,
  diagnosticEventsSubmitted: 0,
  coreEntrySha256: createHash('sha256').update(fs.readFileSync(coreEntry)).digest('hex'),
  requestedRuns: count,
  runs: [],
};
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
const control = createRequire(import.meta.url)(path.join(workspace, 'control.cjs'));
const endpoint = control.getManagementEndpoint();
const ownerEndpoint = control.getProfileOwnershipEndpoint();
const environment = {
  ...process.env,
  SENTRY_DSN: reporting.SENTRY_DSN,
  SENTRY_RELEASE: release,
  ANTIGRAVITY_DESKTOP_PREFERENCES_PATH: preferencePath,
};
delete environment.NODE_PATH;
delete environment.NODE_OPTIONS;
delete environment.ELECTRON_RUN_AS_NODE;
const phaseProbe = path.join(workspace, 'phase-probe.cjs');
if (trace) {
  // A fixed preload marker separates process creation from the first event-loop turn.
  // It neither replaces the loader nor instruments production services.
  fs.writeFileSync(
    phaseProbe,
    "process.stderr.write('[startup-probe:pre-entry]\\n'); setImmediate(() => process.stderr.write('[startup-probe:first-turn]\\n'));\n",
  );
}

function classifyOutput(output) {
  return {
    coreStartedLogged: output.includes('Standalone core service started'),
    startupFailureLogged: output.includes('Standalone core service failed to start'),
    missingModule: /Cannot find module|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/.test(output),
    nativeFailure: /NODE_MODULE_VERSION|did not self-register|was compiled against/.test(output),
  };
}

async function confirmStopped() {
  if (await control.probeProfileOwner(ownerEndpoint)) {
    return false;
  }
  try {
    await new control.ManagementClient(endpoint).status();
    return false;
  } catch (error) {
    if (error.name !== 'ServiceNotRunningError') {
      throw error;
    }
    return true;
  }
}

try {
  for (let index = 0; index < count; index++) {
    if (!(await confirmStopped())) {
      throw new Error('Profile is already owned; startup probe will not replace it');
    }
    const run = { index: index + 1, passed: false, restoredStopped: false };
    result.runs.push(run);
    const startedAt = Date.now();
    let output = '';
    let spawnFailed = false;
    const child = spawn(executable, trace ? ['--require', phaseProbe, coreEntry] : [coreEntry], {
      cwd: runtime,
      env: environment,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.once('spawn', () => {
      run.spawnedAtMs = Date.now() - startedAt;
    });
    child.once('error', () => {
      spawnFailed = true;
    });
    const hasExited = () => spawnFailed || child.exitCode !== null || child.signalCode !== null;
    const observe = (chunk) => {
      run.firstOutputAtMs ??= Date.now() - startedAt;
      if (output.length < 16_384) {
        output += chunk.toString('utf8').slice(0, 16_384 - output.length);
      }
      if (output.includes('[startup-probe:pre-entry]')) {
        run.preEntryAtMs ??= Date.now() - startedAt;
      }
      if (output.includes('[startup-probe:first-turn]')) {
        run.firstEventLoopTurnAtMs ??= Date.now() - startedAt;
      }
    };
    child.stdout.on('data', observe);
    child.stderr.on('data', observe);
    const management = new control.ManagementClient(endpoint);
    let ownedManagement;
    try {
      await waitForOwnedCore({
        management: {
          status: async () => {
            const status = await management.status();
            if (status.pid !== child.pid) {
              throw new Error('Observed a different core owner');
            }
            run.firstManagementResponseAtMs ??= Date.now() - startedAt;
            return status;
          },
        },
        childHasExited: hasExited,
        result: run,
      });
      const handshake = await management.handshake();
      ownedManagement = new control.ManagementClient(endpoint, undefined, handshake.epoch);
      run.readyAtMs = Date.now() - startedAt;
      run.passed = true;
    } catch (error) {
      run.failure =
        error.message === 'Owned core readiness timed out' ? 'readiness-timeout' : 'startup-failed';
      const owner = await control.probeProfileOwner(ownerEndpoint);
      run.profileOwnedByChild = owner?.kind === 'core' && owner.pid === child.pid;
      process.exitCode = 1;
    } finally {
      // Shutdown is epoch-bound and only targets the child whose PID was observed above.
      if (ownedManagement && !hasExited()) {
        try {
          await ownedManagement.shutdown();
        } catch {
          run.shutdownRequestFailed = true;
        }
      }
      if (ownedManagement) {
        for (let probe = 0; probe < 40 && !hasExited(); probe++) {
          await delay(250);
        }
      }
      if (!hasExited()) {
        child.kill();
        run.forcedOwnedChildCleanup = true;
        process.exitCode = 1;
        for (let probe = 0; probe < 40 && !hasExited(); probe++) {
          await delay(250);
        }
      }
      run.childExited = hasExited();
      run.restoredStopped = hasExited() && (await confirmStopped());
      run.totalElapsedMs = Date.now() - startedAt;
      run.outputBytesObserved = Buffer.byteLength(output);
      run.outputSignals = classifyOutput(output);
      output = '';
      if (!run.restoredStopped || run.shutdownRequestFailed) {
        process.exitCode = 1;
      }
      process.stdout.write(`${JSON.stringify(run)}\n`);
    }
    if (
      !run.passed ||
      !run.restoredStopped ||
      run.forcedOwnedChildCleanup ||
      run.shutdownRequestFailed
    ) {
      break;
    }
  }
} catch {
  result.failure = 'startup-probe-failed-or-profile-owned';
  process.exitCode = 1;
} finally {
  result.allRunsPassed =
    result.runs.length === count &&
    result.runs.every(
      (run) =>
        run.passed &&
        run.restoredStopped &&
        !run.forcedOwnedChildCleanup &&
        !run.shutdownRequestFailed,
    );
  if (!result.allRunsPassed) {
    process.exitCode = 1;
  }
  fs.writeFileSync(
    `artifacts/schema-work-package/live-results/${release}.json`,
    `${JSON.stringify(result, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify({ release, allRunsPassed: result.allRunsPassed })}\n`);
}

import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { parse } from 'jsonc-parser';
import { DEFAULT_APP_CONFIG } from '../../../src/modules/config/types';
import {
  getAgentDir,
  getProxyStateDir,
  getAntigravityDbPaths,
} from '../../../src/shared/platform/paths';
import { z } from 'zod';
import { bootstrapDesktopOwner } from '../../../src/modules/app-shell/services/desktop-owner-bootstrap';
import { standaloneCoreConnection } from '../../../src/modules/app-shell/services/standalone-core-connection';
import { selectDesktopOwners } from '../../../src/modules/app-shell/services/desktop-owner-selection';
import { getCloudAccountAdapter } from '../../../src/modules/cloud-account/ipc/cloud-account-adapter';
import { getConfigAdapter } from '../../../src/modules/config/ipc/config-adapter';
import { getAuditAdapter } from '../../../src/modules/proxy-gateway/ipc/audit-adapter';
import { ipcAuditRecorder } from '../../../src/modules/proxy-gateway/audit/ipc-audit-recorder';
import { CoreRpcClient } from '../../../src/core/rpc/client';
import { ManagementClient } from '../../../src/core/management/client';
import { getManagementEndpoint } from '../../../src/core/management/endpoint';
import type { CoreHandshake } from '../../../src/core/management/handshake';
import { verifyInstalledWebSocket } from './installed-websocket';
import {
  expectedLargeThoughtTransfer,
  LARGE_THOUGHT_BYTES,
  LARGE_THOUGHT_SESSION,
} from './fixtures/thought-capacity';

async function verifyPackagedCli(entry: string, home: string): Promise<void> {
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [entry, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 8_000,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return result;
  };
  const help = run('--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: antigravity-manager \[/);
  const serviceHelp = run('service', '--help');
  assert.equal(serviceHelp.status, 0);
  assert.match(serviceHelp.stdout, /Usage: antigravity-manager service \[/);
  const invalid = run('--invalid-acceptance-option');
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /unknown option '--invalid-acceptance-option'/);

  const configDirectory = path.join(home, '.claude');
  assert.equal(process.env.CLAUDE_CONFIG_DIR, configDirectory);
  const settings = path.join(configDirectory, 'settings.json');
  const original = '{\n  // Preserve this setting.\n  "unrelated": true,\n}\n';
  await fs.mkdir(configDirectory);
  await fs.writeFile(settings, original);

  const noBackup = run('tools', 'restore', 'claude', '--yes');
  assert.equal(noBackup.status, 1);
  assert.equal(noBackup.stdout, '');
  assert.equal(
    noBackup.stderr,
    'Tool settings could not be updated (backup-missing). No credentials were printed.\n',
  );
  assert.equal(await fs.readFile(settings, 'utf8'), original);

  const baseUrl = 'http://127.0.0.1:8045';
  const model = 'acceptance-model';
  const configured = run('tools', 'configure', 'claude', '--base-url', baseUrl, '--model', model);
  assert.equal(configured.status, 0, configured.stderr);
  assert.equal(configured.stderr, '');
  assert.equal(
    configured.stdout,
    'Configuration saved. Reopen the tool to use the new settings.\n',
  );
  const saved = await fs.readFile(settings, 'utf8');
  assert.match(saved, /\/\/ Preserve this setting\./);
  const config: unknown = parse(saved);
  assert.partialDeepStrictEqual(config, {
    unrelated: true,
    model,
    env: { ANTHROPIC_BASE_URL: baseUrl },
  });
  process.stdout.write('Packaged CLI parsing, Core RPC errors, and JSONC edits passed.\n');
}

/** Real core process and SQLite; presentation and keyring isolation belong to the launcher. */
async function check(): Promise<void> {
  const home = process.env.AGM_DIAGNOSTIC_TEST_HOME;
  assert(home);
  for (const target of ['classic', 'ide'] as const) {
    for (const candidate of getAntigravityDbPaths(target)) {
      const relative = path.relative(home, candidate);
      assert(
        !relative.startsWith('..') && !path.isAbsolute(relative),
        'Client database discovery escaped the isolated home',
      );
    }
  }
  assert.equal(
    getManagementEndpoint(),
    getManagementEndpoint(process.platform, home),
    'Presentation endpoint must use the isolated home',
  );
  const directory = path.dirname(process.argv[1]);
  const apiKey = randomUUID();
  await fs.mkdir(getAgentDir(), { recursive: true });
  await fs.writeFile(
    path.join(getAgentDir(), 'gui_config.json'),
    JSON.stringify({
      ...DEFAULT_APP_CONFIG,
      proxy: {
        ...DEFAULT_APP_CONFIG.proxy,
        auto_start: false,
        api_key: apiKey,
        traffic_audit: { ...DEFAULT_APP_CONFIG.proxy.traffic_audit, enabled: true },
        thought_store: { ...DEFAULT_APP_CONFIG.proxy.thought_store, enabled: true },
      },
    }),
  );
  const responsesPath = path.join(getProxyStateDir(), 'openai-responses-sessions.json');
  await fs.mkdir(path.dirname(responsesPath), { recursive: true });
  await fs.writeFile(
    responsesPath,
    JSON.stringify({
      version: 1,
      entries: ['A', 'B'].map((key) => ({
        key: `native-owner-${key}`,
        updatedAt: Date.now(),
        value: {
          node: {
            identity: { version: 1, origin: 'content', initialTaskFingerprint: 'f'.repeat(64) },
            thoughtSessionKey: `native-owner-scope-${key}`,
            historyOwner: 'unknown',
            parent: null,
            inputDelta: [{ role: 'user', content: key }],
            responseOutput: [],
            toolCallItems: [],
            model: 'fixture',
          },
        },
      })),
    }),
  );
  const retainedResponseKeys = async () =>
    z
      .object({ entries: z.array(z.object({ key: z.string() })) })
      .parse(JSON.parse(await fs.readFile(responsesPath, 'utf8')))
      .entries.map((entry) => entry.key);
  const assertRecoveryDeletion = (
    receipt: Awaited<ReturnType<CoreRpcClient['thought']['delete']>>,
    removed: number,
  ) => {
    assert.deepEqual(receipt, {
      sessions: 0,
      records: 0,
      recoveryComplete: true,
      recovery: [
        { owner: 'signature-cache', state: 'complete', removed: 0, unknown: 0 },
        { owner: 'responses', state: 'complete', removed, unknown: 0 },
      ],
    });
  };
  const children: ChildProcess[] = [];
  const connection = {
    ...standaloneCoreConnection(),
    selectStandaloneCore: async (handshake: CoreHandshake) => {
      const client = new CoreRpcClient(getManagementEndpoint(), undefined, handshake.epoch);
      await client.setErrorReportingEnabled(false);
      selectDesktopOwners({
        mode: 'standalone-core',
        client,
        management: new ManagementClient(getManagementEndpoint(), undefined, handshake.epoch),
      });
    },
  };
  const forbidden = async (): Promise<never> => {
    throw new Error('Desktop opened owner-local state');
  };
  const launchCore = async () => {
    process.stdout.write('Launching isolated packaged core.\n');
    const child = spawn(process.execPath, [path.join(directory, 'isolated-core.cjs')], {
      cwd: directory,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env },
    });
    children.push(child);
    let diagnosticBytes = 0;
    const diagnostic = (chunk: Buffer): void => {
      const remaining = Math.max(0, 2500 - diagnosticBytes);
      diagnosticBytes += chunk.length;
      if (remaining > 0) {
        process.stderr.write(chunk.subarray(0, remaining));
      }
    };
    child.stdout?.on('data', diagnostic);
    child.stderr?.on('data', diagnostic);
    await once(child, 'spawn');
    return {
      pid: child.pid,
      hasExited: () => child.exitCode !== null || child.signalCode !== null,
    };
  };
  const dependencies = {
    ...connection,
    mode: 'standalone-core' as const,
    lease: { acquire: forbidden, close: forbidden },
    initializeDesktopEmbedded: forbidden,
    selectDesktopEmbedded: () => {
      throw new Error('Unexpected desktop-embedded selection');
    },
    launchCore,
  };
  try {
    const owner = await bootstrapDesktopOwner(dependencies);
    process.stdout.write('Verified core owner.\n');
    const handshake = await connection.management.handshake();
    assert.equal(handshake.pid, children[0].pid);
    assert.equal((await connection.probeProfileOwner())?.pid, handshake.pid);
    const cli = process.argv[2];
    if (cli) {
      await verifyPackagedCli(cli, home);
    }
    assert.deepEqual(await getCloudAccountAdapter().listViews(), []);
    process.stdout.write('Standalone-core account view passed.\n');
    assert.equal((await getConfigAdapter().read()).proxy.auto_start, false);
    const client = new CoreRpcClient(getManagementEndpoint(), undefined, handshake.epoch);
    const errorStatus = await client.errorDiagnostics.status();
    assert.equal(errorStatus.role, 'core');
    assert.equal(errorStatus.storage.state, 'ready');
    const selectedBudget = (await client.readServiceConfig()).errorDiagnosticsBudget;
    if (errorStatus.storage.state === 'ready') {
      assert.equal(errorStatus.storage.allocationBytes, selectedBudget.coreBytes);
      assert.equal(errorStatus.storage.records, 1);
    }
    const errorPage = await client.errorDiagnostics.query({ source: 'native-bootstrap' });
    assert.equal(errorPage.records.length, 1);
    const diagnostic = await client.errorDiagnostics.open({ id: errorPage.records[0].id });
    assert(diagnostic);
    const {
      kind: errorKind,
      epoch: errorEpoch,
      capabilityId: errorCapability,
      resourceId: errorResource,
    } = diagnostic.transfer;
    const errorIdentity = {
      kind: errorKind,
      epoch: errorEpoch,
      capabilityId: errorCapability,
      resourceId: errorResource,
    };
    const diagnosticChunks: Buffer[] = [];
    let errorCursor = 0;
    while (errorCursor < diagnostic.transfer.totalBytes) {
      const chunk = await client.errorDiagnostics.readContent({
        ...errorIdentity,
        cursor: errorCursor,
      });
      assert.equal(chunk.cursor, errorCursor);
      assert(chunk.nextCursor > errorCursor);
      diagnosticChunks.push(Buffer.from(chunk.data, 'base64'));
      errorCursor = chunk.nextCursor;
    }
    const parsedDiagnostic = z
      .object({ stack: z.string(), stackComplete: z.literal(true) })
      .parse(JSON.parse(Buffer.concat(diagnosticChunks).toString('utf8')));
    assert.equal(
      parsedDiagnostic.stack,
      'Error: isolated diagnostic\n' + '    at 诊断😀 (fixture.ts:1:2)\n'.repeat(5000),
    );
    assert.equal((await client.errorDiagnostics.clear()).records, 1);
    assert.equal((await client.errorDiagnostics.query({})).records.length, 0);
    const changedWindow = await client.updateServiceConfig({
      error_diagnostics: { max_storage_mib: 128 },
    });
    assert.equal(changedWindow.state, 'restart-required');
    const changedStatus = await client.errorDiagnostics.status();
    assert.equal(changedStatus.storage.state, 'ready');
    if (changedStatus.storage.state === 'ready') {
      assert.equal(
        changedStatus.storage.allocationBytes,
        changedWindow.snapshot.errorDiagnosticsBudget.coreBytes,
      );
    }
    process.stdout.write(
      'Selected core error window, resolved budget update/pending app acknowledgement, complete diagnostic transfer and independent clear passed.\n',
    );
    const previousImages = (await client.readServiceConfig()).proxy.image_scheduler;
    const imageWindow = await client.updateServiceConfig({
      proxy: {
        image_scheduler: {
          send_window_strategy: 'memory',
          send_window_memory_mib: 16,
        },
      },
    });
    assert.deepEqual(imageWindow.snapshot.proxy.image_scheduler, {
      ...previousImages,
      send_window_strategy: 'memory',
      send_window_memory_mib: 16,
    });
    assert.deepEqual(
      (await getConfigAdapter().read()).proxy.image_scheduler,
      imageWindow.snapshot.proxy.image_scheduler,
    );
    process.stdout.write(
      'Selected core image-window strategy and preserved scheduler settings passed.\n',
    );
    assert.deepEqual(await client.localAccounts.listAccounts(), []);
    await client.openCode.status('http://127.0.0.1:8045');
    assert.equal((await client.gatewayStatus()).running, false);
    assert.equal((await client.errorDiagnostics.status()).storage.state, 'ready');
    await client.thought.stats();
    assertRecoveryDeletion(await client.thought.delete({ sessionKey: 'native-owner-scope-A' }), 1);
    assert.deepEqual(await retainedResponseKeys(), ['native-owner-B']);
    process.stdout.write('Selected-owner deletion before first gateway start passed.\n');
    if (process.env.AGM_DIAGNOSTIC_TEST_LARGE_THOUGHT === '1') {
      const page = await client.thought.records({ sessionKey: LARGE_THOUGHT_SESSION });
      assert.equal(page.records.length, 1);
      assert.equal(page.complete, true);
      const { signatureBytes, totalBytes, digest } = expectedLargeThoughtTransfer();
      for (let repeat = 0; repeat < 3; repeat += 1) {
        const opened = await client.thought.openRecord({
          sessionKey: LARGE_THOUGHT_SESSION,
          id: page.records[0].id,
        });
        assert(opened);
        assert.equal(opened.thoughtBytes, LARGE_THOUGHT_BYTES);
        assert.equal(opened.visibleBytes, 0);
        assert.equal(opened.signatureBytes, signatureBytes);
        assert.equal(opened.transfer.totalBytes, totalBytes);
        const { kind, epoch, capabilityId, resourceId } = opened.transfer;
        const identity = { kind, epoch, capabilityId, resourceId };
        const actual = createHash('sha256');
        let cursor = 0;
        while (cursor < opened.transfer.totalBytes) {
          const chunk = await client.thought.readContent({ ...identity, cursor });
          assert.equal(chunk.cursor, cursor);
          assert(chunk.nextCursor > cursor);
          assert.equal(chunk.complete, chunk.nextCursor === opened.transfer.totalBytes);
          const bytes = Buffer.from(chunk.data, 'base64');
          assert.equal(bytes.length, chunk.nextCursor - cursor);
          actual.update(bytes);
          cursor = chunk.nextCursor;
        }
        assert.equal(actual.digest('hex'), digest);
        assert.deepEqual(await client.thought.closeContent(identity), { closed: true });
        await assert.rejects(client.thought.readContent({ ...identity, cursor: 0 }));
      }
      process.stdout.write(
        'Three near-limit Thought transfers preserved full digests and closed capabilities.\n',
      );
    }
    const reservation = createServer();
    await new Promise<void>((resolve, reject) => {
      reservation.once('error', reject);
      reservation.listen(0, '127.0.0.1', resolve);
    });
    const address = reservation.address();
    assert(address && typeof address !== 'string');
    await new Promise<void>((resolve, reject) => {
      reservation.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
    const gateway = await client.startGateway(address.port);
    assert.equal(gateway.success, true);
    const rejected = await fetch(`http://127.0.0.1:${address.port}/v1/models`, {
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(rejected.status, 401);
    await rejected.text();
    for (const [limit, status] of [
      ['1', 200],
      ['invalid', 400],
    ] as const) {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/internal/audit/requests?limit=${limit}`,
        {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(10_000),
        },
      );
      assert.equal(response.status, status);
      if (status === 400) {
        assert.match(await response.text(), /"fieldErrors":\{"limit":/);
      } else {
        assert.match(await response.text(), /"items":\[/);
      }
    }
    process.stdout.write(
      'Installed gateway accepts valid query parameters and rejects invalid ones.\n',
    );
    await verifyInstalledWebSocket(address.port, apiKey);
    await client.stopGateway();
    assert.equal((await client.gatewayStatus()).running, false);
    assertRecoveryDeletion(await client.thought.delete({ sessionKey: 'native-owner-scope-B' }), 1);
    assert.deepEqual(await retainedResponseKeys(), []);
    process.stdout.write('Stopped-gateway selected-owner deletion and JSON readback passed.\n');
    process.stdout.write('Remote gateway start, authenticated boundary and stop passed.\n');
    await ipcAuditRecorder.run(['native', 'bootstrap'], { message: 'isolated input' }, () =>
      client.contextCacheStatus(),
    );
    const list = await getAuditAdapter().list({ limit: 50, offset: 0, trafficClass: 'ipc' });
    assert(list.items.some((item) => item.url === '/ipc/native/bootstrap'));
    process.stdout.write('Remote audit capture passed.\n');
    // A second presentation composition attaches to the existing process and must not stop it.
    const attached = await bootstrapDesktopOwner(dependencies);
    await attached.close();
    assert.equal((await connection.management.handshake()).epoch, handshake.epoch);
    process.stdout.write('External attachment retained the core.\n');
    const exiting = once(children[0], 'exit');
    await owner.close();
    process.stdout.write('Launched core closure passed.\n');
    await exiting;
    assert.equal(await connection.probeProfileOwner(), null);
    const reopened = await bootstrapDesktopOwner(dependencies);
    const reopenedHandshake = await connection.management.handshake();
    const reopenedClient = new CoreRpcClient(
      getManagementEndpoint(),
      undefined,
      reopenedHandshake.epoch,
    );
    assert.equal(
      (await reopenedClient.errorDiagnostics.query({ source: 'native-bootstrap' })).records.length,
      0,
    );
    assertRecoveryDeletion(
      await reopenedClient.thought.delete({ sessionKey: 'native-owner-scope-A' }),
      0,
    );
    assert.deepEqual(await retainedResponseKeys(), []);
    const rows = await getAuditAdapter().list({ limit: 50, offset: 0, trafficClass: 'ipc' });
    assert(rows.items.some((item) => item.url === '/ipc/native/bootstrap'));
    const reopenedExit = once(children[1], 'exit');
    await reopened.close();
    await reopenedExit;
    assert.equal(await connection.probeProfileOwner(), null);
    if (process.env.AGM_DIAGNOSTIC_TEST_CRASH === '1') {
      await bootstrapDesktopOwner(dependencies);
      const crashed = children[2];
      const crashedExit = once(crashed, 'exit');
      crashed.kill('SIGKILL');
      await crashedExit;
      const recovered = await bootstrapDesktopOwner(dependencies);
      const recoveredRows = await getAuditAdapter().list({
        limit: 50,
        offset: 0,
        trafficClass: 'ipc',
      });
      assert(recoveredRows.items.some((item) => item.url === '/ipc/native/bootstrap'));
      await assert.rejects(client.contextCacheStatus());
      const recoveredExit = once(children[3], 'exit');
      await recovered.close();
      await recoveredExit;
      assert.equal(await connection.probeProfileOwner(), null);
      process.stdout.write(
        'Owned-core crash recovery, persisted reopen and stale-epoch rejection passed.\n',
      );
    }
    process.stdout.write(
      'Core process bootstrap, standalone-core composition, external attachment, terminal lease release and persisted reopen passed.\n',
    );
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        await new ManagementClient(getManagementEndpoint()).shutdown().catch(() => undefined);
        const timer = setTimeout(() => {
          child.kill();
        }, 10_000);
        await exited;
        clearTimeout(timer);
      }
    }
  }
}
void check().catch((error: unknown) => {
  process.stderr.write(
    `Core bootstrap acceptance failed: ${error instanceof Error ? error.stack : 'unknown error'}\n`,
  );
  process.exitCode = 1;
});

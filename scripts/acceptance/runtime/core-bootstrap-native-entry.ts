import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { DEFAULT_APP_CONFIG } from '../../../src/modules/config/types';
import { getAgentDir } from '../../../src/shared/platform/paths';
import { bootstrapDesktopOwner } from '../../../src/modules/app-shell/services/desktop-owner-bootstrap';
import { desktopCoreConnection } from '../../../src/modules/app-shell/services/desktop-core-connection';
import { getCloudAccountAdapter } from '../../../src/modules/cloud-account/ipc/cloud-account-adapter';
import { getConfigAdapter } from '../../../src/modules/config/ipc/config-adapter';
import { getAuditAdapter } from '../../../src/modules/proxy-gateway/ipc/audit-adapter';
import { ipcAuditRecorder } from '../../../src/modules/proxy-gateway/audit/ipc-audit-recorder';
import { CoreRpcClient } from '../../../src/core/rpc/client';
import { ManagementClient } from '../../../src/core/management/client';
import { getManagementEndpoint } from '../../../src/core/management/endpoint';
import {
  LARGE_THOUGHT_BYTES,
  LARGE_THOUGHT_SESSION,
  LARGE_THOUGHT_SIGNATURE,
} from './fixtures/thought-capacity';

/** Real core process and SQLite; presentation and keyring isolation belong to the launcher. */
async function check(): Promise<void> {
  const home = process.env.AGM_DIAGNOSTIC_TEST_HOME;
  assert(home);
  assert.equal(
    getManagementEndpoint(),
    getManagementEndpoint(process.platform, home),
    'Presentation endpoint must use the isolated home',
  );
  const directory = path.dirname(process.argv[1]);
  await fs.mkdir(getAgentDir(), { recursive: true });
  await fs.writeFile(
    path.join(getAgentDir(), 'gui_config.json'),
    JSON.stringify({
      ...DEFAULT_APP_CONFIG,
      proxy: {
        ...DEFAULT_APP_CONFIG.proxy,
        auto_start: false,
        api_key: randomUUID(),
        traffic_audit: { ...DEFAULT_APP_CONFIG.proxy.traffic_audit, enabled: true },
        thought_store: { ...DEFAULT_APP_CONFIG.proxy.thought_store, enabled: true },
      },
    }),
  );
  const children: ChildProcess[] = [];
  const connection = desktopCoreConnection(path.join(directory, 'main.cjs'), process.execPath);
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
    assert.deepEqual(await getCloudAccountAdapter().listViews(), []);
    process.stdout.write('Standalone-core account view passed.\n');
    assert.equal((await getConfigAdapter().read()).proxy.auto_start, false);
    const client = new CoreRpcClient(getManagementEndpoint(), undefined, handshake.epoch);
    assert.deepEqual(await client.localAccounts.listAccounts(), []);
    await client.openCode.status('http://127.0.0.1:8045');
    assert.equal((await client.gatewayStatus()).running, false);
    await client.thought.stats();
    if (process.env.AGM_DIAGNOSTIC_TEST_LARGE_THOUGHT === '1') {
      const records = await client.thought.records({ sessionKey: LARGE_THOUGHT_SESSION });
      assert.equal(records.length, 1);
      const expected = createHash('sha256');
      let remaining = LARGE_THOUGHT_BYTES;
      const block = Buffer.alloc(64 * 1024, 'T');
      while (remaining > 0) {
        const count = Math.min(remaining, block.length);
        expected.update(block.subarray(0, count));
        remaining -= count;
      }
      const digest = expected.update(LARGE_THOUGHT_SIGNATURE).digest('hex');
      for (let repeat = 0; repeat < 3; repeat += 1) {
        const opened = await client.thought.openRecord({
          sessionKey: LARGE_THOUGHT_SESSION,
          id: records[0].id,
        });
        assert(opened);
        assert.equal(opened.thoughtBytes, LARGE_THOUGHT_BYTES);
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
    await client.stopGateway();
    assert.equal((await client.gatewayStatus()).running, false);
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

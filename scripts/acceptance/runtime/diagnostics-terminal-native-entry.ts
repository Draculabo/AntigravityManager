import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_APP_CONFIG } from '../../../src/modules/config/types';
import { setServerConfig } from '../../../src/server/server-config';
import { TrafficAuditService } from '../../../src/modules/proxy-gateway/audit/traffic-audit.service';
import { ThoughtStoreService } from '../../../src/modules/proxy-gateway/thought-store/thought-store.service';
import { createIpcAuditRecorder } from '../../../src/modules/proxy-gateway/audit/ipc-audit-recorder';
import { createIpcCaptureOwner } from '../../../src/modules/proxy-gateway/audit/ipc-capture-owner';
import { createRemoteIpcAuditRecorder } from '../../../src/modules/proxy-gateway/audit/remote-ipc-audit-recorder';
import { MAX_AUDIT_BODY_BYTES } from '../../../src/modules/proxy-gateway/audit/audit-sanitizer';

/** Native test entry only: its launcher isolates homedir before any application import. */
async function check(): Promise<void> {
  const testHome = process.env.AGM_DIAGNOSTIC_TEST_HOME;
  assert(testHome, 'Run through test:core-diagnostics-terminal');
  assert.equal(path.resolve(os.homedir()), path.resolve(testHome));
  setServerConfig({
    ...DEFAULT_APP_CONFIG.proxy,
    auto_start: false,
    traffic_audit: { ...DEFAULT_APP_CONFIG.proxy.traffic_audit, enabled: true },
    thought_store: { ...DEFAULT_APP_CONFIG.proxy.thought_store, enabled: true },
  });
  const audit = new TrafficAuditService();
  const thought = new ThoughtStoreService();
  const reopenedAudit = new TrafficAuditService();
  const reopenedThought = new ThoughtStoreService();
  const stores = [audit, thought, reopenedAudit, reopenedThought];
  const failures: unknown[] = [];
  try {
    await Promise.all([audit.stats(), thought.stats()]);
    const secret = 'synthetic-secret-for-native-check';
    const signature = Buffer.from('synthetic native signature payload '.repeat(3)).toString(
      'base64',
    );
    const parent = audit.startParent({
      method: 'IPC',
      operation: 'native/check',
      protocol: 'ipc',
      trafficClass: 'ipc',
      url: '/ipc/native/check',
      requestBody: { access_token: secret, message: 'native request' },
    });
    assert(parent);
    audit.completeParent(parent, { outcome: 'completed', status: 200, responseBody: { ok: true } });
    const recorder = createIpcAuditRecorder(audit);
    await recorder.run(['native', 'record'], { sessionId: 'native-session' }, async () => ({
      output: { ok: true },
    }));
    recorder.closeAdmission();
    await recorder.drain();
    const captureOwner = createIpcCaptureOwner(audit);
    const remoteRecorder = createRemoteIpcAuditRecorder({
      endpoint: 'native-owner',
      ipcCapture: captureOwner,
    });
    const remoteText = 'native large input/output 你好 '.repeat(10_000);
    await remoteRecorder.run(
      ['native', 'remote-record'],
      { text: remoteText, access_token: secret },
      async () => ({ output: { text: remoteText } }),
    );
    const capacityText = 'x'.repeat(MAX_AUDIT_BODY_BYTES - 1);
    const capacityHash = createHash('sha256')
      .update('"')
      .update(capacityText)
      .update('"')
      .digest('hex');
    await remoteRecorder.run(['native', 'capacity'], null, () => ({ output: capacityText }));
    captureOwner.closeAdmission();
    await captureOwner.drain();
    thought.captureGeminiResponse(
      'native-session',
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  thought: true,
                  text: 'native persisted thought',
                  thoughtSignature: signature,
                },
              ],
            },
          },
        ],
      },
      'gemini',
    );

    await Promise.all([audit.shutdown(), thought.shutdown()]);
    await assert.rejects(() => audit.stats(), /shutting down/u);
    await assert.rejects(() => thought.getSession('native-session'), /shutting down/u);
    assert.equal(audit.isEnabled(), false);
    assert.equal(thought.isEnabled(), false);

    const detail = await reopenedAudit.detail(parent.id);
    assert(detail);
    const request = detail.bodies.find((body) => body.direction === 'request');
    assert(request);
    const page = await reopenedAudit.bodyPage({
      bodyId: request.id,
      cursor: 0,
      limitBytes: 256 * 1024,
    });
    assert(page);
    const body = page.chunks.map((chunk) => chunk.data).join('');
    assert(!body.includes(secret));
    assert(body.includes('native request'));
    const all = await reopenedAudit.list({ limit: 100, offset: 0 });
    assert(all.total >= 3);
    const remote = all.items.find((row) => row.url === '/ipc/native/remote-record');
    assert(remote);
    const remoteDetail = await reopenedAudit.detail(remote.id);
    assert(remoteDetail);
    for (const direction of ['request', 'response']) {
      const descriptor = remoteDetail.bodies.find((item) => item.direction === direction);
      assert(descriptor);
      assert.equal(descriptor.state, 'complete');
      assert.equal(descriptor.sha256Scope, 'full');
      let cursor = 0;
      const chunks: string[] = [];
      while (true) {
        const stored = await reopenedAudit.bodyPage({
          bodyId: descriptor.id,
          cursor,
          limitBytes: 256 * 1024,
        });
        assert(stored);
        chunks.push(...stored.chunks.map((chunk) => chunk.data));
        if (stored.nextCursor === null) {
          break;
        }
        cursor = stored.nextCursor;
      }
      const serialized = chunks.join('');
      assert(!serialized.includes(secret));
      assert.equal(JSON.parse(serialized).text, remoteText);
    }
    const capacity = all.items.find((row) => row.url === '/ipc/native/capacity');
    assert(capacity);
    const capacityDetail = await reopenedAudit.detail(capacity.id);
    const capacityBody = capacityDetail?.bodies.find((body) => body.direction === 'response');
    assert(capacityBody);
    assert.equal(capacityBody.state, 'complete');
    assert.equal(capacityBody.logicalBytes, MAX_AUDIT_BODY_BYTES + 1);
    assert.equal(capacityBody.storedBytes, MAX_AUDIT_BODY_BYTES);
    assert.equal(capacityBody.sha256, capacityHash);
    assert.equal(capacityBody.sha256Scope, 'full');
    assert.equal(capacityBody.oversized, true);
    assert.equal(capacityBody.partial, true);
    const records = await reopenedThought.getSession('native-session');
    assert.equal(records.length, 1);
    assert.equal(records[0].thought, 'native persisted thought');
    assert.equal(records[0].signature, signature);
  } catch (error) {
    failures.push(error);
  } finally {
    const results = await Promise.allSettled(stores.map((store) => store.shutdown()));
    failures.push(
      ...results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : [])),
    );
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Native diagnostic service check failed');
  }
  process.stdout.write(
    'Native diagnostic stores: write, redaction, prepared IPC body reopen, IPC drain, terminal close and no reuse passed\n',
  );
}

void check().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

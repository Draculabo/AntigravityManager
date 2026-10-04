import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-audit-native-'));

after(() => fs.rmSync(testDirectory, { recursive: true, force: true }));

function openWorker(name, workerName = 'traffic-audit') {
  const workerPath = path.resolve(__dirname, `../../../.vite/build/${workerName}.worker.js`);
  assert.ok(
    fs.existsSync(workerPath),
    'Build the production traffic audit worker with npm run start first',
  );
  const databasePath = path.join(testDirectory, `${name}.db`);
  const worker = new Worker(workerPath, { workerData: { databasePath } });
  let nextId = 0;
  async function command(operation, payload) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${operation} timed out`)), 15_000);
      const listener = (reply) => {
        if (reply.id !== id) {
          return;
        }
        clearTimeout(timer);
        worker.off('message', listener);
        if (reply.error) {
          reject(new Error(reply.error));
        } else {
          resolve(reply.result);
        }
      };
      worker.on('message', listener);
      worker.postMessage({ id, operation, payload });
    });
  }
  async function close() {
    await command('shutdown', null);
    await worker.terminate();
  }
  return { close, command, databasePath };
}

function parent(id, trafficClass, timestamp) {
  return {
    clientIp: null,
    id,
    method: 'POST',
    model: null,
    operation: null,
    protocol: 'openai',
    requestHeaders: '{}',
    requestQuery: null,
    sessionId: null,
    timestamp,
    trafficClass,
    url: '/v1/chat/completions',
    username: null,
  };
}

function finalize(id, text) {
  return {
    completedAt: Date.now(),
    droppedReason: null,
    errorSummary: null,
    id,
    logicalBytes: Buffer.byteLength(text),
    oversized: 0,
    parseErrorOffset: null,
    partial: 0,
    rawBytes: null,
    sha256: createHash('sha256').update(text).digest('hex'),
    sha256Scope: 'full',
    state: 'complete',
    terminalStatus: null,
  };
}

async function addBody(audit, requestId, payloadId, text) {
  await audit.command('beginPayload', {
    createdAt: Date.now(),
    direction: 'request',
    id: payloadId,
    kind: 'text',
    ownerId: requestId,
    ownerKind: 'parent',
    parentId: requestId,
    representation: 'sanitized_json',
  });
  for (let offset = 0, sequence = 0; offset < text.length; offset += 32_768, sequence += 1) {
    await audit.command('appendPayloadChunk', {
      data: text.slice(offset, offset + 32_768),
      payloadId,
      sequence,
    });
  }
  await audit.command('finalizePayload', finalize(payloadId, text));
}

function retention(maxRows, maxDiskBytes = 2_000_000_000) {
  return { bodyRetentionHours: 999, maxDiskBytes, maxRows, summaryRetentionDays: 999 };
}

function completedParent(id, overrides = {}) {
  return {
    cachedTokens: null,
    completedAt: Date.now(),
    durationMs: 12,
    error: null,
    hasImageOutput: false,
    hasTextOutput: true,
    id,
    inputTokens: 12,
    mappedModel: null,
    outcome: 'completed',
    outputTokens: 4,
    reasoningTokens: 2,
    responseHeaders: null,
    responsePartial: 0,
    status: 200,
    ...overrides,
  };
}

async function addAttempt(audit, parentId, id, attemptIndex, accountId, model, status, outcome) {
  await audit.command('insertAttempt', {
    accountId,
    accountIdHash: null,
    attemptIndex,
    endpoint: 'https://example.test/generate',
    id,
    model,
    operation: 'generate-content',
    parentId,
    requestHeaders: '{}',
    timestamp: Date.now(),
  });
  await audit.command('completeAttempt', {
    completedAt: Date.now(),
    durationMs: 5,
    error: null,
    id,
    outcome,
    responseHeaders: null,
    responsePartial: 0,
    status,
  });
}

async function list(audit, trafficClass) {
  return audit.command('list', { limit: 20, offset: 0, trafficClass });
}
export {
  __dirname,
  testDirectory,
  openWorker,
  parent,
  finalize,
  addBody,
  retention,
  completedParent,
  addAttempt,
  list,
};

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auditServiceMocks = vi.hoisted(() => ({
  beginParentSse: vi.fn(),
  completeParent: vi.fn(),
  finishSse: vi.fn(async () => undefined),
  startParent: vi.fn(() => ({ id: 'parent-1', startedAt: 1 })),
  writeSse: vi.fn(() => true),
}));

vi.mock('@/modules/proxy-gateway/audit/traffic-audit.service', () => ({
  trafficAuditService: {
    beginParentSse: auditServiceMocks.beginParentSse,
    completeAttempt: vi.fn(),
    completeParent: auditServiceMocks.completeParent,
    startAttempt: vi.fn(),
    startParent: auditServiceMocks.startParent,
  },
}));

import {
  captureHijackedHttpResponseChunk,
  completeHijackedHttpResponse,
  normalizeSseForAudit,
  registerTrafficAuditHttpHooks,
} from '@/modules/proxy-gateway/audit/traffic-audit-context';
import {
  MAX_AUDIT_BODY_BYTES,
  sanitizeAuditHeaders,
  sanitizeAuditUrl,
  snapshotAuditPayload,
} from '@/modules/proxy-gateway/audit/audit-sanitizer';
import { serializeAuditPayloadIncrementally } from '@/modules/proxy-gateway/audit/incremental-audit-serializer';
import { IncrementalSseRedactor } from '@/modules/proxy-gateway/audit/incremental-sse-redactor';
import { TrafficAuditRepository } from '@/modules/proxy-gateway/audit/traffic-audit.repository';
import { reconstructAuditSseResponse } from '@/modules/proxy-gateway/audit/traffic-audit-sse-reconstruction';
import { classifyHttpTraffic } from '@/modules/proxy-gateway/audit/traffic-classifier';
import {
  enforceThoughtSessionLimits,
  HARD_MAX_THOUGHT_SESSION_BYTES,
  HARD_MAX_THOUGHT_TURNS,
} from '@/modules/proxy-gateway/thought-store/thought-store.service';
import type { ThoughtRecord } from '@/modules/proxy-gateway/thought-store/thought-store.types';
import { preserveCorruptSqliteDatabase } from '@/shared/persistence/database/preserve-corrupt-sqlite';
import { BoundedSqliteWorker } from '@/shared/persistence/sqlite-worker/bounded-sqlite-worker';

let stateDirectory = '';

describe('traffic audit and Thought Store boundaries', () => {
  beforeEach(async () => {
    auditServiceMocks.beginParentSse.mockReset();
    auditServiceMocks.beginParentSse.mockReturnValue({
      finish: auditServiceMocks.finishSse,
      write: auditServiceMocks.writeSse,
    });
    auditServiceMocks.completeParent.mockClear();
    auditServiceMocks.finishSse.mockClear();
    auditServiceMocks.startParent.mockClear();
    auditServiceMocks.writeSse.mockClear();
    stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-audit-thought-'));
  });

  afterEach(async () => {
    await fs.rm(stateDirectory, { force: true, recursive: true });
  });

  it('classifies generation, auxiliary and system endpoints before persistence', () => {
    expect(classifyHttpTraffic('POST', '/v1/chat/completions')).toBe('model');
    expect(classifyHttpTraffic('POST', '/v1/responses')).toBe('model');
    expect(classifyHttpTraffic('POST', '/v1/messages')).toBe('model');
    expect(classifyHttpTraffic('POST', '/v1beta/models/gemini-3:streamGenerateContent')).toBe(
      'model',
    );
    expect(classifyHttpTraffic('GET', '/v1/models')).toBe('auxiliary');
    expect(classifyHttpTraffic('POST', '/v1beta/models/gemini-3:countTokens')).toBe('auxiliary');
    expect(classifyHttpTraffic('POST', '/v1/files')).toBe('auxiliary');
    expect(classifyHttpTraffic('GET', '/health')).toBe('system');
    expect(classifyHttpTraffic('GET', '/internal/audit/stats')).toBe('system');
  });

  it('redacts structured credentials before persistence while preserving ordinary prompt text', () => {
    const secret = 'secret-value';
    const headers = sanitizeAuditHeaders({
      Authorization: `Bearer ${secret}`,
      Cookie: `session=${secret}`,
      'x-client-label': 'desktop',
    });
    const url = sanitizeAuditUrl(
      `/v1/responses?access_token=${secret}&client=desktop&api_key=${secret}`,
    );
    const payload = snapshotAuditPayload({
      api_key: secret,
      nested: { refreshToken: secret },
      prompt: `The user deliberately typed token=${secret}`,
      media: {
        data: Buffer.from('image bytes').toString('base64'),
        mime_type: 'image/png',
      },
    });

    expect(headers).toEqual({
      Authorization: '[REDACTED]',
      Cookie: '[REDACTED]',
      'x-client-label': 'desktop',
    });
    expect(url).not.toContain(secret);
    expect(url).toContain('client=desktop');
    expect(payload.text).not.toContain(`"api_key":"${secret}"`);
    expect(payload.text).not.toContain(`"refreshToken":"${secret}"`);
    expect(payload.text).toContain(`token=${secret}`);
    expect(payload.text).toContain('"mime_type":"image/png"');
    expect(payload.text).not.toContain(Buffer.from('image bytes').toString('base64'));
  });

  it('summarizes an oversized audit body without retaining its raw content', () => {
    const raw = 'oversized-secret-free-body-'.repeat(64);
    const snapshot = snapshotAuditPayload(raw, 128);

    expect(MAX_AUDIT_BODY_BYTES).toBe(100 * 1024 * 1024);
    expect(snapshot).toMatchObject({ kind: 'oversized', oversized: true });
    expect(snapshot.bytes).toBe(Buffer.byteLength(raw));
    expect(snapshot.text).not.toContain(raw);
    expect(Buffer.byteLength(snapshot.text ?? '')).toBeLessThan(512);
  });

  it('streams a sanitized body in bounded chunks while retaining only the configured prefix', async () => {
    const chunks: string[] = [];
    const result = await serializeAuditPayloadIncrementally(
      {
        authorization: 'Bearer must-not-persist',
        prompt: 'hello'.repeat(200),
      },
      (chunk) => {
        chunks.push(chunk);
        return true;
      },
      128,
    );

    expect(result.logicalBytes).toBeGreaterThan(128);
    expect(result.storedBytes).toBe(128);
    expect(result.oversized).toBe(true);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(Buffer.byteLength(chunks.join(''), 'utf-8')).toBe(128);
    expect(chunks.join('')).not.toContain('must-not-persist');
    expect(chunks.join('')).toContain('[REDACTED]');
  });

  it('preserves UTF-8 and surrogate pairs across serialization and storage chunk boundaries', async () => {
    const value = { prompt: `${'x'.repeat(65_524)}😀中${'y'.repeat(16_383)}😀` };
    const chunks: string[] = [];
    const result = await serializeAuditPayloadIncrementally(value, (chunk) => {
      chunks.push(chunk);
      return true;
    });
    const serialized = JSON.stringify(value);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => Buffer.byteLength(chunk, 'utf8') <= 64 * 1024)).toBe(true);
    expect(chunks.join('')).toBe(serialized);
    expect(result.logicalBytes).toBe(Buffer.byteLength(serialized, 'utf8'));
    expect(result.storedBytes).toBe(result.logicalBytes);
    expect(result.sha256).toBe(createHash('sha256').update(serialized).digest('hex'));
  });

  it.skipIf(process.versions.modules !== '136')(
    'stores chunked bodies and deduplicates identical payloads only inside one parent request',
    async () => {
      const databasePath = path.join(stateDirectory, 'chunked-audit.db');
      const repository = new TrafficAuditRepository(databasePath);
      const parentId = '00000000-0000-4000-8000-000000000001';
      const attemptId = '00000000-0000-4000-8000-000000000002';
      const parentPayloadId = '00000000-0000-4000-8000-000000000003';
      const attemptPayloadId = '00000000-0000-4000-8000-000000000004';
      const body = '{"prompt":"hello"}';
      const sha256 = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';

      repository.execute({
        operation: 'insertParent',
        payload: {
          clientIp: null,
          id: parentId,
          method: 'POST',
          model: 'test-model',
          operation: null,
          protocol: 'openai',
          requestHeaders: '{}',
          requestQuery: null,
          sessionId: null,
          timestamp: 1,
          trafficClass: 'model',
          url: '/v1/chat/completions',
          username: null,
        },
      });
      repository.execute({
        operation: 'insertAttempt',
        payload: {
          accountId: null,
          accountIdHash: null,
          attemptIndex: 1,
          endpoint: 'https://example.test',
          id: attemptId,
          model: 'test-model',
          operation: 'generate',
          parentId,
          requestHeaders: '{}',
          timestamp: 2,
        },
      });

      for (const [id, ownerKind, ownerId] of [
        [parentPayloadId, 'parent', parentId],
        [attemptPayloadId, 'attempt', attemptId],
      ] as const) {
        repository.execute({
          operation: 'beginPayload',
          payload: {
            createdAt: 3,
            direction: 'request',
            id,
            kind: 'json',
            ownerId,
            ownerKind,
            parentId,
            representation: 'sanitized_json',
          },
        });
        repository.execute({
          operation: 'appendPayloadChunk',
          payload: { data: body, payloadId: id, sequence: 0 },
        });
        repository.execute({
          operation: 'finalizePayload',
          payload: {
            completedAt: 4,
            droppedReason: null,
            errorSummary: null,
            id,
            logicalBytes: Buffer.byteLength(body),
            oversized: 0,
            parseErrorOffset: null,
            partial: 0,
            rawBytes: null,
            sha256,
            sha256Scope: 'full',
            state: 'complete',
            terminalStatus: null,
          },
        });
      }

      const detail = repository.execute({ operation: 'detail', payload: { id: parentId } }) as {
        bodies: Array<{ id: string; ownerKind: string }>;
      };
      expect(detail.bodies).toHaveLength(2);
      expect(new Set(detail.bodies.map((entry) => entry.id))).toEqual(new Set([parentPayloadId]));

      const page = repository.execute({
        operation: 'bodyPage',
        payload: { bodyId: parentPayloadId, cursor: 0, limitBytes: 256 * 1024 },
      }) as { chunks: Array<{ data: string }> };
      expect(page.chunks.map((chunk) => chunk.data).join('')).toBe(body);
      repository.execute({ operation: 'shutdown', payload: null });
    },
  );

  it('rejects writes immediately when the bounded queue is saturated', async () => {
    const databasePath = path.join(stateDirectory, 'queue-test.db');
    const worker = new BoundedSqliteWorker({
      databasePath,
      maxPendingBytes: 1024,
      maxPendingCommands: 1,
      name: 'queue-test',
      workerFactory: (_filename, options) =>
        new Worker(
          `
            const { parentPort } = require('node:worker_threads');
            parentPort.on('message', (message) => {
              if (message.operation === 'shutdown') {
                parentPort.postMessage({ id: message.id, result: true });
                return;
              }
              setTimeout(() => parentPort.postMessage({ id: message.id, result: true }), 100);
            });
          `,
          { ...options, eval: true },
        ),
      workerPath: 'test-only',
    });

    expect(worker.tryWrite({ operation: 'write', payload: { value: 1 } })).toBe(true);
    expect(worker.tryWrite({ operation: 'write', payload: { value: 2 } })).toBe(false);
    await worker.close();
  });

  it('reserves queue capacity for model writes when background traffic is saturated', async () => {
    const worker = new BoundedSqliteWorker({
      databasePath: path.join(stateDirectory, 'priority-queue-test.db'),
      maxPendingBytes: 10_000,
      maxPendingCommands: 10,
      name: 'priority-queue-test',
      workerFactory: (_filename, options) =>
        new Worker(
          `
            const { parentPort } = require('node:worker_threads');
            parentPort.on('message', (message) => {
              if (message.operation === 'shutdown') {
                parentPort.postMessage({ id: message.id, result: true });
                return;
              }
              setTimeout(() => parentPort.postMessage({ id: message.id, result: true }), 25);
            });
          `,
          { ...options, eval: true },
        ),
      workerPath: 'test-only',
    });

    expect(
      worker.tryWrite(
        { operation: 'background-write', payload: { index: 0 } },
        { priority: 'background' },
      ),
    ).toBe(true);
    expect(
      worker.tryWrite(
        { operation: 'background-write', payload: { index: 4 } },
        { priority: 'background' },
      ),
    ).toBe(false);
    expect(
      worker.tryWrite(
        { operation: 'auxiliary-write', payload: { index: 1 } },
        { priority: 'auxiliary' },
      ),
    ).toBe(true);
    expect(
      worker.tryWrite(
        { operation: 'auxiliary-write', payload: { index: 2 } },
        { priority: 'auxiliary' },
      ),
    ).toBe(true);
    expect(
      worker.tryWrite(
        { operation: 'auxiliary-write', payload: { index: 3 } },
        { priority: 'auxiliary' },
      ),
    ).toBe(false);
    expect(
      worker.tryWrite({ operation: 'model-write', payload: { index: 5 } }, { priority: 'model' }),
    ).toBe(true);
    await worker.close();
  });

  it('bounds read/control requests separately from model writes', async () => {
    const worker = new BoundedSqliteWorker({
      databasePath: path.join(stateDirectory, 'control-queue-test.db'),
      maxPendingBytes: 10_000,
      maxPendingCommands: 10,
      name: 'control-queue-test',
      workerFactory: (_filename, options) =>
        new Worker(
          `
            const { parentPort } = require('node:worker_threads');
            parentPort.on('message', (message) => {
              if (message.operation === 'shutdown') {
                parentPort.postMessage({ id: message.id, result: true });
                return;
              }
              setTimeout(() => parentPort.postMessage({ id: message.id, result: true }), 25);
            });
          `,
          { ...options, eval: true },
        ),
      workerPath: 'test-only',
    });

    const first = worker.request({ operation: 'read', payload: null });
    await expect(worker.request({ operation: 'read', payload: null })).rejects.toThrow(
      'control queue is full',
    );
    expect(
      worker.tryWrite({ operation: 'model-write', payload: null }, { priority: 'model' }),
    ).toBe(true);
    await first;
    await worker.close();
  });

  it('reconstructs a complete response from valid SSE and retains malformed SSE verbatim', () => {
    const valid = [
      'data: {"id":"chat-1","choices":[{"index":0,"delta":{"role":"assistant","content":"hel"}}]}',
      '',
      'data: {"id":"chat-1","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":"stop"}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');

    expect(normalizeSseForAudit(valid)).toMatchObject({
      response: {
        choices: [
          {
            finish_reason: 'stop',
            message: { content: 'hello', role: 'assistant' },
          },
        ],
        id: 'chat-1',
      },
      stream: true,
    });
    const malformed = 'data: {not-json}\n\n';
    expect(normalizeSseForAudit(malformed)).toBe(malformed);
  });

  it('reconstructs wrapped Gemini Native SSE without losing thought or visible parts', () => {
    const raw = [
      'data: {"metadata":{"attempt":1},"response":{"candidates":[{"index":0,"content":{"role":"model","parts":[{"thought":true,"text":"reason"}]}}]}}',
      '',
      'data: {"metadata":{"attempt":1},"response":{"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"answer"}]},"finishReason":"STOP"}],"usageMetadata":{"thoughtsTokenCount":2}}}',
      '',
    ].join('\n');

    expect(normalizeSseForAudit(raw)).toMatchObject({
      response: {
        metadata: { attempt: 1 },
        response: {
          candidates: [
            {
              content: {
                parts: [{ thought: true, text: 'reason' }, { text: 'answer' }],
                role: 'model',
              },
              finishReason: 'STOP',
              index: 0,
            },
          ],
          usageMetadata: { thoughtsTokenCount: 2 },
        },
      },
      stream: true,
    });
  });

  it('reconstructs worker-side SSE while retaining unrecognized provider events', () => {
    const response = reconstructAuditSseResponse([
      {
        choices: [{ delta: { content: 'hello' }, finish_reason: 'stop', index: 0 }],
        id: 'chat-1',
      },
      { custom_provider_event: true },
    ]);

    expect(response).toEqual({
      _unrecognized_events: [{ custom_provider_event: true }],
      choices: [
        {
          finish_reason: 'stop',
          index: 0,
          message: { content: 'hello', role: 'assistant' },
        },
      ],
      id: 'chat-1',
      object: 'chat.completion',
    });
  });

  it('recursively redacts valid SSE JSON while retaining event framing', () => {
    const parsedEvents: unknown[] = [];
    const redactor = new IncrementalSseRedactor({
      onParsedEvent: (event) => parsedEvents.push(event),
    });
    const output = [
      ...redactor.push('event: message\nid: 7\ndata: {"authorization":"Bearer secret",'),
      ...redactor.push('"value":"ok"}\n\n'),
    ];
    const final = redactor.finish();
    output.push(...final.chunks);

    expect(output.join('')).toBe(
      'event: message\nid: 7\ndata: {"authorization":"[REDACTED]","value":"ok"}\n\n',
    );
    expect(final.result).toEqual({
      errorSummary: null,
      parseErrorOffset: null,
      terminalEventSeen: false,
    });
    expect(parsedEvents).toEqual([{ authorization: '[REDACTED]', value: 'ok' }]);
  });

  it('does not misclassify a valid SSE event above the former 1 MiB snapshot limit', () => {
    const text = 'x'.repeat(1024 * 1024 + 1);
    const redactor = new IncrementalSseRedactor();
    const output = redactor.push(`data: ${JSON.stringify({ text })}\n\n`);
    const final = redactor.finish();

    expect(final.result).toEqual({
      errorSummary: null,
      parseErrorOffset: null,
      terminalEventSeen: false,
    });
    expect(output.join('')).toContain(text);
  });

  it('keeps malformed SSE diagnostics but conservatively masks credentials and reports the offset', () => {
    const redactor = new IncrementalSseRedactor();
    const output = redactor.push(
      'data: {"api_key":"secret", "url":"https://user:pass@example.test/?access_token=secret"\n\n',
    );
    const final = redactor.finish();
    output.push(...final.chunks);

    expect(output.join('')).toContain('"api_key":"[REDACTED]"');
    expect(output.join('')).not.toContain('user:pass');
    expect(output.join('')).not.toContain('access_token=secret');
    expect(final.result.parseErrorOffset).toBe(0);
    expect(final.result.errorSummary).toBeTruthy();
  });

  it('captures a hijacked SSE response once across Fastify request wrappers', async () => {
    const hooks = new Map<string, (...args: unknown[]) => unknown>();
    registerTrafficAuditHttpHooks({
      addHook(name: string, hook: (...args: unknown[]) => unknown) {
        hooks.set(name, hook);
      },
    } as unknown as FastifyInstance);
    const raw = new EventEmitter();
    const request = {
      body: { metadata: { session_id: 'session-1' } },
      headers: { authorization: 'Bearer test' },
      ip: '127.0.0.1',
      method: 'POST',
      query: {},
      raw,
      url: '/v1/responses',
    } as unknown as FastifyRequest;
    const wrappedRequest = { ...request, raw } as FastifyRequest;
    const reply = {
      getHeaders: () => ({ 'content-type': 'text/event-stream' }),
      statusCode: 200,
    } as unknown as FastifyReply;

    await hooks.get('onRequest')?.(request, reply);
    await hooks.get('preHandler')?.(request);
    captureHijackedHttpResponseChunk(
      wrappedRequest,
      'data: {"response":{"status":"completed"},"type":"response.completed"}\n\n',
    );
    completeHijackedHttpResponse(wrappedRequest, reply);
    captureHijackedHttpResponseChunk(wrappedRequest, 'data: [DONE]\n\n');
    completeHijackedHttpResponse(wrappedRequest, reply);
    await vi.waitFor(() => expect(auditServiceMocks.completeParent).toHaveBeenCalledTimes(1));

    expect(auditServiceMocks.startParent).toHaveBeenCalledTimes(1);
    expect(auditServiceMocks.completeParent).toHaveBeenCalledTimes(1);
    expect(auditServiceMocks.completeParent).toHaveBeenCalledWith(
      { id: 'parent-1', startedAt: 1 },
      expect.objectContaining({
        outcome: 'completed',
        partial: false,
        responsePayloadHandled: true,
      }),
    );
    expect(auditServiceMocks.writeSse).toHaveBeenCalledWith(
      'data: {"response":{"status":"completed"},"type":"response.completed"}\n\n',
    );
  });

  it('treats an observed protocol terminal event as complete when the socket close races finish', async () => {
    const hooks = new Map<string, (...args: unknown[]) => unknown>();
    registerTrafficAuditHttpHooks({
      addHook(name: string, hook: (...args: unknown[]) => unknown) {
        hooks.set(name, hook);
      },
    } as unknown as FastifyInstance);
    const raw = new EventEmitter();
    const request = {
      body: { stream: true },
      headers: { authorization: 'Bearer test' },
      ip: '127.0.0.1',
      method: 'POST',
      query: {},
      raw,
      url: '/v1/messages',
    } as unknown as FastifyRequest;
    const reply = {
      getHeaders: () => ({ 'content-type': 'text/event-stream' }),
      statusCode: 200,
    } as unknown as FastifyReply;

    await hooks.get('onRequest')?.(request, reply);
    await hooks.get('preHandler')?.(request);
    captureHijackedHttpResponseChunk(
      request,
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    );
    completeHijackedHttpResponse(request, reply, { partial: true });
    await vi.waitFor(() => expect(auditServiceMocks.completeParent).toHaveBeenCalledTimes(1));

    expect(auditServiceMocks.finishSse).toHaveBeenCalledWith(
      expect.objectContaining({ partial: false, terminalStatus: 'completed' }),
    );
    expect(auditServiceMocks.completeParent).toHaveBeenCalledWith(
      { id: 'parent-1', startedAt: 1 },
      expect.objectContaining({ partial: false }),
    );
  });

  it('forwards streamed audit chunks incrementally without constructing a complete response', async () => {
    const hooks = new Map<string, (...args: unknown[]) => unknown>();
    registerTrafficAuditHttpHooks({
      addHook(name: string, hook: (...args: unknown[]) => unknown) {
        hooks.set(name, hook);
      },
    } as unknown as FastifyInstance);
    const raw = new EventEmitter();
    const request = {
      body: {},
      headers: { authorization: 'Bearer test' },
      ip: '127.0.0.1',
      method: 'POST',
      query: {},
      raw,
      url: '/v1/responses',
    } as unknown as FastifyRequest;
    const reply = {
      getHeaders: () => ({ 'content-type': 'text/event-stream' }),
      statusCode: 200,
    } as unknown as FastifyReply;

    await hooks.get('onRequest')?.(request, reply);
    await hooks.get('preHandler')?.(request);
    captureHijackedHttpResponseChunk(request, 'data: {"value":"first"}\n\n');
    captureHijackedHttpResponseChunk(request, 'data: {"value":"second"}\n\n');
    completeHijackedHttpResponse(request, reply);
    await vi.waitFor(() => expect(auditServiceMocks.completeParent).toHaveBeenCalledTimes(1));

    const completion = auditServiceMocks.completeParent.mock.calls.at(-1)?.[1] as {
      partial: boolean;
      responsePayloadHandled: boolean;
    };
    expect(completion.partial).toBe(false);
    expect(completion.responsePayloadHandled).toBe(true);
    expect(auditServiceMocks.writeSse).toHaveBeenCalledTimes(2);
  });

  it('enforces the 200-turn Thought Store ceiling even when config is larger', () => {
    const records = Array.from({ length: HARD_MAX_THOUGHT_TURNS + 1 }, (_, index) =>
      thoughtRecord(index, 'thought'),
    );

    enforceThoughtSessionLimits(records, {
      max_session_mib: 999,
      max_turns_per_session: 999,
    });

    expect(records).toHaveLength(HARD_MAX_THOUGHT_TURNS);
    expect(records[0]?.id).toBe('record-1');
  });

  it('enforces the 64 MiB Thought Store ceiling even when config is larger', () => {
    const oneMiBThought = 'x'.repeat(1024 * 1024);
    const records = Array.from({ length: 65 }, (_, index) => thoughtRecord(index, oneMiBThought));

    enforceThoughtSessionLimits(records, {
      max_session_mib: 999,
      max_turns_per_session: 999,
    });

    expect(records).toHaveLength(HARD_MAX_THOUGHT_SESSION_BYTES / (1024 * 1024));
    expect(records[0]?.id).toBe('record-1');
  });

  it('preserves a corrupt SQLite database and both sidecars before repair', async () => {
    const databasePath = path.join(stateDirectory, 'corrupt.db');
    await Promise.all([
      fs.writeFile(databasePath, 'db'),
      fs.writeFile(`${databasePath}-wal`, 'wal'),
      fs.writeFile(`${databasePath}-shm`, 'shm'),
    ]);

    const backupPath = preserveCorruptSqliteDatabase(databasePath);

    expect(backupPath).not.toBeNull();
    await expect(fs.readFile(backupPath!, 'utf-8')).resolves.toBe('db');
    await expect(fs.readFile(`${backupPath}-wal`, 'utf-8')).resolves.toBe('wal');
    await expect(fs.readFile(`${backupPath}-shm`, 'utf-8')).resolves.toBe('shm');
    await expect(fs.stat(databasePath)).rejects.toThrow();
  });
});

function thoughtRecord(index: number, thought: string): ThoughtRecord {
  return {
    createdAt: index,
    fingerprint: `fingerprint-${index}`,
    id: `record-${index}`,
    model: 'gemini-3.7-flash-high',
    oversized: false,
    oversizedBytes: null,
    oversizedSha256: null,
    signature: `signature-${index}`,
    sourceFamily: 'gemini',
    thought,
    toolIds: [],
    toolNames: [],
    visible: '',
  };
}

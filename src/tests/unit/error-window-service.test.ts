import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ErrorWindowService } from '@/modules/error-diagnostics/error-window.service';
import { logger } from '@/shared/logging/logger';
import { createDiagnosticErrorRecord } from '@/shared/observability/errorDiagnostic';
import { createErrorOwner } from '@/modules/error-diagnostics/error-owner.service';
import { createErrorDiagnosticRouter } from '@/modules/error-diagnostics/error-owner.router';
import { createErrorDiagnosticClient } from '@/modules/error-diagnostics/error-owner.client';
import { call } from '@orpc/server';
import { readDiagnosticContent } from '@/shared/observability/read-diagnostic-content';

let directory: string;
const owners: ErrorWindowService[] = [];
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-error-owner-'));
});
afterEach(async () => {
  const closed = await Promise.allSettled(owners.splice(0).map((owner) => owner.shutdown()));
  expect(closed.every((result) => result.status === 'fulfilled')).toBe(true);
  expect(path.dirname(path.resolve(directory))).toBe(path.resolve(os.tmpdir()));
  expect(path.basename(directory).startsWith('agm-error-owner-')).toBe(true);
  await fs.rm(directory, { recursive: true, force: true });
});
function owner(role: 'app' | 'core' = 'core') {
  const service = new ErrorWindowService({
    role,
    databasePath: path.join(directory, `${role}.db`),
    workerPath: path.resolve('dist/core/error-window.worker.js'),
  });
  owners.push(service);
  return service;
}

it('captures through the real logger and production Worker without storing normal refreshes or private arguments', async () => {
  const service = owner();
  service.attachLogger(logger);
  const error = new Error('decode Bearer fixture-secret');
  error.stack =
    'Error: decode Bearer fixture-secret\n    at decode (file.ts:3:4)\n' +
    '    at 帧😀 (file.ts:5:6)\n'.repeat(5000);
  const expected = createDiagnosticErrorRecord({
    error,
    role: 'core',
    source: 'logger',
    category: 'unclassified-error',
  });
  logger.error('decode failed', error, { privateBody: 'never-forward-fixture' });
  for (let index = 0; index < 250; index += 1) {
    logger.debug('normal refresh');
  }
  expect((await service.status()).fallbackRecords).toBe(1);
  await service.applyAllocation(32 * 1024 * 1024);
  await service.drain();
  const page = await service.query({});
  expect(page.records).toHaveLength(1);
  const detail = await service.detail(page.records[0].id);
  expect(detail).toMatchObject({
    role: 'core',
    source: 'logger',
    message: expected.message,
    stack: expected.stack,
    stackComplete: true,
    causes: expected.causes,
  });
  expect(JSON.stringify(detail)).not.toContain('fixture-secret');
  expect(JSON.stringify(detail)).not.toContain('never-forward-fixture');
  expect((await service.status()).counters).toMatchObject({
    captured: 1,
    accepted: 1,
    persisted: 1,
  });
});

it('retains bounded memory fallback before allocation and excludes other process roles', async () => {
  const service = owner();
  for (let index = 0; index < 100; index += 1) {
    service.capture({ error: `failure ${index}`, source: 'test', category: 'fixture' });
  }
  const before = await service.status();
  expect(before.storage.state).toBe('unavailable');
  expect(before.fallbackRecords).toBe(64);
  expect(before.fallbackBytes).toBeLessThanOrEqual(1024 * 1024);
  expect(before.counters.fallbackEvicted).toBe(36);
  await service.applyAllocation(32 * 1024 * 1024);
  await service.drain();
  const page = await service.query({ limit: 100 });
  expect(page.records).toHaveLength(64);
  expect(page.records[0].message).toBe('failure 36');
  expect(page.records.at(-1)?.message).toBe('failure 99');
  const app = owner('app');
  await app.applyAllocation(32 * 1024 * 1024);
  expect((await app.query({})).records).toEqual([]);
});

it('revokes in-flight detail reads and pending captures across clear while later errors survive', async () => {
  const service = owner();
  await service.applyAllocation(32 * 1024 * 1024);
  service.capture({ error: 'old', source: 'test', category: 'fixture' });
  await service.drain();
  const page = await service.query({});
  const detail = service.detail(page.records[0].id);
  const rejected = expect(detail).rejects.toThrow('invalidated');
  service.capture({ error: 'queued-old', source: 'test', category: 'fixture' });
  const clearing = service.clear();
  service.capture({ error: 'new-generation', source: 'test', category: 'fixture' });
  const receipt = await clearing;
  await rejected;
  expect(receipt.records).toBeGreaterThanOrEqual(1);
  await service.drain();
  expect((await service.query({})).records.map((record) => record.message)).toEqual([
    'new-generation',
  ]);
  expect(await service.detail(page.records[0].id)).toBeNull();
});

it('drains acknowledged records across terminal shutdown and reopen without accepting later captures', async () => {
  const service = owner();
  await service.applyAllocation(32 * 1024 * 1024);
  service.capture({ error: 'retained', source: 'test', category: 'fixture' });
  await service.shutdown();
  service.capture({ error: 'late', source: 'test', category: 'fixture' });
  await expect(service.applyAllocation(32 * 1024 * 1024)).rejects.toThrow('closed');
  const reopened = owner();
  await reopened.applyAllocation(32 * 1024 * 1024);
  expect((await reopened.query({})).records.map((record) => record.message)).toEqual(['retained']);
  expect((await service.status()).counters.rejected).toBe(1);
});

it('reports oversized diagnostics without retaining partial stacks as complete records', async () => {
  const service = owner();
  const error = new Error('too large');
  error.stack = 'x'.repeat(8 * 1024 * 1024 + 1);
  service.capture({ error, source: 'test', category: 'fixture' });
  expect(await service.status()).toMatchObject({
    fallbackRecords: 0,
    lastFailure: 'record_too_large',
    counters: { rejected: 1, accepted: 0, discarded: 1 },
  });
});

it('transfers complete diagnostic content through the owning ORPC contract and bounded chunk client', async () => {
  const service = owner();
  await service.applyAllocation(32 * 1024 * 1024);
  const error = new Error('complete');
  error.stack = 'Error: complete\n' + '    at 帧😀 (file.ts:1:2)\n'.repeat(12_000);
  service.capture({ error, source: 'test', category: 'fixture' });
  await service.drain();
  const source = createErrorOwner(() => service);
  const router = createErrorDiagnosticRouter(source);
  const client = createErrorDiagnosticClient({
    status: () => call(router.status, undefined),
    query: (input) => call(router.query, input),
    open: (input) => call(router.open, input),
    readContent: (input) => call(router.readContent, input),
    closeContent: (input) => call(router.closeContent, input),
    clear: () => call(router.clear, undefined),
  });
  try {
    expect((await client.status()).storage.state).toBe('ready');
    const page = await client.query({});
    const opened = await client.open({ id: page.records[0].id });
    expect(opened).not.toBeNull();
    if (!opened) {
      throw new Error('Expected complete diagnostic');
    }
    expect(JSON.stringify(opened)).not.toContain('at 帧');
    const full = await readDiagnosticContent(client, opened.transfer);
    const { StoredErrorRecordSchema } = await import('@/modules/error-diagnostics/error-record');
    const value: unknown = JSON.parse(full.toString('utf8'));
    expect(StoredErrorRecordSchema.parse(value)).toMatchObject({
      stack: error.stack,
      stackComplete: true,
    });
    const stale = await client.open({ id: page.records[0].id });
    expect(stale).not.toBeNull();
    await client.clear();
    if (stale) {
      const { epoch, capabilityId, kind, resourceId } = stale.transfer;
      await expect(
        client.readContent({ epoch, capabilityId, kind, resourceId, cursor: 0 }),
      ).rejects.toThrow('unavailable');
    }
    expect((await client.query({})).records).toEqual([]);
  } finally {
    source.closeAdmission();
    await source.drain();
  }
});

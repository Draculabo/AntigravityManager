// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readDiagnosticLogs } from '@/modules/app-shell/diagnostic-logs/read-logs';
import { sanitizeLogRecord } from '@/modules/app-shell/diagnostic-logs/sanitize-record';
import {
  createDiagnosticLogDesktopService,
  writeDiagnosticAttachment,
  selectDiagnosticLogOwner,
  readSelectedDiagnosticLogs,
} from '@/modules/app-shell/diagnostic-logs/desktop-service';
import * as paths from '@/shared/platform/paths';
import { isAuditManagementIpc } from '@/modules/proxy-gateway/audit/ipc-audit-policy';
import {
  LOG_ATTACHMENT_MAX_BYTES,
  LOG_SOURCE_MAX_BYTES,
  LOG_WINDOW_MS,
  type LogSource,
} from '@/modules/app-shell/diagnostic-logs/schema';

const directories: string[] = [];
afterEach(async () => {
  selectDiagnosticLogOwner({ mode: 'desktop-embedded' });
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function directory() {
  const result = await mkdtemp(path.join(os.tmpdir(), 'agm-diagnostic-test-'));
  directories.push(result);
  return result;
}
const until = Date.parse('2026-10-10T12:00:00.000Z');
const line = (time: number, message: string) =>
  `[${new Date(time).toISOString()}] [ERROR] ${message}\n`;
const source: LogSource = {
  role: 'app',
  text: line(until, '[Content removed]'),
  missing: false,
  truncated: false,
  removed: 1,
  records: 1,
};

describe('sanitized log attachments', () => {
  it('keeps standalone failures with the selected owner and excludes preview, save and discard from traffic auditing', async () => {
    const dir = await directory();
    vi.spyOn(paths, 'getAgentDir').mockReturnValue(dir);
    const date = new Date(until);
    const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    await writeFile(path.join(dir, `app-${day}.log`), line(until, 'app error'));
    await writeFile(path.join(dir, `core-${day}.log`), line(until, '{"status":599}'));
    const diagnosticLogs = vi.fn().mockRejectedValue(new Error('private core transport failure'));
    selectDiagnosticLogOwner({ mode: 'standalone-core', client: { diagnosticLogs } });
    const result = await readSelectedDiagnosticLogs(until);
    expect(
      result.map((entry) => ({ role: entry.role, missing: entry.missing, records: entry.records })),
    ).toEqual([
      { role: 'app', missing: false, records: 1 },
      { role: 'core', missing: true, records: 0 },
    ]);
    expect(result[1].text).toBe('');
    expect(diagnosticLogs).toHaveBeenCalledExactlyOnceWith(until);
    selectDiagnosticLogOwner({ mode: 'desktop-embedded' });
    expect((await readSelectedDiagnosticLogs(until)).map((entry) => entry.role)).toEqual(['app']);
    for (const route of ['prepare', 'save', 'discard']) {
      expect(isAuditManagementIpc(`app/diagnosticLogs/${route}`)).toBe(true);
    }
  });
  it('discards uncertain prose, bodies, identities and nested fields while retaining only validated diagnostics', () => {
    const message =
      'Synthetic provider failure ' +
      JSON.stringify({
        code: 'ECONNRESET',
        status: 502,
        durationMs: 12,
        hasExplicitProxy: true,
        accountId: 'synthetic-account',
        email: 'private@example.invalid',
        ip: '192.0.2.1',
        authorization: 'Bearer synthetic-secret',
        url: 'https://user:password@example.invalid',
        path: 'C:\\Users\\PrivateUser\\file',
        prompt: 'synthetic-private-prompt',
        request: { body: 'synthetic-request-body' },
        response: { body: 'synthetic-response-body' },
        toolArguments: { password: 'synthetic-tool-secret' },
        error: { stack: 'private stack' },
      });
    expect(sanitizeLogRecord(message)).toEqual({
      text: '[Content removed] {"code":"ECONNRESET","status":502,"durationMs":12,"hasExplicitProxy":true}',
      removed: true,
    });
    expect(sanitizeLogRecord('Unstructured Bearer synthetic-secret\nprivate prompt')).toEqual({
      text: '[Content removed]',
      removed: true,
    });
    expect(
      sanitizeLogRecord(
        '{"code":"SECRET_CODE","status":403,"success":false,"durationMs":"private"}',
      ),
    ).toEqual({ text: '[Content removed] {"status":403,"success":false}', removed: true });
    expect(sanitizeLogRecord('Upstream proxy is enabled but URL is not configured')).toEqual({
      text: 'Upstream proxy is enabled but URL is not configured',
      removed: false,
    });
  });

  it('selects the inclusive ten-minute window and rotating shards; never reads captures, backups or other roles', async () => {
    const dir = await directory();
    // Use a local-date filename to match Winston rotation on every test timezone.
    const day = new Date(until);
    const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    const original =
      line(until - LOG_WINDOW_MS - 1, 'too old') +
      line(until - LOG_WINDOW_MS, 'oldest selected') +
      line(until - 1, 'private first line\n{"prompt":"synthetic-body"}') +
      line(until + 1, 'future');
    await writeFile(path.join(dir, `app-${date}.log`), original);
    await writeFile(
      path.join(dir, `app-${date}.log.1`),
      line(until, 'failure {"code":"ETIMEDOUT","status":504}'),
    );
    await writeFile(path.join(dir, `core-${date}.log`), line(until, 'excluded core'));
    await writeFile(path.join(dir, 'account-backup.json'), 'synthetic-secret');
    await mkdir(path.join(dir, 'captures'));
    await writeFile(path.join(dir, 'captures', 'request.json'), 'synthetic-request');
    const result = await readDiagnosticLogs('app', until, dir);
    expect(result).toEqual({
      role: 'app',
      text:
        line(until - LOG_WINDOW_MS, '[Content removed]') +
        line(until - 1, '[Content removed]') +
        line(until, '[Content removed] {"code":"ETIMEDOUT","status":504}'),
      missing: false,
      truncated: false,
      removed: 3,
      records: 3,
    });
    expect(await readFile(path.join(dir, `app-${date}.log`), 'utf8')).toBe(original);
  });

  it('reports missing sources and incomplete lines and caps sanitized output at complete records', async () => {
    const dir = await directory();
    expect(await readDiagnosticLogs('core', until, dir)).toEqual({
      role: 'core',
      text: '',
      missing: true,
      truncated: false,
      removed: 0,
      records: 0,
    });
    const day = new Date(until);
    const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    await writeFile(
      path.join(dir, `app-${date}.log`),
      line(until, 'private').repeat(12000) + '[unfinished private log',
    );
    const result = await readDiagnosticLogs('app', until, dir);
    expect(result.truncated).toBe(true);
    expect(result.missing).toBe(false);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(LOG_SOURCE_MAX_BYTES);
    expect(result.text).not.toContain('private');
    expect(result.text.endsWith('\n')).toBe(true);
    expect(result.records).toBeGreaterThan(0);
    expect(result.removed).toBe(result.records);
  });

  it('saves the exact preview after cancellation, handles duplicate save and expires abandoned previews', async () => {
    let now = until;
    const write = vi.fn().mockResolvedValue(undefined);
    const choose = vi.fn().mockResolvedValueOnce(null).mockResolvedValue('/chosen/logs.txt');
    const read = vi.fn().mockResolvedValue([
      source,
      {
        ...source,
        role: 'core',
        missing: true,
        truncated: true,
        records: 0,
        text: '',
        removed: 0,
      },
    ]);
    const service = createDiagnosticLogDesktopService({ read, choose, write, now: () => now });
    const result = await service.prepare();
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') {
      throw new Error('Expected preview');
    }
    expect(read).toHaveBeenCalledWith(until);
    expect(result.preview.missing).toEqual(['core']);
    expect(result.preview.truncated).toBe(true);
    expect(result.preview.bytes).toBe(Buffer.byteLength(result.preview.text));
    expect(result.preview.bytes).toBeLessThanOrEqual(LOG_ATTACHMENT_MAX_BYTES);
    expect(write).not.toHaveBeenCalled();
    expect(await service.save(result.preview.id)).toEqual({ status: 'cancelled' });
    read.mockRejectedValue(new Error('raw private filesystem failure'));
    const saving = service.save(result.preview.id);
    expect(await service.save(result.preview.id)).toEqual({ status: 'busy' });
    expect(await saving).toEqual({ status: 'saved' });
    expect(write).toHaveBeenCalledExactlyOnceWith('/chosen/logs.txt', result.preview.text);
    expect(await service.save(result.preview.id)).toEqual({ status: 'expired' });
    expect(await service.prepare()).toEqual({ status: 'failed' });
    read.mockResolvedValue([source]);
    const next = await service.prepare();
    if (next.status !== 'ready') {
      throw new Error('Expected preview');
    }
    now += LOG_WINDOW_MS;
    expect(await service.save(next.preview.id)).toEqual({ status: 'expired' });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('fails closed for empty logs and allows retry after save failure without reading raw files', async () => {
    const write = vi
      .fn()
      .mockRejectedValueOnce(new Error('synthetic private path'))
      .mockResolvedValue(undefined);
    const read = vi
      .fn()
      .mockResolvedValueOnce([{ ...source, records: 0, text: '' }])
      .mockResolvedValue([source]);
    const service = createDiagnosticLogDesktopService({
      read,
      write,
      choose: async () => '/chosen/logs.txt',
      now: () => until,
    });
    expect(await service.prepare()).toEqual({ status: 'failed' });
    const result = await service.prepare();
    if (result.status !== 'ready') {
      throw new Error('Expected preview');
    }
    expect(await service.save(result.preview.id)).toEqual({ status: 'failed' });
    expect(await service.save(result.preview.id)).toEqual({ status: 'saved' });
    expect(read).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[0]).toEqual(write.mock.calls[1]);
  });

  it('writes a standalone attachment atomically and refuses to overwrite profile contents or non-text files', async () => {
    const dir = await directory();
    const profile = path.join(dir, 'profile');
    await mkdir(profile);
    const original = path.join(profile, 'app-2026-10-10.log');
    await writeFile(original, 'synthetic original');
    const destination = path.join(dir, 'attachment.txt');
    await writeDiagnosticAttachment(destination, source.text, profile);
    expect(await readFile(destination, 'utf8')).toBe(source.text);
    await expect(writeDiagnosticAttachment(original, source.text, profile)).rejects.toThrow(
      'destination is unavailable',
    );
    await expect(
      writeDiagnosticAttachment(path.join(profile, 'attachment.txt'), source.text, profile),
    ).rejects.toThrow('destination is unavailable');
    expect(await readFile(original, 'utf8')).toBe('synthetic original');
  });
});

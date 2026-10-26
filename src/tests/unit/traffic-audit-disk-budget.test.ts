import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  auditSqliteFilesBytes,
  auditDiskRejection,
  AuditDiskAdmissionError,
  toAuditDiskAdmissionError,
} from '@/modules/proxy-gateway/audit/traffic-audit-disk-budget';

let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-disk-meter-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  if (
    path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) ||
    !path.basename(directory).startsWith('agm-disk-meter-')
  ) {
    throw new Error('Unexpected meter fixture path');
  }
  fs.rmSync(directory, { recursive: true, force: true });
});
describe('audit disk measurement boundary', () => {
  it.each([
    { code: 'SQLITE_FULL', reason: 'audit_disk_full' },
    { code: 'SQLITE_READONLY_DBMOVED', reason: 'audit_read_only' },
  ])('projects $code using its native code and preserves the cause', ({ code, reason }) => {
    const failure = Object.assign(new Error('controlled private native context'), { code });
    expect(toAuditDiskAdmissionError(failure)).toMatchObject({
      reason,
      cause: failure,
      message: 'Traffic audit write rejected: ' + reason,
    });
    expect(
      toAuditDiskAdmissionError(
        Object.assign(new Error('not a disk error'), { code: 'SQLITE_CONSTRAINT' }),
      ),
    ).toBeNull();
  });
  it('counts DB, WAL and SHM actual UTF-8 bytes and only missing files as zero', () => {
    const file = path.join(directory, 'audit.db');
    fs.writeFileSync(file, 'abc');
    fs.writeFileSync(file + '-wal', '中文');
    fs.writeFileSync(file + '-shm', 'xy');
    expect(auditSqliteFilesBytes(file)).toBe(11);
    fs.unlinkSync(file + '-wal');
    expect(auditSqliteFilesBytes(file)).toBe(5);
    fs.unlinkSync(file + '-shm');
    fs.unlinkSync(file);
    expect(() => auditSqliteFilesBytes(file)).toThrow('audit_disk_usage_unknown');
  });
  it.each(['EACCES', 'EIO', 'EPERM'])(
    'retains unknown capacity on %s without leaking the path',
    (code) => {
      vi.spyOn(fs, 'statSync').mockImplementation(() => {
        throw Object.assign(new Error('private fixture path'), { code });
      });
      expect(() => auditSqliteFilesBytes(path.join(directory, 'audit.db'))).toThrow(
        'audit_disk_usage_unknown',
      );
      try {
        auditSqliteFilesBytes(path.join(directory, 'audit.db'));
      } catch (error) {
        expect(auditDiskRejection(error)).toBe('audit_disk_usage_unknown');
        expect(String(error)).not.toContain(directory);
        expect(String(error)).not.toContain('private fixture path');
      }
    },
  );
  it('accepts only the closed worker error projection', () => {
    for (const reason of [
      'audit_disk_budget',
      'audit_disk_usage_unknown',
      'audit_checkpoint_busy',
      'audit_reclaim_failed',
      'audit_read_only',
      'audit_disk_full',
    ] as const) {
      expect(auditDiskRejection(new Error(new AuditDiskAdmissionError(reason).message))).toBe(
        reason,
      );
      expect(
        auditDiskRejection(new Error(new AuditDiskAdmissionError(reason, undefined, true).message)),
      ).toBe(reason);
    }
    expect(auditDiskRejection(new Error('disk full: private arbitrary provider text'))).toBeNull();
  });
});

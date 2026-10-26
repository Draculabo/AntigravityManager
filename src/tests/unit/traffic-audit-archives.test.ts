import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditArchiveUsage } from '@/modules/proxy-gateway/audit/traffic-audit-archives';

let directory: string;
let databasePath: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-audit-archives-'));
  databasePath = path.join(directory, 'request-audit.db');
});
afterEach(() => {
  vi.restoreAllMocks();
  const target = path.resolve(directory);
  if (
    path.dirname(target) !== path.resolve(os.tmpdir()) ||
    !path.basename(target).startsWith('agm-audit-archives-')
  ) {
    throw new Error('Unexpected cleanup target');
  }
  fs.rmSync(target, { recursive: true, force: true });
});
describe('audit archive accounting', () => {
  it('counts only owned schema/corruption backup files and sidecars, without opening contents', () => {
    for (const [name, size] of [
      ['request-audit.db', 100],
      ['request-audit.db-wal', 200],
      ['request-audit.db-shm', 300],
      ['request-audit.db.schema-v3-backup-123', 5],
      ['request-audit.db.schema-v3-backup-123-wal', 7],
      ['request-audit.db.corrupt-456', 11],
      ['request-audit.db.corrupt-456-shm', 13],
      ['thought-store.db.corrupt-123', 17],
      ['request-audit.db.corrupt-secret', 19],
      ['request-audit.db.schema-v3-backup-123.extra', 23],
      ['unrelated.txt', 29],
    ] as const) {
      fs.writeFileSync(path.join(directory, name), Buffer.alloc(size, 33));
    }
    const read = vi.spyOn(fs, 'readFileSync');
    expect(auditArchiveUsage(databasePath)).toEqual({ status: 'complete', bytes: 36, files: 4 });
    expect(read).not.toHaveBeenCalled();
  });
  it('reports an empty completed inventory and never writes or deletes files', () => {
    expect(auditArchiveUsage(databasePath)).toEqual({ status: 'complete', bytes: 0, files: 0 });
    expect(fs.readdirSync(directory)).toEqual([]);
  });
  it('reports unknown for an inaccessible directory', () => {
    vi.spyOn(fs, 'opendirSync').mockImplementation(() => {
      throw new Error('synthetic EACCES');
    });
    expect(auditArchiveUsage(databasePath)).toEqual({ status: 'unknown' });
  });
  it('reports unknown rather than zero when a matching archive disappears during measurement', () => {
    fs.writeFileSync(`${databasePath}.corrupt-123`, 'x');
    vi.spyOn(fs, 'lstatSync').mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    });
    expect(auditArchiveUsage(databasePath)).toEqual({ status: 'unknown' });
  });
  it('does not descend into matching directories or follow symbolic links', () => {
    fs.mkdirSync(`${databasePath}.corrupt-123`);
    expect(auditArchiveUsage(databasePath)).toEqual({ status: 'unknown' });
  });
  it('treats a symbolic-link archive as unknown instead of following its target', () => {
    const filename = `${databasePath}.corrupt-123`;
    fs.writeFileSync(filename, 'placeholder');
    const original = fs.lstatSync;
    vi.spyOn(fs, 'lstatSync').mockImplementation((...args) => {
      const stat = Reflect.apply(original, fs, args);
      if (!stat) {
        throw new Error('Expected fixture file metadata');
      }
      stat.isFile = () => false;
      stat.isSymbolicLink = () => true;
      return stat;
    });
    expect(auditArchiveUsage(databasePath)).toEqual({ status: 'unknown' });
  });
  it('bounds the scan and closes its directory handle when entries exceed the budget', () => {
    fs.writeFileSync(path.join(directory, 'unrelated'), 'x');
    const dir = fs.opendirSync(directory);
    const entry = dir.readSync();
    if (!entry) {
      throw new Error('Missing fixture entry');
    }
    const read = vi.spyOn(dir, 'readSync').mockReturnValue(entry);
    const close = vi.spyOn(dir, 'closeSync');
    vi.spyOn(fs, 'opendirSync').mockReturnValue(dir);
    expect(auditArchiveUsage(databasePath)).toEqual({ status: 'unknown' });
    expect(read).toHaveBeenCalledTimes(4096);
    expect(close).toHaveBeenCalledOnce();
  });
});

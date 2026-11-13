import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditBodyForExport } from '@/modules/proxy-gateway/audit/audit-body-export';
import { createAuditFileOwner } from '@/modules/proxy-gateway/audit/audit-file-owner.service';
import type {
  TrafficAuditBodyDescriptor,
  TrafficAuditBodyPage,
} from '@/modules/proxy-gateway/audit/traffic-audit.types';

const body: TrafficAuditBodyDescriptor = {
  chunkCount: 2,
  completedAt: 1,
  direction: 'response',
  droppedReason: null,
  errorSummary: null,
  id: '00000000-0000-4000-8000-000000000001',
  kind: 'text',
  logicalBytes: 6,
  oversized: false,
  ownerId: 'parent',
  ownerKind: 'parent',
  parseErrorOffset: null,
  partial: false,
  representation: 'sanitized_text',
  sha256: null,
  sha256Scope: 'unavailable',
  state: 'complete',
  storedBytes: 6,
  terminalStatus: 'completed',
};
const read = vi.fn<() => Promise<TrafficAuditBodyPage | null>>();
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'agm-export-snapshot-'));
  read.mockReset();
});
afterEach(async () => {
  const target = path.resolve(directory);
  if (
    path.dirname(target) !== path.resolve(os.tmpdir()) ||
    !path.basename(target).startsWith('agm-export-snapshot-')
  ) {
    throw new Error('Unexpected cleanup target');
  }
  await rm(target, { recursive: true, force: true });
});
function page(data: string, cursor: number | null): TrafficAuditBodyPage {
  return {
    body,
    chunks: [{ data, sequence: cursor === null ? 1 : 0 }],
    complete: cursor === null,
    nextCursor: cursor,
  };
}
describe('saved audit export consistency', () => {
  for (const empty of [false, true]) {
    it(`exports ${empty ? 'a captured empty body' : 'an actual partial prefix'} without inventing missing content`, async () => {
      const captured: TrafficAuditBodyDescriptor = empty
        ? { ...body, kind: 'empty', storedBytes: 0, logicalBytes: 0, chunkCount: 0 }
        : {
            ...body,
            state: 'incomplete',
            partial: true,
            droppedReason: 'audit_disk_budget',
            storedBytes: 3,
            logicalBytes: 99,
            chunkCount: 1,
            sha256Scope: 'stored_prefix',
          };
      read.mockResolvedValue({
        body: captured,
        chunks: empty ? [] : [{ data: 'abc', sequence: 0 }],
        complete: true,
        nextCursor: null,
      });
      const filePath = path.join(directory, 'saved.txt');
      const owner = createAuditFileOwner({
        harContent: async function* () {
          throw new Error('HAR is outside this body fixture');
        },
        bodyContent: (id) => auditBodyForExport(id, read),
        sessionContent: () => {
          throw new Error('Session export is outside this body fixture');
        },
      });
      await expect(owner.exportBody({ bodyId: captured.id, filePath })).resolves.toEqual({
        status: 'saved',
      });
      await owner.drain();
      expect(await readFile(filePath, 'utf8')).toBe(empty ? '' : 'abc');
    });
  }
  it('exports a complete bounded snapshot and rechecks metadata after final consumer writes', async () => {
    read
      .mockResolvedValueOnce(page('abc', 1))
      .mockResolvedValueOnce(page('def', null))
      .mockResolvedValueOnce(page('abc', 1));
    const pieces = [];
    for await (const piece of auditBodyForExport(body.id, read)) {
      pieces.push(piece);
    }
    expect(pieces).toEqual(['abc', 'def']);
    expect(read).toHaveBeenCalledTimes(3);
  });
  for (const state of [
    'missing',
    'writing',
    'expired',
    'changed',
    'missing-tail',
    'missing-after-final',
  ]) {
    it(`retains the destination and removes partial temporary output for ${state}`, async () => {
      const filePath = path.join(directory, 'saved.txt');
      await writeFile(filePath, 'keep destination');
      if (state === 'missing') {
        read.mockResolvedValue(null);
      }
      if (state === 'writing' || state === 'expired') {
        read.mockResolvedValue({ ...page('abc', 1), body: { ...body, state } });
      }
      if (state === 'changed') {
        read
          .mockResolvedValueOnce(page('abc', 1))
          .mockResolvedValueOnce({ ...page('def', null), body: { ...body, storedBytes: 9 } });
      }
      if (state === 'missing-tail') {
        read.mockResolvedValueOnce(page('abc', 1)).mockResolvedValue(null);
      }
      if (state === 'missing-after-final') {
        read.mockResolvedValueOnce(page('abcdef', null)).mockResolvedValue(null);
      }
      const owner = createAuditFileOwner({
        harContent: async function* () {
          throw new Error('HAR is outside this body fixture');
        },
        bodyContent: (id) => auditBodyForExport(id, read),
        sessionContent: () => {
          throw new Error('Session export is outside this body fixture');
        },
      });
      await expect(owner.exportBody({ bodyId: body.id, filePath })).rejects.toThrow(
        'Audit export is unavailable.',
      );
      await owner.drain();
      expect(await readFile(filePath, 'utf8')).toBe('keep destination');
      expect(await readdir(directory)).toEqual(['saved.txt']);
    });
  }
  it('rejects inconsistent byte counts and a cursor that makes no progress', async () => {
    read.mockResolvedValueOnce(page('abc', null)).mockResolvedValueOnce(page('abc', null));
    await expect(async () => {
      for await (const _piece of auditBodyForExport(body.id, read)) {
        /* consume */
      }
    }).rejects.toThrow('incomplete');
    read.mockReset().mockResolvedValue(page('abc', 0));
    await expect(async () => {
      for await (const _piece of auditBodyForExport(body.id, read)) {
        /* consume */
      }
    }).rejects.toThrow('cursor');
  });
});

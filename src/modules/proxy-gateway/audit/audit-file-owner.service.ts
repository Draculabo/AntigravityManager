import { randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { trafficAuditService } from './traffic-audit.service';
import { MAX_AUDIT_BODY_BYTES } from './audit-sanitizer';
import {
  AuditFileOwnerError,
  type AuditFileExportInput,
  type AuditSessionFileExportInput,
  type AuditHarFileExportInput,
} from './audit-file-owner.schema';

type BodySource = Pick<typeof trafficAuditService, 'bodyContent' | 'sessionContent' | 'harContent'>;

/** File contents stay with the selected owner, including exports above the RPC response cap. */
export function createAuditFileOwner(source: BodySource = trafficAuditService) {
  let accepting = true;
  let tail = Promise.resolve();
  const active = new Set<Promise<unknown>>();
  return {
    closeAdmission() {
      accepting = false;
    },
    async drain() {
      await Promise.allSettled([...active]);
    },
    exportBody(input: AuditFileExportInput) {
      return exportStream(input.filePath, () => source.bodyContent(input.bodyId));
    },
    exportSession(input: AuditSessionFileExportInput) {
      return exportStream(input.filePath, () => source.sessionContent(input.sessionId));
    },
    exportHar(input: AuditHarFileExportInput) {
      return exportStream(input.filePath, () => source.harContent(input.requestId));
    },
  };
  function exportStream(filePath: string, content: () => AsyncGenerator<string>) {
    if (!accepting) {
      return Promise.reject(new AuditFileOwnerError());
    }
    const work = tail.then(async () => {
      const temporaryPath = path.join(
        path.dirname(filePath),
        `.${path.basename(filePath)}.${randomUUID()}.tmp`,
      );
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(temporaryPath, 'wx', 0o600);
        let bytes = 0;
        for await (const chunk of content()) {
          const buffer = Buffer.from(chunk, 'utf8');
          bytes += buffer.byteLength;
          if (bytes > MAX_AUDIT_BODY_BYTES) {
            throw new AuditFileOwnerError();
          }
          await handle.writeFile(buffer);
        }
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temporaryPath, filePath);
        if (process.platform !== 'win32') {
          const directory = await open(path.dirname(filePath), 'r');
          try {
            await directory.sync();
          } finally {
            await directory.close();
          }
        }
        return { status: 'saved' as const };
      } catch {
        await handle?.close().catch(() => undefined);
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw new AuditFileOwnerError();
      }
    });
    tail = work.then(
      () => undefined,
      () => undefined,
    );
    active.add(work);
    void work.then(
      () => active.delete(work),
      () => active.delete(work),
    );
    return work;
  }
}

export const auditFileOwner = createAuditFileOwner();
export type AuditFileOperations = Pick<
  ReturnType<typeof createAuditFileOwner>,
  'exportBody' | 'exportSession' | 'exportHar'
>;

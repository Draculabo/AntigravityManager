import { randomUUID } from 'node:crypto';
import { readDiagnosticContent } from '@/shared/observability/read-diagnostic-content';
import type { ErrorDiagnosticOperations } from './error-owner.service';
import type { ErrorDiagnosticRole } from './error-window.database';
import { ErrorPreviewSchema } from './error-desktop.schema';
import { decodeErrorRecord } from './error-record';

interface Dependencies {
  source(role: ErrorDiagnosticRole): ErrorDiagnosticOperations;
  choose(filename: string): Promise<string | null>;
  write(destination: string, body: string, beforeCommit: () => void): Promise<void>;
  now(): number;
}
const TTL_MS = 10 * 60 * 1000;
const MAX_PREVIEW_BYTES = 64 * 1024;
interface Snapshot {
  role: ErrorDiagnosticRole;
  generation: string;
  body: string;
  expires: number;
  saving: boolean;
  epoch: number;
}

/** Full records stay in main; renderer save requests contain only reviewed capability IDs. */
export function createErrorDesktopService(dependencies: Dependencies) {
  const snapshots = new Map<string, Snapshot>();
  const epochs = { app: 0, core: 0 };
  let preparing = false;
  const prune = () => {
    for (const [id, snapshot] of snapshots) {
      if (snapshot.expires <= dependencies.now() && !snapshot.saving) {
        snapshots.delete(id);
      }
    }
  };
  const current = (id: string, snapshot: Snapshot) => {
    if (
      snapshots.get(id) !== snapshot ||
      snapshot.expires <= dependencies.now() ||
      snapshot.epoch !== epochs[snapshot.role]
    ) {
      throw new Error('Local error diagnostic export was invalidated');
    }
  };
  return {
    async prepare(role: ErrorDiagnosticRole, id: string) {
      if (preparing) {
        return { status: 'busy' as const };
      }
      preparing = true;
      const epoch = epochs[role];
      try {
        prune();
        const source = dependencies.source(role);
        const opened = await source.open({ id });
        if (!opened) {
          return { status: 'missing' as const };
        }
        const bytes = await readDiagnosticContent(source, opened.transfer);
        if (epoch !== epochs[role]) {
          throw new Error('Local error diagnostic preview was invalidated');
        }
        const record = decodeErrorRecord(bytes.toString('utf8'));
        if (record.role !== role || record.id !== id) {
          throw new Error('Local error diagnostic source mismatch');
        }
        const body = JSON.stringify(record);
        const readable = [
          `${record.createdAt} [${role}] ${record.source} / ${record.category}`,
          `Request: ${record.requestId ?? 'unavailable'} | Attempt: ${record.attemptId ?? 'unavailable'}`,
          `Stage: ${record.stage ?? 'unavailable'} | Function: ${record.functionName ?? 'unavailable'}`,
          record.message,
          record.stack ?? '[stack unavailable]',
          ...record.causes.map(
            (cause) => `${cause.name}: ${cause.message}\n${cause.stack ?? '[stack unavailable]'}`,
          ),
        ].join('\n\n');
        const previewBytes = Buffer.from(readable, 'utf8');
        let end = Math.min(previewBytes.length, MAX_PREVIEW_BYTES);
        while (end < previewBytes.length && (previewBytes[end] & 0xc0) === 0x80) {
          end -= 1;
        }
        while (snapshots.size >= 4) {
          const oldest = [...snapshots].find(([, snapshot]) => !snapshot.saving);
          if (!oldest) {
            return { status: 'busy' as const };
          }
          snapshots.delete(oldest[0]);
        }
        const capabilityId = randomUUID();
        const generation = opened.transfer.resourceId.slice(
          0,
          opened.transfer.resourceId.indexOf('/'),
        );
        if (!/^[0-9a-f-]{36}$/u.test(generation)) {
          throw new Error('Local error diagnostic generation is invalid');
        }
        snapshots.set(capabilityId, {
          role,
          epoch,
          generation,
          body,
          expires: dependencies.now() + TTL_MS,
          saving: false,
        });
        return {
          status: 'ready' as const,
          preview: ErrorPreviewSchema.parse({
            capabilityId,
            role,
            id,
            text: previewBytes.subarray(0, end).toString('utf8'),
            truncated: end < previewBytes.length,
            bytes: bytes.length,
          }),
        };
      } catch {
        return { status: 'failed' as const };
      } finally {
        preparing = false;
      }
    },
    async save(id: string) {
      prune();
      const snapshot = snapshots.get(id);
      if (!snapshot) {
        return { status: 'expired' as const };
      }
      if (snapshot.saving) {
        return { status: 'busy' as const };
      }
      snapshot.saving = true;
      try {
        const destination = await dependencies.choose(
          `antigravity-manager-${snapshot.role}-error.txt`,
        );
        if (!destination) {
          return { status: 'cancelled' as const };
        }
        current(id, snapshot);
        const page = await dependencies.source(snapshot.role).query({ limit: 1 });
        if (page.generation !== snapshot.generation) {
          snapshots.delete(id);
          return { status: 'expired' as const };
        }
        await dependencies.write(destination, snapshot.body + '\n', () => current(id, snapshot));
        snapshots.delete(id);
        return { status: 'saved' as const };
      } catch {
        return { status: 'failed' as const };
      } finally {
        snapshot.saving = false;
      }
    },
    discard(id: string) {
      snapshots.delete(id);
    },
    async clear(role: ErrorDiagnosticRole) {
      epochs[role] += 1;
      for (const [id, snapshot] of snapshots) {
        if (snapshot.role === role) {
          snapshots.delete(id);
        }
      }
      return dependencies.source(role).clear();
    },
  };
}

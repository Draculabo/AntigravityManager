import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { getAgentDir } from '@/shared/platform/paths';
import type { CoreRpcClient } from '@/core/rpc/client';
import { writeFileAtomic } from '@/shared/persistence/atomic-json-file';
import { readDiagnosticLogs } from './read-logs';
import {
  LOG_ATTACHMENT_MAX_BYTES,
  LOG_WINDOW_MS,
  LogSourceSchema,
  type LogPreview,
  type LogSource,
} from './schema';

type Selection =
  | { mode: 'desktop-embedded' }
  | { mode: 'standalone-core'; client: Pick<CoreRpcClient, 'diagnosticLogs'> };
let selected: Selection = { mode: 'desktop-embedded' };
export function selectDiagnosticLogOwner(selection: Selection): void {
  selected = selection;
}

export async function readSelectedDiagnosticLogs(until: number): Promise<LogSource[]> {
  const owner = selected;
  const app = await readDiagnosticLogs('app', until);
  if (owner.mode === 'desktop-embedded') {
    return [app];
  }
  try {
    const core = LogSourceSchema.parse(await owner.client.diagnosticLogs(until));
    if (core.role !== 'core') {
      throw new Error('Unexpected diagnostic source');
    }
    return [app, core];
  } catch {
    return [
      app,
      { role: 'core', text: '', missing: true, truncated: false, removed: 0, records: 0 },
    ];
  }
}

interface Dependencies {
  read(until: number): Promise<LogSource[]>;
  choose(filename: string): Promise<string | null>;
  write(filePath: string, text: string): Promise<void>;
  now(): number;
}

/** Main retains the reviewed snapshot; save accepts a capability, never renderer file contents. */
export function createDiagnosticLogDesktopService(dependencies: Dependencies) {
  const snapshots = new Map<string, { preview: LogPreview; expires: number; saving: boolean }>();
  let preparing = false;
  const prune = () => {
    for (const [id, snapshot] of snapshots) {
      if (!snapshot.saving && snapshot.expires <= dependencies.now()) {
        snapshots.delete(id);
      }
    }
  };
  return {
    async prepare() {
      if (preparing) {
        return { status: 'failed' as const };
      }
      preparing = true;
      try {
        prune();
        const until = dependencies.now();
        const sources = await dependencies.read(until);
        const missing = sources.filter((source) => source.missing).map((source) => source.role);
        const truncated = sources.some((source) => source.truncated);
        const removed = sources.reduce((sum, source) => sum + source.removed, 0);
        let text = `Sanitized diagnostic logs\nWindow: ${new Date(until - LOG_WINDOW_MS).toISOString()} to ${new Date(until).toISOString()}\nMissing/unavailable sources: ${missing.join(', ') || 'none'}\nTruncated: ${truncated}\nRecords with content removed: ${removed}\n\n`;
        for (const source of sources) {
          text += `--- ${source.role} (${source.records} records) ---\n${source.text || '[No records in this window]\n'}\n`;
        }
        const bytes = Buffer.byteLength(text);
        if (bytes > LOG_ATTACHMENT_MAX_BYTES || !sources.some((source) => source.records > 0)) {
          return { status: 'failed' as const };
        }
        const preview: LogPreview = { id: randomUUID(), text, bytes, missing, truncated, removed };
        // At most four 1 MiB snapshots; abandoned previews expire after ten minutes.
        if (snapshots.size >= 4) {
          const oldest = [...snapshots].find(([, snapshot]) => !snapshot.saving);
          if (!oldest) {
            return { status: 'failed' as const };
          }
          snapshots.delete(oldest[0]);
        }
        snapshots.set(preview.id, { preview, expires: until + LOG_WINDOW_MS, saving: false });
        return { status: 'ready' as const, preview };
      } catch {
        return { status: 'failed' as const };
      } finally {
        preparing = false;
      }
    },
    discard(id: string) {
      if (!snapshots.get(id)?.saving) {
        snapshots.delete(id);
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
        const destination = await dependencies.choose('antigravity-manager-sanitized-logs.txt');
        if (!destination) {
          return { status: 'cancelled' as const };
        }
        await dependencies.write(destination, snapshot.preview.text);
        snapshots.delete(id);
        return { status: 'saved' as const };
      } catch {
        return { status: 'failed' as const };
      } finally {
        snapshot.saving = false;
      }
    },
  };
}

export async function writeDiagnosticAttachment(
  filePath: string,
  text: string,
  profileDirectory = getAgentDir(),
) {
  const destinationDirectory = await realpath(path.dirname(filePath));
  const profile = await realpath(profileDirectory).catch(() => path.resolve(profileDirectory));
  const relative = path.relative(profile, destinationDirectory);
  // Export must not replace logger files, account backups or other profile contents.
  if (
    !path.isAbsolute(filePath) ||
    path.extname(filePath).toLowerCase() !== '.txt' ||
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  ) {
    throw new Error('Diagnostic attachment destination is unavailable');
  }
  await writeFileAtomic(filePath, text, { mode: 0o600 });
}

import { lstat, open, opendir } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { getAgentDir } from '@/shared/platform/paths';
import { LOG_SOURCE_MAX_BYTES, LOG_WINDOW_MS, type LogSource } from './schema';
import { sanitizeLogRecord } from './sanitize-record';

const MAX_SCAN_BYTES = 16 * 1024 * 1024;
const MAX_RECORD_BYTES = 64 * 1024;
const HEADER =
  /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\] \[(INFO|WARN|ERROR|DEBUG)\] (.*)$/;

function localDate(time: number): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Reads only rotating logger files; raw bytes never leave this owner. */
export async function readDiagnosticLogs(
  role: LogSource['role'],
  until: number,
  directory: string = getAgentDir(),
): Promise<LogSource> {
  const result: LogSource = {
    role,
    text: '',
    missing: false,
    truncated: false,
    removed: 0,
    records: 0,
  };
  const dates = new Set([localDate(until), localDate(until - LOG_WINDOW_MS)]);
  const files: { name: string; date: string; shard: number }[] = [];
  try {
    const entries = await opendir(directory);
    let visited = 0;
    for await (const entry of entries) {
      if (++visited > 4096) {
        result.truncated = true;
        break;
      }
      const match = entry.name.match(
        new RegExp(`^${role}-(\\d{4}-\\d{2}-\\d{2})\\.log(?:\\.(\\d+))?$`),
      );
      if (entry.isFile() && match && dates.has(match[1])) {
        files.push({ name: entry.name, date: match[1], shard: Number(match[2] ?? 0) });
      }
    }
  } catch {
    return { ...result, missing: true };
  }
  files.sort((a, b) => b.date.localeCompare(a.date) || b.shard - a.shard);
  if (files.length === 0) {
    return { ...result, missing: true };
  }
  let scanned = 0;
  const records: { time: number; text: string; removed: boolean }[] = [];
  for (const file of files.slice(0, 32)) {
    if (scanned >= MAX_SCAN_BYTES) {
      result.truncated = true;
      break;
    }
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      // Resolve again before opening: a replaced entry must not redirect the reader through a symlink.
      const filePath = path.join(directory, file.name);
      const before = await lstat(filePath);
      if (!before.isFile()) {
        result.missing = true;
        continue;
      }
      handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev) {
        result.missing = true;
        continue;
      }
      const size = Math.min(stat.size, MAX_SCAN_BYTES - scanned);
      const offset = stat.size - size;
      result.truncated ||= offset > 0;
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await handle.read(buffer, 0, size, offset);
      scanned += bytesRead;
      let text = buffer.subarray(0, bytesRead).toString('utf8');
      if (offset > 0) {
        text = text.slice(text.indexOf('\n') + 1);
      }
      if (!text.endsWith('\n')) {
        result.truncated = true;
        text = text.slice(0, Math.max(0, text.lastIndexOf('\n') + 1));
      }
      let pending: { time: number; level: string; message: string; oversized: boolean } | undefined;
      const flush = () => {
        if (!pending || pending.time < until - LOG_WINDOW_MS || pending.time > until) {
          return;
        }
        const safe = sanitizeLogRecord(pending.oversized ? '' : pending.message);
        records.push({
          time: pending.time,
          text: `[${new Date(pending.time).toISOString()}] [${pending.level}] ${safe.text}\n`,
          removed: safe.removed,
        });
      };
      for (const line of text.split('\n')) {
        const match = line.replace(/\r$/, '').match(HEADER);
        if (match && Number.isFinite(Date.parse(match[1]))) {
          flush();
          pending = {
            time: Date.parse(match[1]),
            level: match[2],
            message: match[3].slice(0, MAX_RECORD_BYTES),
            oversized: match[3].length > MAX_RECORD_BYTES,
          };
          result.truncated ||= pending.oversized;
        } else if (pending && line.trim()) {
          if (pending.message.length + line.length > MAX_RECORD_BYTES) {
            pending.oversized = true;
            result.truncated = true;
          } else if (!pending.oversized) {
            pending.message += `\n${line}`;
          }
        }
      }
      flush();
    } catch {
      result.missing = true;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  result.truncated ||= files.length > 32;
  records.sort((a, b) => b.time - a.time);
  let bytes = 0;
  const kept: string[] = [];
  for (const record of records) {
    const length = Buffer.byteLength(record.text);
    if (bytes + length > LOG_SOURCE_MAX_BYTES) {
      result.truncated = true;
      break;
    }
    kept.push(record.text);
    bytes += length;
    result.removed += Number(record.removed);
    result.records++;
  }
  result.text = kept.reverse().join('');
  return result;
}

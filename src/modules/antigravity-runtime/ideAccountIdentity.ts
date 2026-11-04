import http from 'node:http';
import path from 'node:path';
import { z } from 'zod';
import type { ProcessInfo } from '@draculabo/sysinfo-process-enhanced';
import { readNativeProcessSnapshot } from '@/shared/platform/nativeProcessQuery';
import { canonicalPath } from './runtimePaths';
import { processError } from './processErrors';
import type { LaunchContext } from './types';

const AuthSchema = z.object({ authResult: z.object({ hasValidAuth: z.boolean() }) });
const UserSchema = z.object({ userStatus: z.object({ email: z.email() }) });
const SERVICE = '/exa.language_server_pb.LanguageServerService/';

/** Loopback only: no proxy, redirects, response logging or unbounded provider bodies. */
async function readHubStatus(
  port: number,
  csrf: string,
  method: string,
  deadline: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: `${SERVICE}${method}`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-codeium-csrf-token': csrf,
          'Connect-Protocol-Version': '1',
        },
        signal: AbortSignal.timeout(Math.max(1, Math.min(2000, deadline - Date.now()))),
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error('IDE Agent status is unavailable'));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 256 * 1024) {
            request.destroy(new Error('IDE Agent status exceeds the response limit'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          try {
            const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            resolve(value);
          } catch {
            reject(new Error('IDE Agent status is invalid'));
          }
        });
      },
    );
    request.on('error', reject);
    request.end('{}');
  });
}

function argument(args: readonly string[], flag: string): string | null {
  const values = args.flatMap((value, index) =>
    value === flag
      ? [args[index + 1] ?? '']
      : value.startsWith(`${flag}=`)
        ? [value.slice(flag.length + 1)]
        : [],
  );
  return values.length === 1 && values[0] !== '' ? values[0] : null;
}

function descendants(rows: ProcessInfo[], root: ProcessInfo): ProcessInfo[] {
  const owned = new Map([[root.pid, root]]);
  let changed: boolean;
  do {
    changed = false;
    for (const row of rows) {
      const parent = row.parentPid === undefined ? undefined : owned.get(row.parentPid);
      if (parent && row.startTime >= parent.startTime && !owned.has(row.pid)) {
        owned.set(row.pid, row);
        changed = true;
      }
    }
  } while (changed);
  return [...owned.values()].filter((row) => row.pid !== root.pid);
}

/** Confirms every hub belonging to this freshly launched IDE, never an unrelated CLI/profile. */
export async function confirmIdeAccountIdentity(
  context: LaunchContext,
  pid: number,
  email: string,
  timeoutMs = 30000,
): Promise<void> {
  const expected = email.trim().toLowerCase();
  if (!expected) {
    throw processError('switched-identity-unconfirmed');
  }
  const deadline = Date.now() + timeoutMs;
  let root: ProcessInfo | undefined;
  while (Date.now() < deadline) {
    try {
      const rows = await readNativeProcessSnapshot(Math.min(2000, deadline - Date.now()));
      const current = rows.find(
        (row) =>
          row.pid === pid &&
          row.exe &&
          canonicalPath(row.exe) === canonicalPath(context.executablePath),
      );
      if (root && (!current || current.startTime !== root.startTime)) {
        throw processError('switched-identity-unconfirmed');
      }
      root ??= current;
      if (root) {
        const capturedRoot = root;
        const hubs = descendants(rows, capturedRoot).filter(
          (row) =>
            row.exe &&
            path.win32.basename(row.exe).toLowerCase() ===
              (process.platform === 'win32' ? 'agy.exe' : 'agy') &&
            row.cmd.includes('--hub') &&
            argument(row.cmd, '--app_data_dir') === 'antigravity',
        );
        let confirmed = hubs.length > 0;
        for (const hub of hubs) {
          const portText = argument(hub.cmd, '--hub-port');
          const csrf = argument(hub.cmd, '--csrf_token');
          const port = portText && /^\d+$/.test(portText) ? Number(portText) : 0;
          if (!csrf || !Number.isInteger(port) || port < 1 || port > 65535) {
            confirmed = false;
            break;
          }
          const auth = AuthSchema.safeParse(
            await readHubStatus(port, csrf, 'GetAuthStatus', deadline),
          );
          const user = UserSchema.safeParse(
            await readHubStatus(port, csrf, 'GetUserStatus', deadline),
          );
          if (
            !auth.success ||
            !auth.data.authResult.hasValidAuth ||
            !user.success ||
            user.data.userStatus.email.trim().toLowerCase() !== expected
          ) {
            confirmed = false;
            break;
          }
        }
        if (confirmed && Date.now() < deadline) {
          // Reject a retiring/replaced hub even if its last response matched the selected account.
          const fresh = await readNativeProcessSnapshot(Math.min(2000, deadline - Date.now()));
          const freshRoot = fresh.find(
            (row) =>
              row.pid === capturedRoot.pid &&
              row.startTime === capturedRoot.startTime &&
              row.exe === capturedRoot.exe,
          );
          const freshHubs = freshRoot
            ? descendants(fresh, freshRoot).filter(
                (row) =>
                  row.exe &&
                  path.win32.basename(row.exe).toLowerCase() ===
                    (process.platform === 'win32' ? 'agy.exe' : 'agy') &&
                  row.cmd.includes('--hub') &&
                  argument(row.cmd, '--app_data_dir') === 'antigravity',
              )
            : [];
          if (
            freshHubs.length === hubs.length &&
            hubs.every((hub) =>
              freshHubs.some(
                (row) =>
                  row.pid === hub.pid && row.startTime === hub.startTime && row.exe === hub.exe,
              ),
            ) &&
            Date.now() < deadline
          ) {
            return;
          }
        }
      }
    } catch {
      // A status/probe failure is inconclusive; retry observation within the single deadline.
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, remaining)));
    }
  }
  throw processError('switched-identity-unconfirmed');
}

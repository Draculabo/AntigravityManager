import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { getAgentDir } from '@/shared/platform/paths';

// Leave headroom for Node's terminator and platform-specific Unix socket limits.
const MAX_UNIX_SOCKET_PATH_LENGTH = 100;

function getUnixEndpoint(name: string, platform: NodeJS.Platform): string {
  const endpoint = path.join(getAgentDir({ platform }), 'runtime', `${name}.sock`);
  if (endpoint.length <= MAX_UNIX_SOCKET_PATH_LENGTH) {
    return endpoint;
  }

  const scope = crypto.createHash('sha256').update(endpoint).digest('hex').slice(0, 16);
  const socketDirectory = `agm-${scope}`;
  const socketPath = (root: string) =>
    path.join(root, 'antigravity-manager', socketDirectory, `${name}.sock`);
  const temporaryEndpoint = socketPath(os.tmpdir());
  return temporaryEndpoint.length <= MAX_UNIX_SOCKET_PATH_LENGTH
    ? temporaryEndpoint
    : socketPath('/tmp');
}

export function getLocalEndpoint(
  name: string,
  platform: NodeJS.Platform = process.platform,
  userHome: string = os.homedir(),
): string {
  if (platform === 'win32') {
    const userScope = crypto
      .createHash('sha256')
      .update(userHome.toLowerCase())
      .digest('hex')
      .slice(0, 16);
    return `\\\\.\\pipe\\antigravity-manager-${name}-${userScope}`;
  }
  return getUnixEndpoint(name, platform);
}

async function isLiveEndpoint(endpoint: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(endpoint);
    socket.setTimeout(2000, () => {
      socket.destroy();
      reject(new Error('Timed out checking the existing local endpoint'));
    });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') {
        resolve(false);
      } else {
        reject(error);
      }
    });
  });
}

/** Bind a local endpoint, serializing stale Unix socket recovery across processes. */
export async function bindLocalEndpoint(
  endpoint: string,
  platform: NodeJS.Platform,
  bind: () => Promise<void>,
): Promise<void> {
  if (platform !== 'win32') {
    const directory = path.dirname(endpoint);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if (!(await fs.lstat(directory)).isDirectory()) {
      throw new Error('Core runtime directory must be a real directory');
    }
    await fs.chmod(directory, 0o700);
  }

  try {
    await bind();
  } catch (error) {
    if (platform === 'win32' || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
      throw error;
    }
    // A crashed recovery leaves the exclusive guard behind and fails closed.
    const guardPath = `${endpoint}.recovery-lock`;
    const guard = await fs.open(guardPath, 'wx', 0o600);
    try {
      if (await isLiveEndpoint(endpoint)) {
        throw new Error('A process already owns this local endpoint', { cause: error });
      }
      await fs.unlink(endpoint);
      await bind();
    } finally {
      await guard.close();
      await fs.unlink(guardPath);
    }
  }
}

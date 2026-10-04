import fs from 'node:fs/promises';
import net, { type Server, type Socket } from 'node:net';
import { z } from 'zod';
import { bindLocalEndpoint, getLocalEndpoint } from '@/core/local-endpoint';

const OWNER_PROTOCOL_VERSION = 1;
const MAX_OWNER_MESSAGE_BYTES = 1024;
const PROBE_TIMEOUT_MS = 1500;

export const ProfileOwnerSchema = z.strictObject({
  version: z.literal(OWNER_PROTOCOL_VERSION),
  kind: z.enum(['desktop', 'core']),
  pid: z.number().int().positive(),
});

export type ProfileOwner = z.infer<typeof ProfileOwnerSchema>;

export class ProfileOwnershipError extends Error {
  constructor(readonly owner: ProfileOwner) {
    super(`Profile is already owned by ${owner.kind} process ${owner.pid}`);
    this.name = 'ProfileOwnershipError';
  }
}

export function getProfileOwnershipEndpoint(platform: NodeJS.Platform = process.platform): string {
  return getLocalEndpoint('profile-owner-v1', platform);
}

export async function probeProfileOwner(endpoint: string): Promise<ProfileOwner | null> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(endpoint);
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (owner: ProfileOwner | null, error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      if (error) {
        reject(error);
      } else {
        resolve(owner);
      }
    };

    socket.setTimeout(PROBE_TIMEOUT_MS, () =>
      finish(null, new Error('Profile owner probe timed out')),
    );
    socket.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OWNER_MESSAGE_BYTES) {
        finish(null, new Error('Profile owner response is too large'));
        return;
      }
      chunks.push(chunk);
    });
    socket.once('end', () => {
      try {
        const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8').trim());
        const result = ProfileOwnerSchema.safeParse(payload);
        if (!result.success) {
          throw new Error('Invalid profile owner response');
        }
        finish(result.data);
      } catch (error) {
        finish(null, error instanceof Error ? error : new Error('Invalid profile owner response'));
      }
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') {
        finish(null);
      } else {
        finish(null, error);
      }
    });
  });
}

export class ProfileLease {
  private server: Server | null = null;
  private readonly endpoint: string;
  private readonly platform: NodeJS.Platform;

  constructor(
    private readonly kind: ProfileOwner['kind'],
    options: { endpoint?: string; platform?: NodeJS.Platform } = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.endpoint = options.endpoint ?? getProfileOwnershipEndpoint(this.platform);
  }

  private async listen(): Promise<void> {
    const identity: ProfileOwner = {
      version: OWNER_PROTOCOL_VERSION,
      kind: this.kind,
      pid: process.pid,
    };
    const server = net.createServer((socket: Socket) => {
      socket.end(`${JSON.stringify(identity)}\n`);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen({ path: this.endpoint, readableAll: false, writableAll: false }, () => {
          server.off('error', reject);
          resolve();
        });
      });
      if (this.platform !== 'win32') {
        await fs.chmod(this.endpoint, 0o600);
      }
      server.unref();
      this.server = server;
    } catch (error) {
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      throw error;
    }
  }

  async acquire(): Promise<void> {
    if (this.server) {
      throw new Error('Profile lease is already held');
    }
    try {
      await bindLocalEndpoint(this.endpoint, this.platform, () => this.listen());
    } catch (error) {
      const owner = await probeProfileOwner(this.endpoint);
      if (owner) {
        throw new ProfileOwnershipError(owner);
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

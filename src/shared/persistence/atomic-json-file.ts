import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

export interface WriteFileAtomicOptions {
  /** Optional POSIX permission bits for newly created files. */
  mode?: number;
}

export interface WriteJsonFileAtomicOptions {
  /** Indentation passed to `JSON.stringify`. Omit for the compact form. */
  space?: number;
}

interface AtomicFileHandle {
  writeFile(content: string | Uint8Array): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface AtomicFileWriterDependencies {
  platform: NodeJS.Platform;
  mkdir(directory: string): Promise<void>;
  openFile(filePath: string, mode?: number): Promise<AtomicFileHandle>;
  rename(temporaryPath: string, filePath: string): Promise<void>;
  remove(temporaryPath: string): Promise<void>;
  openDirectory(directory: string): Promise<AtomicFileHandle>;
}

export interface AtomicFileWriter {
  write(
    filePath: string,
    content: string | Uint8Array,
    options?: WriteFileAtomicOptions,
  ): Promise<void>;
}

function createTemporaryPath(filePath: string): string {
  const directory = path.dirname(filePath);
  return path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
}

async function closeQuietly(handle: AtomicFileHandle | null): Promise<void> {
  if (!handle) {
    return;
  }

  await handle.close().catch(() => undefined);
}

async function syncParentDirectory(
  dependencies: AtomicFileWriterDependencies,
  directory: string,
): Promise<void> {
  const handle = await dependencies.openDirectory(directory);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Builds an atomic writer with explicit filesystem seams for durable-state tests.
 * Production callers should use `writeFileAtomic` instead.
 */
export function createAtomicFileWriter(
  dependencies: AtomicFileWriterDependencies,
): AtomicFileWriter {
  return {
    async write(
      filePath: string,
      content: string | Uint8Array,
      options: WriteFileAtomicOptions = {},
    ): Promise<void> {
      const directory = path.dirname(filePath);
      const temporaryPath = createTemporaryPath(filePath);
      let temporaryHandle: AtomicFileHandle | null = null;

      await dependencies.mkdir(directory);
      try {
        temporaryHandle = await dependencies.openFile(temporaryPath, options.mode);
        await temporaryHandle.writeFile(content);
        await temporaryHandle.sync();
        await temporaryHandle.close();
        temporaryHandle = null;

        await dependencies.rename(temporaryPath, filePath);
        if (dependencies.platform !== 'win32') {
          await syncParentDirectory(dependencies, directory);
        }
      } catch (error) {
        await closeQuietly(temporaryHandle);
        await dependencies.remove(temporaryPath).catch(() => undefined);
        throw error;
      }
    },
  };
}

const defaultAtomicFileWriter = createAtomicFileWriter({
  platform: process.platform,
  async mkdir(directory: string): Promise<void> {
    await fs.promises.mkdir(directory, { recursive: true });
  },
  openFile(filePath: string, mode?: number): Promise<AtomicFileHandle> {
    return fs.promises.open(filePath, 'wx', mode);
  },
  rename(temporaryPath: string, filePath: string): Promise<void> {
    return fs.promises.rename(temporaryPath, filePath);
  },
  remove(temporaryPath: string): Promise<void> {
    return fs.promises.rm(temporaryPath, { force: true });
  },
  openDirectory(directory: string): Promise<AtomicFileHandle> {
    return fs.promises.open(directory, 'r');
  },
});

function syncParentDirectorySync(directory: string): void {
  if (process.platform === 'win32') {
    return;
  }

  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * Writes a sibling temporary file, synchronizes it, then atomically replaces
 * the target. POSIX also synchronizes the parent directory after replacement.
 */
export function writeFileAtomic(
  filePath: string,
  content: string | Uint8Array,
  options: WriteFileAtomicOptions = {},
): Promise<void> {
  return defaultAtomicFileWriter.write(filePath, content, options);
}

/**
 * Synchronous counterpart for persistence code that must keep a synchronous
 * transaction boundary. It has the same temporary-file and cleanup contract.
 */
export function writeFileAtomicSync(
  filePath: string,
  content: string | Uint8Array,
  options: WriteFileAtomicOptions = {},
): void {
  const directory = path.dirname(filePath);
  const temporaryPath = createTemporaryPath(filePath);
  let descriptor: number | null = null;

  fs.mkdirSync(directory, { recursive: true });
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', options.mode);
    fs.writeFileSync(descriptor, content, 'utf-8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;

    fs.renameSync(temporaryPath, filePath);
    syncParentDirectorySync(directory);
  } catch (error) {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the original write, sync, close, or rename error.
      }
    }
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {
      // Preserve the original write, sync, close, or rename error.
    }
    throw error;
  }
}

/**
 * Reads JSON written by an earlier run.
 *
 * A missing, truncated or otherwise unparsable file is reported as `null`
 * rather than thrown: everything persisted through this helper is recoverable
 * state, and a damaged file must never stop the app from starting.
 */
export function readJsonFileSync(filePath: string): unknown {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Serializes JSON through the same durable atomic file path as plaintext
 * configuration and account-index records.
 */
export async function writeJsonFileAtomic(
  filePath: string,
  value: unknown,
  options: WriteJsonFileAtomicOptions = {},
): Promise<void> {
  const content = JSON.stringify(value, null, options.space);
  if (content === undefined) {
    throw new TypeError('Atomic JSON persistence requires a serializable value');
  }

  await writeFileAtomic(filePath, content);
}

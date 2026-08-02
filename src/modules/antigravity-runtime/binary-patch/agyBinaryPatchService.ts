import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import {
  AgyBinaryFormat,
  AgyBinaryPatchAnalysis,
  patchAgyBinaryBuffer,
} from '@/modules/antigravity-runtime/binary-patch/agyBinaryPatchCore';

const execFileAsync = promisify(execFile);

export interface AgyBinaryPatchFileResult extends AgyBinaryPatchAnalysis {
  backupPath: string | null;
  filePath: string;
}

export interface AgyBinaryPatchServiceOptions {
  platform?: NodeJS.Platform;
  signBinary?: (filePath: string) => Promise<void>;
}

async function resolveAgyExecutablePath(inputPath: string): Promise<string> {
  const trimmedPath = inputPath.trim();
  if (!trimmedPath) {
    throw new Error('Configure the Antigravity CLI executable path before patching.');
  }

  const selectedPath = path.resolve(trimmedPath);
  const candidatePath = selectedPath.toLowerCase().endsWith('.app')
    ? path.join(selectedPath, 'Contents', 'MacOS', 'agy')
    : selectedPath;
  let realPath: string;
  try {
    realPath = await fs.promises.realpath(candidatePath);
  } catch {
    throw new Error(`The configured Antigravity CLI executable does not exist: ${candidatePath}`);
  }

  const fileName = path.basename(realPath).toLowerCase();
  if (fileName !== 'agy' && fileName !== 'agy.exe') {
    throw new Error('Only the agy or agy.exe CLI executable can be patched.');
  }

  const stats = await fs.promises.stat(realPath);
  if (!stats.isFile()) {
    throw new Error('The configured Antigravity CLI path is not a file.');
  }

  return realPath;
}

async function writeBufferAtomically(
  filePath: string,
  contents: Buffer,
  mode: number,
): Promise<void> {
  const uniqueSuffix = `${process.pid}-${crypto.randomUUID()}`;
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.patch-${uniqueSuffix}.tmp`,
  );
  const replacedPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.replaced-${uniqueSuffix}.tmp`,
  );
  let handle: fs.promises.FileHandle | null = null;
  let originalWasMoved = false;

  try {
    handle = await fs.promises.open(tempPath, 'wx', mode);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.chmod(tempPath, mode);

    if (process.platform === 'win32') {
      await fs.promises.rename(filePath, replacedPath);
      originalWasMoved = true;
      try {
        await fs.promises.rename(tempPath, filePath);
      } catch (error) {
        try {
          await fs.promises.rename(replacedPath, filePath);
          originalWasMoved = false;
        } catch {
          throw new Error(
            `Unable to replace agy safely. The original file is preserved at ${replacedPath}.`,
          );
        }
        throw error;
      }
      originalWasMoved = false;
      await fs.promises.rm(replacedPath, { force: true }).catch(() => undefined);
    } else {
      await fs.promises.rename(tempPath, filePath);
    }
  } finally {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
    if (originalWasMoved) {
      try {
        await fs.promises.rename(replacedPath, filePath);
        originalWasMoved = false;
      } catch {
        // Keep the displaced original for manual recovery.
      }
    }
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
    if (!originalWasMoved) {
      await fs.promises.rm(replacedPath, { force: true }).catch(() => undefined);
    }
  }
}

function contentHash(contents: Buffer): string {
  return crypto.createHash('sha256').update(contents).digest('hex').slice(0, 12);
}

async function writeBackup(filePath: string, source: Buffer, mode: number): Promise<string> {
  const preferredPath = `${filePath}.bak`;
  const backupCandidates = [preferredPath, `${preferredPath}.${contentHash(source)}`];

  for (const backupPath of backupCandidates) {
    try {
      const handle = await fs.promises.open(backupPath, 'wx', mode);
      try {
        await handle.writeFile(source);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return backupPath;
    } catch (error) {
      const errorCode =
        error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (errorCode !== 'EEXIST') {
        throw error;
      }

      const existingBackup = await fs.promises.readFile(backupPath);
      if (existingBackup.equals(source)) {
        return backupPath;
      }
    }
  }

  throw new Error('Unable to create a version-matched backup for the agy executable.');
}

async function codesignAgyBinary(filePath: string): Promise<void> {
  await execFileAsync('codesign', ['--remove-signature', filePath]).catch(() => undefined);
  await execFileAsync('codesign', ['--force', '--sign', '-', filePath]);
}

function requiresMacCodesign(format: AgyBinaryFormat, platform: NodeJS.Platform): boolean {
  return platform === 'darwin' && (format === 'mach-o' || format === 'mach-o-universal');
}

export async function patchAgyBinaryFile(
  configuredPath: string,
  options: AgyBinaryPatchServiceOptions = {},
): Promise<AgyBinaryPatchFileResult> {
  const filePath = await resolveAgyExecutablePath(configuredPath);
  const sourceStats = await fs.promises.stat(filePath);
  const source = await fs.promises.readFile(filePath);
  const patchResult = patchAgyBinaryBuffer(source);

  if (patchResult.analysis.status === 'already-patched') {
    return {
      ...patchResult.analysis,
      backupPath: null,
      filePath,
    };
  }

  const backupPath = await writeBackup(filePath, source, sourceStats.mode);
  let binaryWasReplaced = false;

  try {
    await writeBufferAtomically(filePath, patchResult.buffer, sourceStats.mode);
    binaryWasReplaced = true;

    const verification = patchAgyBinaryBuffer(await fs.promises.readFile(filePath));
    if (
      verification.analysis.status !== 'already-patched' ||
      verification.analysis.format !== patchResult.analysis.format ||
      verification.analysis.architectures.join(',') !== patchResult.analysis.architectures.join(',')
    ) {
      throw new Error('Post-write verification did not match the preflight patch plan.');
    }

    const platform = options.platform ?? process.platform;
    if (requiresMacCodesign(patchResult.analysis.format, platform)) {
      try {
        await (options.signBinary ?? codesignAgyBinary)(filePath);
        const signedVerification = patchAgyBinaryBuffer(await fs.promises.readFile(filePath));
        if (
          signedVerification.analysis.status !== 'already-patched' ||
          signedVerification.analysis.format !== patchResult.analysis.format ||
          signedVerification.analysis.architectures.join(',') !==
            patchResult.analysis.architectures.join(',')
        ) {
          throw new Error('The signed binary no longer matches the verified patch plan.');
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Patch rolled back because macOS codesigning failed: ${message}`);
      }
    }
  } catch (error) {
    if (binaryWasReplaced) {
      await writeBufferAtomically(filePath, source, sourceStats.mode);
    }
    throw error;
  }

  return {
    ...patchResult.analysis,
    backupPath,
    filePath,
  };
}

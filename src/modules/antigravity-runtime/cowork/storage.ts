import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readRuntimeContents } from '../binary-patch/claudeCoworkRuntime';
import { CoworkJournalSchema, CoworkOperationError, type CoworkJournal } from './contracts';

const SOURCE_LIMIT = 1024 * 1024;
export function isInterruptedCoworkJournal(journal: CoworkJournal): boolean {
  return ['prepared', 'committing', 'restoring', 'recovery-required'].includes(journal.phase);
}

export const sourceHash = (contents: Buffer): string =>
  createHash('sha256').update(contents).digest('hex');

export function readCoworkSource(filePath: string): Buffer {
  const { contents } = readRuntimeContents(filePath, SOURCE_LIMIT);
  if (!contents || fs.realpathSync.native(filePath) !== filePath) {
    throw new CoworkOperationError('stale-target');
  }
  return contents;
}

function syncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function replaceCoworkSource(filePath: string, contents: Buffer, mode: number): void {
  const temporary = path.join(path.dirname(filePath), `.cowork-${randomUUID()}.tmp`);
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(temporary, 'wx', mode);
    fs.writeFileSync(descriptor, contents);
    fs.fchmodSync(descriptor, mode);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, filePath);
    syncDirectory(path.dirname(filePath));
  } finally {
    if (descriptor !== null) {
      fs.closeSync(descriptor);
    }
    if (fs.existsSync(temporary)) {
      fs.unlinkSync(temporary);
    }
  }
}

function ensurePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink() || !fs.statSync(directory).isDirectory()) {
    throw new CoworkOperationError('backup-invalid');
  }
}

function immutableFile(filePath: string, contents: Buffer): void {
  if (fs.existsSync(filePath)) {
    if (!readCoworkSource(filePath).equals(contents)) {
      throw new CoworkOperationError('backup-invalid');
    }
    return;
  }
  const descriptor = fs.openSync(filePath, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, contents);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  if (!readCoworkSource(filePath).equals(contents)) {
    throw new CoworkOperationError('backup-invalid');
  }
  syncDirectory(path.dirname(filePath));
}

export class CoworkBackupStore {
  constructor(private readonly root: string) {}

  private targetDirectory(targetPath: string, create = true): string {
    const directory = path.join(this.root, sourceHash(Buffer.from(targetPath)));
    if (create) {
      ensurePrivateDirectory(this.root);
      ensurePrivateDirectory(directory);
    } else if (!fs.existsSync(directory)) {
      return directory;
    }
    if (fs.lstatSync(this.root).isSymbolicLink() || fs.lstatSync(directory).isSymbolicLink()) {
      throw new CoworkOperationError('backup-invalid');
    }
    if (fs.realpathSync.native(directory) !== path.join(fs.realpathSync.native(this.root), path.basename(directory))) {
      throw new CoworkOperationError('backup-invalid');
    }
    return directory;
  }

  private backupDirectory(targetPath: string, originalSha256: string, create = false): string {
    if (!/^[a-f0-9]{64}$/u.test(originalSha256)) {
      throw new CoworkOperationError('backup-invalid');
    }
    const directory = path.join(this.targetDirectory(targetPath, create), originalSha256);
    if (create) {
      ensurePrivateDirectory(directory);
    } else if (!fs.existsSync(directory) || fs.lstatSync(directory).isSymbolicLink() ||
      !fs.statSync(directory).isDirectory()) {
      throw new CoworkOperationError('backup-invalid');
    }
    if (fs.realpathSync.native(directory) !== directory) {
      throw new CoworkOperationError('backup-invalid');
    }
    return directory;
  }

  prepare(journal: CoworkJournal, original: Buffer): string {
    if (sourceHash(original) !== journal.originalSha256) {
      throw new CoworkOperationError('backup-invalid');
    }
    const existing = this.readJournal(journal.targetPath);
    if (existing && isInterruptedCoworkJournal(existing)) {
      throw new CoworkOperationError('recovery-required');
    }
    const directory = this.backupDirectory(journal.targetPath, journal.originalSha256, true);
    immutableFile(path.join(directory, 'original.source'), original);
    immutableFile(path.join(directory, 'identity.json'), Buffer.from(JSON.stringify({
      format: 1, targetPath: journal.targetPath, packageId: journal.packageId,
      version: journal.version, originalSha256: journal.originalSha256, mode: journal.mode,
    })));
    this.writeJournal(journal);
    return directory;
  }

  writeJournal(journal: CoworkJournal): void {
    const filePath = path.join(this.targetDirectory(journal.targetPath), 'transaction.json');
    if (fs.existsSync(filePath) && fs.lstatSync(filePath).isSymbolicLink()) {
      throw new CoworkOperationError('backup-invalid');
    }
    replaceCoworkSource(filePath, Buffer.from(JSON.stringify(journal)), 0o600);
  }

  readJournal(targetPath: string): CoworkJournal | null {
    const filePath = path.join(this.targetDirectory(targetPath, false), 'transaction.json');
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const { contents } = readRuntimeContents(filePath, 16 * 1024);
    if (!contents) {
      throw new CoworkOperationError('backup-invalid');
    }
    let journal: CoworkJournal;
    try {
      journal = CoworkJournalSchema.parse(JSON.parse(contents.toString('utf8')));
    } catch (cause) {
      throw new CoworkOperationError('backup-invalid', { cause });
    }
    if (journal.targetPath !== targetPath) {
      throw new CoworkOperationError('backup-invalid');
    }
    return journal;
  }

  assertCurrentJournal(journal: CoworkJournal): void {
    const current = this.readJournal(journal.targetPath);
    if (!current || current.packageId !== journal.packageId || current.version !== journal.version ||
      current.originalSha256 !== journal.originalSha256 || current.patchedSha256 !== journal.patchedSha256 ||
      current.mode !== journal.mode || current.phase !== journal.phase) {
      throw new CoworkOperationError('stale-target');
    }
  }

  original(journal: CoworkJournal): Buffer {
    try {
      const directory = this.backupDirectory(journal.targetPath, journal.originalSha256);
      const original = readCoworkSource(path.join(directory, 'original.source'));
      if (sourceHash(original) !== journal.originalSha256) {
        throw new CoworkOperationError('backup-invalid');
      }
      const identityPath = path.join(directory, 'identity.json');
      const identity = Buffer.from(JSON.stringify({
        format: 1, targetPath: journal.targetPath, packageId: journal.packageId,
        version: journal.version, originalSha256: journal.originalSha256, mode: journal.mode,
      }));
      if (!readCoworkSource(identityPath).equals(identity)) {
        throw new CoworkOperationError('backup-invalid');
      }
      return original;
    } catch (cause) {
      throw new CoworkOperationError('backup-invalid', { cause });
    }
  }

  recoveryLocation(journal: CoworkJournal): string {
    return this.backupDirectory(journal.targetPath, journal.originalSha256);
  }
}

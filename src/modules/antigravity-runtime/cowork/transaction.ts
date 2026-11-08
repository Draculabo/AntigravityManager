import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  CoworkOperationError,
  type CoworkFailureCode,
  type CoworkJournal,
  type CoworkReceipt,
  type VerifiedCoworkSource,
} from './contracts';
import { CoworkBackupStore, readCoworkSource, replaceCoworkSource } from './storage';

export interface CoworkPreparedOperation {
  action: 'apply' | 'restore';
  source: VerifiedCoworkSource;
  before: Buffer;
  beforeMode: number;
  after: Buffer;
  journal: CoworkJournal;
}

export function failedCoworkReceipt(
  action: 'apply' | 'restore',
  code: CoworkFailureCode,
): CoworkReceipt {
  return {
    operationId: randomUUID(), action, outcome: 'failed', effect: 'none', code,
    recovery: 'not-needed', recoveryCode: null, backupId: null,
    recoveryLocation: null, restart: 'not-attempted',
  };
}

export function coworkFailureCode(error: unknown): CoworkFailureCode {
  return error instanceof CoworkOperationError ? error.code : 'write-failed';
}

/** Records a running observation before stop can partially succeed and throw. */
export async function requireStopped(
  source: VerifiedCoworkSource,
  onRunning?: () => void,
): Promise<void> {
  let state: 'running' | 'stopped' | 'unknown';
  try {
    state = await source.lifecycle.inspect();
  } catch (cause) {
    throw new CoworkOperationError('process-state-unknown', { cause });
  }
  if (state === 'unknown') {
    throw new CoworkOperationError('process-state-unknown');
  }
  if (state === 'running') {
    onRunning?.();
    try {
      await source.lifecycle.stop();
    } catch (cause) {
      throw new CoworkOperationError('stop-failed', { cause });
    }
  }
  try {
    state = await source.lifecycle.inspect();
  } catch (cause) {
    throw new CoworkOperationError('process-state-unknown', { cause });
  }
  if (state === 'unknown') {
    throw new CoworkOperationError('process-state-unknown');
  }
  if (state === 'running') {
    throw new CoworkOperationError('stop-failed');
  }
}

/** Bundles and signed/native payloads need a separate verified recovery recipe. */
export async function executeCoworkTransaction(
  prepared: CoworkPreparedOperation,
  store: CoworkBackupStore,
  restart: boolean,
): Promise<{ receipt: CoworkReceipt; failure: Error | null }> {
  const { source, before, after, action } = prepared;
  const receipt = failedCoworkReceipt(action, 'write-failed');
  let journal = prepared.journal;
  let commitAttempted = false;
  let initiallyRunning = false;
  let restartTarget: { contents: Buffer; mode: number } | null = null;
  let failure: Error | null = null;
  receipt.restart = restart ? 'not-attempted' : 'not-requested';
  try {
    await source.verifyOwnership();
    if (!readCoworkSource(source.canonicalPath).equals(before) ||
      (fs.statSync(source.canonicalPath).mode & 0o7777) !== (prepared.beforeMode & 0o7777)) {
      throw new CoworkOperationError('stale-target');
    }
    if (action === 'apply') {
      receipt.recoveryLocation = store.prepare(journal, before);
    } else {
      store.assertCurrentJournal(journal);
      if (!store.original(journal).equals(after)) {
        throw new CoworkOperationError('backup-invalid');
      }
      receipt.recoveryLocation = store.recoveryLocation(journal);
    }
    receipt.backupId = journal.originalSha256;
    if (action === 'restore' && before.equals(after) &&
      (prepared.beforeMode & 0o7777) === (journal.mode & 0o7777)) {
      store.writeJournal({ ...journal, phase: 'restored' });
      receipt.outcome = 'already-current';
      receipt.code = null;
      receipt.recovery = 'verified';
      return { receipt, failure };
    }
    await requireStopped(source, () => {
      initiallyRunning = true;
    });
    await source.verifyOwnership();
    if (!readCoworkSource(source.canonicalPath).equals(before) ||
      (fs.statSync(source.canonicalPath).mode & 0o7777) !== (prepared.beforeMode & 0o7777)) {
      throw new CoworkOperationError('stale-target');
    }
    if (action === 'restore') {
      store.assertCurrentJournal(journal);
      if (!store.original(journal).equals(after)) {
        throw new CoworkOperationError('backup-invalid');
      }
    }
    journal = { ...journal, phase: action === 'apply' ? 'committing' : 'restoring' };
    store.writeJournal(journal);
    commitAttempted = true;
    replaceCoworkSource(source.canonicalPath, after, journal.mode);
    if (
      !readCoworkSource(source.canonicalPath).equals(after) ||
      (fs.statSync(source.canonicalPath).mode & 0o7777) !== (journal.mode & 0o7777)
    ) {
      throw new CoworkOperationError('verification-failed');
    }
    journal = { ...journal, phase: action === 'apply' ? 'committed' : 'restored' };
    store.writeJournal(journal);
    receipt.outcome = action === 'apply' ? 'applied' : 'restored';
    receipt.effect = 'committed';
    receipt.code = null;
    restartTarget = { contents: after, mode: journal.mode };
  } catch (error) {
    failure = error instanceof Error ? error : new Error('Cowork transaction failed');
    receipt.code = coworkFailureCode(error);
    if (!commitAttempted) {
      if (initiallyRunning) {
        restartTarget = { contents: before, mode: prepared.beforeMode };
      }
    } else {
      receipt.effect = 'uncertain';
      try {
        await source.verifyOwnership();
        if (await source.lifecycle.inspect() !== 'stopped') {
          throw new CoworkOperationError('process-state-unknown');
        }
        const current = readCoworkSource(source.canonicalPath);
        if (!current.equals(before) && !current.equals(after)) {
          throw new CoworkOperationError('stale-target');
        }
        if (!current.equals(before) ||
          (fs.statSync(source.canonicalPath).mode & 0o7777) !== (prepared.beforeMode & 0o7777)) {
          replaceCoworkSource(source.canonicalPath, before, prepared.beforeMode);
        }
        if (!readCoworkSource(source.canonicalPath).equals(before) ||
          (fs.statSync(source.canonicalPath).mode & 0o7777) !== (prepared.beforeMode & 0o7777)) {
          throw new CoworkOperationError('verification-failed');
        }
        store.writeJournal(action === 'apply' ? { ...journal, phase: 'rolled-back' } : prepared.journal);
        receipt.effect = 'rolled-back';
        receipt.recovery = 'verified';
        if (initiallyRunning) {
          restartTarget = { contents: before, mode: prepared.beforeMode };
        }
      } catch (recoveryError) {
        receipt.recovery = 'failed';
        receipt.recoveryCode = coworkFailureCode(recoveryError);
        const failures: unknown[] = [failure, recoveryError];
        try {
          store.writeJournal({ ...journal, phase: 'recovery-required' });
        } catch (journalError) {
          failures.push(journalError);
        }
        return { receipt, failure: new AggregateError(failures, 'Cowork write and recovery failed') };
      }
    }
  }
  if (restart && restartTarget) {
    try {
      await source.verifyOwnership();
      if (!readCoworkSource(source.canonicalPath).equals(restartTarget.contents)) {
        throw new CoworkOperationError('stale-target');
      }
      if ((fs.statSync(source.canonicalPath).mode & 0o7777) !== (restartTarget.mode & 0o7777)) {
        throw new CoworkOperationError('verification-failed');
      }
      const state = await source.lifecycle.inspect();
      if (state === 'unknown') {
        throw new CoworkOperationError('process-state-unknown');
      }
      if (state === 'stopped') {
        await source.lifecycle.start();
      }
      if (await source.lifecycle.inspect() !== 'running') {
        throw new CoworkOperationError('lifecycle-failed');
      }
      receipt.restart = 'verified';
    } catch (error) {
      receipt.restart = 'failed';
      const restartFailure = error instanceof Error ? error : new Error('Cowork restart failed');
      if (failure) {
        failure = new AggregateError([failure, restartFailure], 'Cowork operation and restart failed');
      } else {
        receipt.code = coworkFailureCode(error) === 'stale-target' ? 'stale-target' : 'lifecycle-failed';
        failure = restartFailure;
      }
    }
  }
  return { receipt, failure };
}

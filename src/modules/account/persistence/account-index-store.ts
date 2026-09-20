import fs from 'fs';
import path from 'path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';

import { AccountSchema, type Account } from '@/modules/account/types';
import { logger } from '@/shared/logging/logger';
import { writeFileAtomicSync } from '@/shared/persistence/atomic-json-file';

export type AccountIndex = Record<string, Account>;

const AccountIndexSchema = z.record(z.string(), AccountSchema);

interface AccountIndexGate {
  pending: number;
  tail: Promise<void>;
}

const accountIndexGates = new Map<string, AccountIndexGate>();
const accountIndexTransactionContext = new AsyncLocalStorage<boolean>();

export class AccountIndexTransactionReentryError extends Error {
  constructor() {
    super('Account index transactions cannot be nested');
    this.name = 'AccountIndexTransactionReentryError';
  }
}

export class AccountIndexAsyncMutationError extends Error {
  constructor() {
    super('Account index mutation callback must be synchronous');
    this.name = 'AccountIndexAsyncMutationError';
  }
}

function getIndexKey(filePath: string): string {
  const resolvedPath = path.resolve(filePath);
  return process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
}

function assertNotInIndexTransaction(): void {
  if (!accountIndexTransactionContext.getStore()) {
    return;
  }

  logger.warn('Rejected reentrant account index transaction');
  throw new AccountIndexTransactionReentryError();
}

function runWithIndexGate<T>(indexKey: string, operation: () => T | Promise<T>): Promise<T> {
  let gate = accountIndexGates.get(indexKey);
  if (!gate) {
    gate = { pending: 0, tail: Promise.resolve() };
    accountIndexGates.set(indexKey, gate);
  }

  const previous = gate.tail;
  let release!: () => void;
  const ticket = new Promise<void>((resolve) => {
    release = resolve;
  });
  gate.tail = previous.then(() => ticket);
  gate.pending += 1;

  return previous.then(operation).finally(() => {
    release();
    gate.pending -= 1;
    if (gate.pending === 0) {
      accountIndexGates.delete(indexKey);
    }
  });
}

function cloneBoundaryValue<T>(value: T): T {
  return structuredClone(value);
}

function readValidatedIndex(filePath: string): AccountIndex {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const rawIndex: unknown = JSON.parse(content);
    return AccountIndexSchema.parse(rawIndex);
  } catch (error) {
    logger.error('Failed to read accounts index', error);
    throw error;
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' && value !== null && 'then' in value) ||
    (typeof value === 'function' && 'then' in value)
  );
}

function commitIndex(filePath: string, accounts: AccountIndex): void {
  const content = `${JSON.stringify(accounts, null, 2)}\n`;

  try {
    writeFileAtomicSync(filePath, content);
  } catch (error) {
    logger.error('Failed to commit accounts index', error);
    throw error;
  }
}

/**
 * Reads a detached, schema-validated snapshot through the account-index serialization gate.
 * Callers must not retain a snapshot and later write it back as a whole index.
 */
export function readAccountIndex(filePath: string): Promise<AccountIndex> {
  const indexKey = getIndexKey(filePath);
  assertNotInIndexTransaction();

  return runWithIndexGate(indexKey, () => cloneBoundaryValue(readValidatedIndex(filePath)));
}

/**
 * Serializes one synchronous read-modify-write operation for an account-index file.
 * The draft is transaction-owned, the complete result is validated before replacement, and
 * the callback result is detached before it crosses the transaction boundary.
 */
export function mutateAccountIndex<T>(
  filePath: string,
  mutation: (draft: AccountIndex) => T,
): Promise<T> {
  const indexKey = getIndexKey(filePath);
  assertNotInIndexTransaction();

  return runWithIndexGate(indexKey, () =>
    accountIndexTransactionContext.run(true, () => {
      const draft = cloneBoundaryValue(readValidatedIndex(filePath));
      const result = mutation(draft);
      if (isPromiseLike(result)) {
        void Promise.resolve(result).catch(() => undefined);
        throw new AccountIndexAsyncMutationError();
      }

      const detachedResult = cloneBoundaryValue(result);
      const validatedIndex = AccountIndexSchema.parse(draft);
      commitIndex(filePath, validatedIndex);
      return detachedResult;
    }),
  );
}

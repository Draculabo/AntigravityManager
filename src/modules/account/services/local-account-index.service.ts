import { v4 as uuidv4 } from 'uuid';
import { LocalAccountError } from './local-account.schema';
import type { Account } from '../types';
import type { DeviceProfile, DeviceProfileVersion } from '@/modules/identity-profile/types';
import { getAccountsFilePath } from '@/shared/platform/paths';
import {
  readAccountIndex,
  mutateAccountIndex,
  type AccountIndex,
} from '../persistence/account-index-store';
export function getDeviceHistory(account: Account): DeviceProfileVersion[] {
  if (!account.deviceHistory) {
    account.deviceHistory = [];
  }
  return account.deviceHistory;
}

export function bindDeviceProfileToAccount(
  account: Account,
  profile: DeviceProfile,
  label: string,
  addHistory: boolean,
): void {
  account.deviceProfile = profile;
  if (!addHistory) {
    return;
  }

  const history = getDeviceHistory(account);
  for (const version of history) {
    version.isCurrent = false;
  }

  history.push({
    id: uuidv4(),
    createdAt: Math.floor(Date.now() / 1000),
    label,
    profile,
    isCurrent: true,
  });
}

/**
 * Reads a detached accounts snapshot through the persistence transaction gate.
 */
export function readAccountsIndex(): Promise<AccountIndex> {
  return readAccountIndex(getAccountsFilePath());
}

/**
 * Mutates the latest accounts index through the persistence transaction gate.
 */
export function mutateAccountsIndex<T>(mutation: (draft: AccountIndex) => T): Promise<T> {
  return mutateAccountIndex(getAccountsFilePath(), mutation);
}

export function sanitizeAccountId(accountId: string): string {
  return accountId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

export function getAccountOrThrow(accounts: AccountIndex, accountId: string): Account {
  const account = accounts[accountId];
  if (!account) {
    throw new LocalAccountError('snapshot-not-found');
  }
  return account;
}

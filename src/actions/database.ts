import { ipc } from "@/ipc/manager";
import { AccountBackupData, Account } from "@/types/account";

export function backupAccount(account: Account) {
  return ipc.client.database.backupAccount(account);
}

export function restoreAccount(backup: AccountBackupData) {
  return ipc.client.database.restoreAccount(backup);
}

export function getCurrentAccountInfo() {
  return ipc.client.database.getCurrentAccountInfo();
}

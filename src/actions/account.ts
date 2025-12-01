import { ipc } from "@/ipc/manager";

export function listAccounts() {
  return ipc.client.account.listAccounts();
}

export function addAccountSnapshot() {
  return ipc.client.account.addAccountSnapshot();
}

export function switchAccount(accountId: string) {
  return ipc.client.account.switchAccount({ accountId });
}

export function deleteAccount(accountId: string) {
  return ipc.client.account.deleteAccount({ accountId });
}

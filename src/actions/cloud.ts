import { ipc } from '@/ipc/manager';

export function addGoogleAccount(input: { authCode: string }) {
  return ipc.client.cloud.addGoogleAccount(input);
}

export function listCloudAccounts() {
  return ipc.client.cloud.listCloudAccounts();
}

export function deleteCloudAccount(input: { accountId: string }) {
  return ipc.client.cloud.deleteCloudAccount(input);
}

export function refreshAccountQuota(input: { accountId: string }) {
  return ipc.client.cloud.refreshAccountQuota(input);
}

export function switchCloudAccount(input: { accountId: string }) {
  return ipc.client.cloud.switchCloudAccount(input);
}

export function getAutoSwitchEnabled() {
  return ipc.client.cloud.getAutoSwitchEnabled();
}

export function setAutoSwitchEnabled(input: { enabled: boolean }) {
  return ipc.client.cloud.setAutoSwitchEnabled(input);
}

export function forcePollCloudMonitor() {
  return ipc.client.cloud.forcePollCloudMonitor();
}

export function syncLocalAccount() {
  return ipc.client.cloud.syncLocalAccount();
}

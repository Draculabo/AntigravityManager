import { ipc } from '@/ipc/manager';

export function getCurrentAccountInfo() {
  return ipc.client.database.getCurrentAccountInfo();
}

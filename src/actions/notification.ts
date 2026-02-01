import { ipc } from '@/ipc/manager';

export async function sendTestNotification() {
  return await ipc.client.notification.sendTestNotification();
}

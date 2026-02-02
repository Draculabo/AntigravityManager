/**
 * @created by https://github.com/abdul-zailani
 */
import { ipc } from '@/ipc/manager';

export async function sendTestNotification() {
  return await ipc.client.notification.sendTestNotification();
}

import { ipc } from "@/ipc/manager";

export function isProcessRunning() {
  return ipc.client.process.isProcessRunning();
}

export function closeAntigravity() {
  return ipc.client.process.closeAntigravity();
}

export function startAntigravity() {
  return ipc.client.process.startAntigravity();
}

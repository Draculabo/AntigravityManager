import { ipc } from '@/ipc/manager';

export function previewLocalAccountImport() {
  return ipc.client.cloud.localImport.preview();
}

export function confirmLocalAccountImport(input: { sessionId: string }) {
  return ipc.client.cloud.localImport.confirm(input);
}

export function discardLocalAccountImport(input: { sessionId: string }) {
  return ipc.client.cloud.localImport.discard(input);
}

export function getLocalAccountImportPostImportStatus(input: { taskId: string }) {
  return ipc.client.cloud.localImport.getPostImportStatus(input);
}

export type LocalAccountImportPreview = Awaited<ReturnType<typeof previewLocalAccountImport>>;
export type LocalAccountImportResult = Awaited<ReturnType<typeof confirmLocalAccountImport>>;
export type LocalAccountPostImportTaskSnapshot = Awaited<
  ReturnType<typeof getLocalAccountImportPostImportStatus>
>;

import { ORPCError } from '@orpc/client';
import { ipc } from '../../../src/ipc/manager';

async function captureFailure(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    if (error instanceof ORPCError) {
      return { code: error.code, status: error.status, data: error.data };
    }
    throw new Error('The packaged public IPC response lost its diagnostic');
  }
  throw new Error('The controlled operation unexpectedly succeeded');
}

const acceptance = {
  listAccounts: () => ipc.client.cloud.listCloudAccounts(),
  loginFailure: () => captureFailure(() => ipc.client.cloud.startAuthFlow()),
  switchFailure: (accountId: string) =>
    captureFailure(() => ipc.client.cloud.switchCloudAccount({ accountId, appTarget: 'agy' })),
};

declare global {
  interface Window {
    operationDiagnosticAcceptance: typeof acceptance;
  }
}

// This test client uses the production message-port client and preload; it supplies no diagnostic ID.
window.operationDiagnosticAcceptance = acceptance;

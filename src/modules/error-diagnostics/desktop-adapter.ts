import type { CoreRpcClient } from '@/core/rpc/client';
import { errorDiagnosticOwner, type ErrorDiagnosticOperations } from './error-owner.service';
import type { ErrorDiagnosticRole } from './error-window.database';

let core: ErrorDiagnosticOperations | null = null;
export function selectErrorDiagnosticOwner(
  selection:
    | { mode: 'desktop-embedded' }
    | { mode: 'standalone-core'; client: Pick<CoreRpcClient, 'errorDiagnostics'> },
): void {
  core = selection.mode === 'standalone-core' ? selection.client.errorDiagnostics : null;
}

export function getErrorDiagnosticSource(role: ErrorDiagnosticRole): ErrorDiagnosticOperations {
  if (role === 'app') {
    return errorDiagnosticOwner;
  }
  if (!core) {
    throw new Error('Selected core error diagnostics are unavailable');
  }
  return core;
}

export async function readErrorDiagnosticSources() {
  return Promise.all(
    (['app', 'core'] as const).map(async (role) => {
      try {
        const status = await getErrorDiagnosticSource(role).status();
        if (
          status.role !== role ||
          (status.storage.state === 'ready' && status.storage.role !== role)
        ) {
          throw new Error('Local error diagnostic source mismatch');
        }
        return { state: 'available' as const, role, status };
      } catch {
        return { state: 'unavailable' as const, role };
      }
    }),
  );
}

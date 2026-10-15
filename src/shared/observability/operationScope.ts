import { AsyncLocalStorage } from 'node:async_hooks';
import type { OperationFailure } from './operationDiagnostic';

interface OperationIdentity {
  diagnosticId: string;
  operation: OperationFailure['operation'];
}
const scopes = new AsyncLocalStorage<{ identity: OperationIdentity; active: boolean }>();

export function currentOperationIdentity(): OperationIdentity | undefined {
  const scope = scopes.getStore();
  return scope?.active ? scope.identity : undefined;
}

/** Closing the invocation disables correlation inherited by late background callbacks. */
export async function runWithOperationScope<T>(
  identity: OperationIdentity,
  action: () => T | Promise<T>,
): Promise<T> {
  const scope = { identity, active: true };
  return scopes.run(scope, async () => {
    try {
      return await action();
    } finally {
      scope.active = false;
    }
  });
}

import { ORPCError } from '@orpc/server';
import { z } from 'zod';
import { ServiceConfigErrorCodeSchema } from '@/modules/config/service-config.schema';
import { LocalAccountErrorCodeSchema } from '@/modules/account/services/local-account.schema';
import { OpenCodeOwnerErrorCodeSchema } from '@/modules/proxy-gateway/opencode-sync/opencode-owner.schema';

type OwnerScope =
  | 'configuration'
  | 'local-account'
  | 'opencode'
  | 'audit'
  | 'thought'
  | 'audit-curl';
const pathSchema = z.array(z.string());
const configError = z.strictObject({ configCode: ServiceConfigErrorCodeSchema });
const localError = z.strictObject({ accountCode: LocalAccountErrorCodeSchema });
const openCodeError = z.strictObject({ openCodeCode: OpenCodeOwnerErrorCodeSchema });
type OwnerCategory =
  | z.infer<typeof configError>
  | z.infer<typeof localError>
  | z.infer<typeof openCodeError>
  | { auditCode: 'invalid-input' | 'operation-failed' }
  | { thoughtCode: 'invalid-input' | 'operation-failed' }
  | { auditCurlCode: 'invalid-input' | 'operation-failed' };
export type OwnerOperationErrorData = OwnerCategory & {
  backendCode: 'BAD_REQUEST' | 'SERVICE_UNAVAILABLE';
  backendStatus: 400 | 503;
  backendName: string;
  backendMessage: string;
  requestPath: string;
};

function getOwnerErrorMessage(scope: OwnerScope, invalid: boolean): string {
  if (invalid) {
    return 'Unable to complete that action. Check the details and try again.';
  }

  switch (scope) {
    case 'configuration':
      return 'Settings are unavailable right now. Please try again.';
    case 'local-account':
      return 'Unable to complete this account action right now. Please try again.';
    case 'audit':
      return 'Request history is unavailable right now. Please try again.';
    case 'thought':
      return 'AI reasoning history is unavailable right now. Please try again.';
    case 'audit-curl':
      return 'Unable to copy this request right now. Please try again.';
    case 'opencode':
      return 'OpenCode settings are unavailable right now. Please try again.';
  }
}

function resolveScope(requestPath: string): OwnerScope | null {
  let path: string[];
  try {
    path = pathSchema.parse(JSON.parse(requestPath));
  } catch {
    return null;
  }
  if (path[0] === 'config' && ['service', 'accountAlertPolicy'].includes(path[1])) {
    return 'configuration';
  }
  if (path[0] === 'gateway' && path[1] === 'auditCopyCurl') {
    return 'audit-curl';
  }
  if (
    path[0] === 'gateway' &&
    [
      'thoughtSessions',
      'thoughtRecords',
      'thoughtRecord',
      'thoughtStats',
      'thoughtDelete',
      'thoughtClear',
      'thoughtRepair',
    ].includes(path[1])
  ) {
    return 'thought';
  }
  if (
    path[0] === 'gateway' &&
    [
      'auditList',
      'auditFilterOptions',
      'auditDetail',
      'auditBodyPage',
      'auditBodySearch',
      'auditStats',
      'auditDelete',
      'auditClear',
      'auditRepair',
    ].includes(path[1])
  ) {
    return 'audit';
  }
  if (
    (path[0] === 'account' && path[1] !== 'openIdentityStorageFolder') ||
    (path[0] === 'database' && path[1] === 'getCurrentAccountInfo')
  ) {
    return 'local-account';
  }
  if (
    path[0] === 'gateway' &&
    [
      'openCodeStatus',
      'syncOpenCode',
      'readOpenCodeConfig',
      'restoreOpenCode',
      'clearOpenCode',
      'revokeOpenCodeKey',
    ].includes(path[1])
  ) {
    return 'opencode';
  }
  return null;
}

/** Input validation errors can contain caller data; sanitize before IPC logging and projection. */
export function projectOwnerOperationError(
  error: unknown,
  requestPath: string,
): ORPCError<string, OwnerOperationErrorData> | null {
  const scope = resolveScope(requestPath);
  if (!scope) {
    return null;
  }
  const invalid = error instanceof ORPCError && error.code === 'BAD_REQUEST';
  const code = invalid ? 'BAD_REQUEST' : 'SERVICE_UNAVAILABLE';
  const status = invalid ? 400 : 503;
  const message = getOwnerErrorMessage(scope, invalid);
  const data = error instanceof ORPCError ? error.data : undefined;
  let category: OwnerCategory;
  if (scope === 'configuration') {
    const parsed = configError.safeParse(data);
    category = {
      configCode: invalid
        ? 'invalid-input'
        : parsed.success
          ? parsed.data.configCode
          : 'unavailable',
    };
  } else if (scope === 'local-account') {
    const parsed = localError.safeParse(data);
    category = {
      accountCode: invalid
        ? 'invalid-input'
        : parsed.success
          ? parsed.data.accountCode
          : 'account-operation-failed',
    };
  } else if (scope === 'audit') {
    category = { auditCode: invalid ? 'invalid-input' : 'operation-failed' };
  } else if (scope === 'thought') {
    category = { thoughtCode: invalid ? 'invalid-input' : 'operation-failed' };
  } else if (scope === 'audit-curl') {
    category = { auditCurlCode: invalid ? 'invalid-input' : 'operation-failed' };
  } else {
    const parsed = openCodeError.safeParse(data);
    category = {
      openCodeCode: invalid
        ? 'invalid-input'
        : parsed.success
          ? parsed.data.openCodeCode
          : 'operation-failed',
    };
  }
  return new ORPCError(code, {
    message,
    data: {
      ...category,
      backendCode: code,
      backendStatus: status,
      backendName: 'ORPCError',
      backendMessage: message,
      requestPath,
    },
  });
}

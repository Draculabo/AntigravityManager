import type { TFunction } from 'i18next';
import { isNumber, isPlainObject, isString } from 'lodash-es';
import { getAppErrorData } from '@/shared/errors/appError';
import { readFinalizedOperationDiagnostic } from '@/shared/observability/operationDiagnostic';
import { formatOperationDiagnostic } from '@/shared/observability/operationDiagnosticText';

function getObjectProperty(error: unknown, key: string): unknown {
  if ((typeof error !== 'object' && typeof error !== 'function') || error === null) {
    return undefined;
  }

  return Reflect.get(error, key);
}

function getStringProperty(error: unknown, key: string): string | undefined {
  const value = getObjectProperty(error, key);
  return isString(value) && value ? value : undefined;
}

function getErrorData(error: unknown): unknown {
  const data = getObjectProperty(error, 'data');
  if (!isPlainObject(data)) {
    return undefined;
  }

  return data;
}

function getRawErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  const objectMessage = getStringProperty(error, 'message');
  if (objectMessage) {
    return objectMessage;
  }

  return String(error);
}

function getMessagesForResolution(error: unknown): string[] {
  const data = getErrorData(error);
  const backendMessageValue = getObjectProperty(data, 'backendMessage');
  const backendMessage =
    isString(backendMessageValue) && backendMessageValue ? backendMessageValue : '';
  const rawMessage = getRawErrorMessage(error);

  return [rawMessage, backendMessage].filter((message, index, messages) => {
    return Boolean(message) && messages.indexOf(message) === index;
  });
}

export function isDataMigrationError(error: unknown): boolean {
  return getAppErrorData(error)?.appErrorCode === 'DATA_MIGRATION_FAILED';
}

export function isMasterKeyUnavailableError(error: unknown): boolean {
  return getAppErrorData(error)?.appErrorCode === 'MASTER_KEY_UNAVAILABLE';
}

export function getLocalizedErrorMessage(error: unknown, t: TFunction): string {
  const diagnostic = readFinalizedOperationDiagnostic(error);
  if (diagnostic) {
    if (diagnostic.operation !== 'google-login') {
      if (diagnostic.credentialWrite === 'confirmed') {
        return t('operation-diagnostics.switch-written-unconfirmed', {
          defaultValue:
            'The new account was written to Antigravity, but the switch could not be confirmed. Check the account shown in Antigravity before trying again.',
        });
      }
      if (diagnostic.credentialWrite === 'uncertain') {
        return t('operation-diagnostics.switch-write-uncertain', {
          defaultValue:
            'The account in Antigravity may have changed. Check the account shown in Antigravity before trying again.',
        });
      }
    }
    if (diagnostic.accountCommit === 'confirmed' || diagnostic.accountCommit === 'uncertain') {
      return t('operation-diagnostics.check-account-list', {
        defaultValue:
          'The account may already be saved. Refresh the account list before signing in again.',
      });
    }
    const recovery =
      diagnostic.reason === 'proxy-configuration-invalid'
        ? 'check-proxy'
        : [
              'dns-failed',
              'connection-refused',
              'connection-reset',
              'timed-out',
              'tls-failed',
              'network-failed',
            ].includes(diagnostic.reason)
          ? 'check-connection'
          : diagnostic.reason === 'process-close-failed'
            ? 'close-client'
            : diagnostic.reason === 'reauth-required'
              ? 'reauthorize'
              : 'retry';
    return t(`operation-diagnostics.${recovery}`, {
      defaultValue: 'The operation failed. Check the diagnostic details and retry.',
    });
  }
  const appErrorData = getAppErrorData(error);
  if (appErrorData) {
    const message = t(appErrorData.messageKey, {
      defaultValue: appErrorData.messageKey,
      ...appErrorData.metadata,
    });
    if (!appErrorData.detailMessageKey) {
      return message;
    }

    return `${message} ${t(appErrorData.detailMessageKey, {
      defaultValue: appErrorData.detailMessageKey,
      ...appErrorData.metadata,
    })}`;
  }

  const messagesForResolution = getMessagesForResolution(error);

  if (messagesForResolution.length > 0) {
    return messagesForResolution[0];
  }

  return String(error);
}

export function getErrorDetailsText(error: unknown): string {
  const diagnostic = readFinalizedOperationDiagnostic(error);
  if (diagnostic) {
    return formatOperationDiagnostic(diagnostic);
  }
  const data = getErrorData(error);
  const rawMessage = getRawErrorMessage(error);
  const details: string[] = [];
  const requestPath = getObjectProperty(data, 'requestPath');
  const backendCode = getObjectProperty(data, 'backendCode');
  const backendStatus = getObjectProperty(data, 'backendStatus');
  const backendMessage = getObjectProperty(data, 'backendMessage');
  const backendStack = getObjectProperty(data, 'backendStack');
  const backendValue = getObjectProperty(data, 'backendValue');
  const diagnosticCode = getObjectProperty(data, 'diagnosticCode');

  if (isString(requestPath) && requestPath) {
    details.push(`Request path: ${requestPath}`);
  }

  if (isString(backendCode) && backendCode) {
    details.push(`Backend code: ${backendCode}`);
  }

  if (isNumber(backendStatus)) {
    details.push(`Backend status: ${backendStatus}`);
  }

  if (isString(backendMessage) && backendMessage) {
    details.push(`Backend message: ${backendMessage}`);
  } else if (rawMessage) {
    details.push(`Message: ${rawMessage}`);
  }

  if (isString(diagnosticCode) && diagnosticCode) {
    details.push(`Diagnostic code: ${diagnosticCode}`);
  }

  if (isString(backendStack) && backendStack) {
    details.push(backendStack);
  } else {
    const stack = getStringProperty(error, 'stack');
    if (stack) {
      details.push(stack);
    }
  }

  if (isString(backendValue) && backendValue) {
    details.push(`Backend value: ${backendValue}`);
  }

  if (details.length > 0) {
    return details.join('\n\n');
  }

  return rawMessage || String(error);
}

import type { TFunction } from 'i18next';
import { isNumber, isPlainObject, isString } from 'lodash-es';
import { getAppErrorData } from '@/shared/errors/appError';

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
  const data = getErrorData(error);
  const rawMessage = getRawErrorMessage(error);
  const details: string[] = [];
  const requestPath = getObjectProperty(data, 'requestPath');
  const backendCode = getObjectProperty(data, 'backendCode');
  const backendStatus = getObjectProperty(data, 'backendStatus');
  const backendMessage = getObjectProperty(data, 'backendMessage');
  const backendStack = getObjectProperty(data, 'backendStack');
  const backendValue = getObjectProperty(data, 'backendValue');

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

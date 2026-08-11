import { isBoolean, isPlainObject, isString } from 'lodash-es';

export interface AppErrorMetadataByCode {
  CLOUD_ACCOUNT_LOGIN_EXPIRED: {
    accountId: string;
    email: string;
  };
  KEYCHAIN_UNAVAILABLE: {
    hint: 'HINT_APP_TRANSLOCATION' | 'HINT_KEYCHAIN_DENIED' | 'HINT_SIGN_NOTARIZE' | null;
  };
  DATA_MIGRATION_FAILED: {
    hint: 'HINT_RELOGIN' | 'HINT_CLEAR_DATA';
  };
  MASTER_KEY_UNAVAILABLE: {
    hint:
      | 'HINT_APP_TRANSLOCATION'
      | 'HINT_KEYCHAIN_DENIED'
      | 'HINT_MANUAL_SIGN'
      | 'HINT_RECOVERY'
      | null;
    reason: 'NO_MATCHING_KEY' | 'PROVIDER_UNAVAILABLE' | 'NOT_INITIALIZED';
    storedAccountCount: number;
  };
}

export type AppErrorCode = keyof AppErrorMetadataByCode;

const APP_ERROR_CODES = new Set<string>([
  'CLOUD_ACCOUNT_LOGIN_EXPIRED',
  'KEYCHAIN_UNAVAILABLE',
  'DATA_MIGRATION_FAILED',
  'MASTER_KEY_UNAVAILABLE',
]);

export type AppErrorTransportCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'INTERNAL_SERVER_ERROR';

export interface AppErrorData<TCode extends AppErrorCode = AppErrorCode> {
  appErrorCode: TCode;
  messageKey: string;
  detailMessageKey?: string;
  reportToSentry: boolean;
  metadata?: AppErrorMetadataByCode[TCode];
}

interface AppErrorBaseOptions {
  messageKey: string;
  detailMessageKey?: string;
  reportToSentry?: boolean;
  transportCode?: AppErrorTransportCode;
  cause?: unknown;
}

type AppErrorOptions<TCode extends AppErrorCode> = AppErrorBaseOptions & {
  metadata: AppErrorMetadataByCode[TCode];
};

export class AppError<TCode extends AppErrorCode = AppErrorCode> extends Error {
  readonly code: TCode;
  readonly messageKey: string;
  readonly detailMessageKey?: string;
  readonly reportToSentry: boolean;
  readonly transportCode: AppErrorTransportCode;
  readonly metadata: AppErrorMetadataByCode[TCode];

  constructor(code: TCode, message: string, options: AppErrorOptions<TCode>) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.messageKey = options.messageKey;
    this.detailMessageKey = options.detailMessageKey;
    this.reportToSentry = options.reportToSentry ?? true;
    this.transportCode = options.transportCode ?? 'INTERNAL_SERVER_ERROR';
    this.metadata = options.metadata;
  }
}

function getObjectProperty(value: unknown, key: string): unknown {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return undefined;
  }

  return Reflect.get(value, key);
}

function getErrorDataSource(value: unknown): unknown {
  const data = getObjectProperty(value, 'data');
  return isPlainObject(data) ? data : value;
}

function createAppErrorData<TCode extends AppErrorCode>(
  appErrorCode: TCode,
  messageKey: string,
  reportToSentry: boolean,
  metadata?: AppErrorMetadataByCode[TCode],
  detailMessageKey?: string,
): AppErrorData<TCode> {
  return {
    appErrorCode,
    messageKey,
    ...(detailMessageKey ? { detailMessageKey } : {}),
    reportToSentry,
    ...(metadata ? { metadata } : {}),
  };
}

function isAppErrorCode(value: unknown): value is AppErrorCode {
  return isString(value) && APP_ERROR_CODES.has(value);
}

function normalizeAppErrorMetadata(
  appErrorCode: AppErrorCode,
  metadata: unknown,
): AppErrorData['metadata'] {
  if (!isPlainObject(metadata)) {
    return undefined;
  }

  const accountId = getObjectProperty(metadata, 'accountId');
  const email = getObjectProperty(metadata, 'email');
  const hint = getObjectProperty(metadata, 'hint');
  const reason = getObjectProperty(metadata, 'reason');
  const storedAccountCount = getObjectProperty(metadata, 'storedAccountCount');

  if (appErrorCode === 'CLOUD_ACCOUNT_LOGIN_EXPIRED') {
    return isString(accountId) && isString(email) ? { accountId, email } : undefined;
  }

  if (appErrorCode === 'KEYCHAIN_UNAVAILABLE') {
    if (
      hint === 'HINT_APP_TRANSLOCATION' ||
      hint === 'HINT_KEYCHAIN_DENIED' ||
      hint === 'HINT_SIGN_NOTARIZE' ||
      hint === null
    ) {
      return { hint };
    }
    return undefined;
  }

  if (appErrorCode === 'MASTER_KEY_UNAVAILABLE') {
    const isValidHint =
      hint === 'HINT_APP_TRANSLOCATION' ||
      hint === 'HINT_KEYCHAIN_DENIED' ||
      hint === 'HINT_MANUAL_SIGN' ||
      hint === 'HINT_RECOVERY' ||
      hint === null;
    const isValidReason =
      reason === 'NO_MATCHING_KEY' ||
      reason === 'PROVIDER_UNAVAILABLE' ||
      reason === 'NOT_INITIALIZED';
    if (isValidHint && isValidReason && typeof storedAccountCount === 'number') {
      return { hint, reason, storedAccountCount };
    }

    return undefined;
  }

  if (hint === 'HINT_RELOGIN' || hint === 'HINT_CLEAR_DATA') {
    return { hint };
  }

  return undefined;
}

export function getAppErrorData(error: unknown): AppErrorData | undefined {
  if (error instanceof AppError) {
    return createAppErrorData(
      error.code,
      error.messageKey,
      error.reportToSentry,
      error.metadata,
      error.detailMessageKey,
    );
  }

  const dataSource = getErrorDataSource(error);
  const appErrorCode = getObjectProperty(dataSource, 'appErrorCode');
  const messageKey = getObjectProperty(dataSource, 'messageKey');
  const detailMessageKey = getObjectProperty(dataSource, 'detailMessageKey');
  const reportToSentry = getObjectProperty(dataSource, 'reportToSentry');
  const metadata = getObjectProperty(dataSource, 'metadata');

  if (!isAppErrorCode(appErrorCode) || !isString(messageKey)) {
    return undefined;
  }

  return createAppErrorData(
    appErrorCode,
    messageKey,
    isBoolean(reportToSentry) ? reportToSentry : true,
    normalizeAppErrorMetadata(appErrorCode, metadata),
    isString(detailMessageKey) ? detailMessageKey : undefined,
  );
}

export function shouldReportErrorToSentry(error: unknown): boolean {
  const appErrorData = getAppErrorData(error);
  if (appErrorData?.reportToSentry === false) {
    return false;
  }

  return true;
}

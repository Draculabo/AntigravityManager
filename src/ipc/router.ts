import { accountRouter, databaseRouter } from '@/modules/account/ipc/router';
import {
  cloudRouter,
  type LocalAccountImportORPCErrorData,
  parseLocalAccountImportORPCErrorData,
} from '@/modules/cloud-account/ipc/router';
import { configRouter } from '@/modules/config/ipc/router';
import { gatewayRouter } from '@/modules/proxy-gateway/ipc/router';
import { antigravityRuntimeRouter } from '@/modules/antigravity-runtime/ipc/router';
import { appShellRouter } from '@/modules/app-shell/ipc/router';

import { ORPCError, os } from '@orpc/server';
import { isString } from 'lodash-es';
import { z } from 'zod';
import { logger } from '../shared/logging/logger';
import { AppError, getAppErrorData, type AppErrorData } from '@/shared/errors/appError';

interface BackendErrorDetails {
  backendCode?: string;
  backendStatus?: number;
  backendName: string;
  backendMessage: string;
  backendStack?: string;
  backendValue?: string;
  requestPath: string;
}

/** A closed IPC error envelope with only explicitly validated feature extensions. */
type PublicORPCErrorData =
  | BackendErrorDetails
  | (BackendErrorDetails & AppErrorData)
  | (BackendErrorDetails & LocalAccountImportORPCErrorData);

function stringifyUnknownError(error: unknown): string {
  if (isString(error)) {
    return error;
  }

  if (error instanceof Error) {
    return error.message;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function createBackendErrorDetails(error: unknown, requestPath: string): BackendErrorDetails {
  const message = stringifyUnknownError(error);

  if (error instanceof ORPCError) {
    return {
      backendCode: error.code,
      backendStatus: error.status,
      backendName: error.name,
      backendMessage: message,
      backendStack: error.stack,
      requestPath,
    };
  }

  if (error instanceof Error) {
    return {
      backendName: error.name,
      backendMessage: message,
      backendStack: error.stack,
      requestPath,
    };
  }

  return {
    backendName: typeof error,
    backendMessage: message,
    backendValue: message,
    requestPath,
  };
}

function createPublicORPCErrorData(error: unknown, requestPath: string): PublicORPCErrorData {
  const backendDetails = createBackendErrorDetails(error, requestPath);
  const appErrorData = getAppErrorData(error);
  if (appErrorData) {
    return {
      ...backendDetails,
      ...appErrorData,
    };
  }

  const cloudAccountErrorData =
    error instanceof ORPCError ? parseLocalAccountImportORPCErrorData(error.data) : null;
  if (cloudAccountErrorData) {
    return {
      ...backendDetails,
      ...cloudAccountErrorData,
    };
  }

  return backendDetails;
}

export function toPublicORPCError(
  error: unknown,
  requestPath: string,
): ORPCError<string, PublicORPCErrorData> {
  const message = stringifyUnknownError(error);
  const publicData = createPublicORPCErrorData(error, requestPath);

  if (error instanceof AppError) {
    return new ORPCError(error.transportCode, {
      message,
      data: publicData,
    });
  }

  if (error instanceof ORPCError) {
    return new ORPCError(error.code, {
      message,
      data: publicData,
    });
  }

  return new ORPCError('INTERNAL_SERVER_ERROR', {
    message,
    data: publicData,
  });
}

// Log middleware setup
const logMiddleware = os.middleware(async ({ next, path }) => {
  const requestPath = JSON.stringify(path || 'unknown');

  try {
    const result = await next({});
    return result;
  } catch (err) {
    logger.error(`[ORPC] Error in handler for ${requestPath}:`, err);
    throw toPublicORPCError(err, requestPath);
  }
});

// Explicit Router Definition
export const router = os.use(logMiddleware).router({
  ping: os.output(z.string()).handler(async () => 'pong'),

  ...appShellRouter,
  database: databaseRouter,
  ...antigravityRuntimeRouter,

  account: accountRouter,
  cloud: cloudRouter,
  config: configRouter,
  gateway: gatewayRouter,
});

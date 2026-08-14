import { app } from '@/modules/app-shell/ipc/app';
import { theme } from '@/modules/app-shell/ipc/theme';
import { window } from '@/modules/app-shell/ipc/window';
import { databaseRouter } from '@/shared/persistence/database/router';
import { accountRouter } from '@/modules/account/ipc/router';
import { cloudRouter } from '@/modules/cloud-account/ipc/router';
import { configRouter } from '@/modules/config/ipc/router';
import { gatewayRouter } from '@/modules/proxy-gateway/ipc/router';
import { antigravityClientCacheRouter } from '@/modules/antigravity-runtime/ipc/cacheRouter';
import { agyBinaryPatchRouter } from '@/modules/antigravity-runtime/ipc/agyBinaryPatchRouter';

import { ORPCError, os } from '@orpc/server';
import { isPlainObject, isString } from 'lodash-es';
import { z } from 'zod';
import {
  isProcessRunning,
  closeAntigravity,
  startAntigravity,
} from '@/modules/antigravity-runtime/ipc/handler';
import { AntigravityAppTargetSchema } from '@/modules/account/types';
import { systemHandler } from '@/modules/app-shell/ipc/system/handler';
import { logger } from '../shared/logging/logger';
import { AppError, getAppErrorData } from '@/shared/errors/appError';

const ProcessTargetInputSchema = z
  .object({ target: AntigravityAppTargetSchema.optional() })
  .optional();

interface BackendErrorDetails {
  [key: string]: unknown;
  backendCode?: string;
  backendStatus?: number;
  backendName: string;
  backendMessage: string;
  backendStack?: string;
  backendValue?: string;
  requestPath: string;
}

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

function getPublicBackendStack(error: Error): string | undefined {
  return process.env.NODE_ENV === 'development' ? error.stack : undefined;
}

function createBackendErrorDetails(error: unknown, requestPath: string): BackendErrorDetails {
  const message = stringifyUnknownError(error);

  if (error instanceof ORPCError) {
    return {
      backendCode: error.code,
      backendStatus: error.status,
      backendName: error.name,
      backendMessage: message,
      backendStack: getPublicBackendStack(error),
      requestPath,
    };
  }

  if (error instanceof Error) {
    return {
      backendName: error.name,
      backendMessage: message,
      backendStack: getPublicBackendStack(error),
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

export function toPublicORPCError(
  error: unknown,
  requestPath: string,
): ORPCError<string, Record<string, unknown>> {
  const message = stringifyUnknownError(error);
  const backendDetails = createBackendErrorDetails(error, requestPath);

  if (error instanceof AppError) {
    return new ORPCError(error.transportCode, {
      message,
      data: {
        ...backendDetails,
        ...getAppErrorData(error),
      },
    });
  }

  if (error instanceof ORPCError) {
    const existingData = isPlainObject(error.data) ? error.data : {};
    return new ORPCError(error.code, {
      message,
      data: {
        ...backendDetails,
        ...existingData,
      },
    });
  }

  return new ORPCError('INTERNAL_SERVER_ERROR', {
    message,
    data: backendDetails,
  });
}

// Log middleware setup
const logMiddleware = os.middleware(async (opts: any) => {
  const { next, path, meta } = opts;
  const requestPath = JSON.stringify(path || meta?.path || 'unknown');

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

  theme,
  window,
  app,
  database: databaseRouter,
  antigravityClientCache: antigravityClientCacheRouter,
  agyBinaryPatch: agyBinaryPatchRouter,

  // Inline process router to ensure structure
  proc: os.router({
    isProcessRunning: os
      .input(ProcessTargetInputSchema)
      .output(z.boolean())
      .handler(async ({ input }) => {
        return await isProcessRunning(input?.target);
      }),
    closeAntigravity: os
      .input(ProcessTargetInputSchema)
      .output(z.void())
      .handler(async ({ input }) => {
        await closeAntigravity(input?.target);
      }),
    startAntigravity: os
      .input(ProcessTargetInputSchema)
      .output(z.void())
      .handler(async ({ input }) => {
        await startAntigravity(input?.target);
      }),
  }),

  account: accountRouter,
  cloud: cloudRouter,
  config: configRouter,
  gateway: gatewayRouter,
  system: systemHandler,
});

import { dialog, shell } from 'electron';
import path from 'node:path';
import { getAgentDir } from '@/shared/platform/paths';
import { ORPCError, os } from '@orpc/server';
import { z } from 'zod';
import { writeDiagnosticAttachment } from '@/modules/app-shell/diagnostic-logs/public';
import { getErrorDiagnosticSource, readErrorDiagnosticSources } from './desktop-adapter';
import { createErrorDesktopService } from './error-desktop.service';
import {
  ErrorDesktopOpenSchema,
  ErrorDesktopQuerySchema,
  ErrorPreviewIdSchema,
  ErrorPreviewResultSchema,
  ErrorSaveResultSchema,
  ErrorSourceInputSchema,
  ErrorSourcesSchema,
} from './error-desktop.schema';
import { ErrorWindowClearSchema, ErrorWindowPageSchema } from './error-window.schema';

const service = createErrorDesktopService({
  source: getErrorDiagnosticSource,
  now: Date.now,
  choose: async (defaultPath) => {
    const result = await dialog.showSaveDialog({
      defaultPath,
      filters: [{ name: 'Text', extensions: ['txt'] }],
    });
    return result.canceled ? null : (result.filePath ?? null);
  },
  write: (destination, body, beforeCommit) =>
    writeDiagnosticAttachment(destination, body, undefined, beforeCommit),
});
const procedure = os.use(async ({ next }) => {
  try {
    return await next({});
  } catch {
    throw new ORPCError('SERVICE_UNAVAILABLE', {
      message: 'Local error diagnostics are unavailable right now.',
    });
  }
});
export const errorDesktopRouter = {
  errorDiagnostics: {
    openDirectory: procedure.output(z.object({ opened: z.literal(true) })).handler(async () => {
      const failure = await shell.openPath(path.join(getAgentDir(), 'error-diagnostics'));
      if (failure) {
        throw new Error('Local error diagnostic directory is unavailable');
      }
      return { opened: true as const };
    }),
    sources: procedure.output(ErrorSourcesSchema).handler(() => readErrorDiagnosticSources()),
    query: procedure
      .input(ErrorDesktopQuerySchema)
      .output(ErrorWindowPageSchema)
      .handler(({ input }) => {
        const { role, ...query } = input;
        return getErrorDiagnosticSource(role).query(query);
      }),
    preview: procedure
      .input(ErrorDesktopOpenSchema)
      .output(ErrorPreviewResultSchema)
      .handler(({ input }) => service.prepare(input.role, input.id)),
    save: procedure
      .input(ErrorPreviewIdSchema)
      .output(ErrorSaveResultSchema)
      .handler(({ input }) => service.save(input.capabilityId)),
    discard: procedure
      .input(ErrorPreviewIdSchema)
      .output(z.void())
      .handler(({ input }) => service.discard(input.capabilityId)),
    clear: procedure
      .input(ErrorSourceInputSchema)
      .output(ErrorWindowClearSchema)
      .handler(({ input }) => service.clear(input.role)),
  },
};

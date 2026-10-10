import { dialog } from 'electron';
import { os } from '@orpc/server';
import { z } from 'zod';
import {
  createDiagnosticLogDesktopService,
  readSelectedDiagnosticLogs,
  writeDiagnosticAttachment,
} from './desktop-service';
import { LogPrepareResultSchema, LogSaveInputSchema, LogSaveResultSchema } from './schema';

const service = createDiagnosticLogDesktopService({
  read: readSelectedDiagnosticLogs,
  now: Date.now,
  write: writeDiagnosticAttachment,
  choose: async (defaultPath) => {
    const result = await dialog.showSaveDialog({
      defaultPath,
      filters: [{ name: 'Text', extensions: ['txt'] }],
    });
    return result.canceled ? null : (result.filePath ?? null);
  },
});

export function createDiagnosticLogDesktopRouter(
  owner: ReturnType<typeof createDiagnosticLogDesktopService>,
) {
  return os.router({
    prepare: os.output(LogPrepareResultSchema).handler(() => owner.prepare()),
    save: os
      .input(LogSaveInputSchema)
      .output(LogSaveResultSchema)
      .handler(({ input }) => owner.save(input.id)),
    discard: os
      .input(LogSaveInputSchema)
      .output(z.void())
      .handler(({ input }) => owner.discard(input.id)),
  });
}

export const diagnosticLogsRouter = createDiagnosticLogDesktopRouter(service);

import { os } from '@orpc/server';
import type { LocalAccountImportPreview } from './local-account-import-coordinator.service';
import type { LocalAccountImportResult, LocalAccountPostImportTaskSnapshot } from './import-types';
import { toLocalAccountImportORPCError } from './transport.error';
import {
  LocalAccountImportPreviewSchema,
  LocalAccountImportResultSchema,
  LocalAccountPostImportTaskSnapshotSchema,
  LocalAccountImportSessionInputSchema,
  LocalAccountImportDiscardResultSchema,
  LocalAccountPostImportTaskInputSchema,
} from './transport.schema';

export interface LocalAccountImportOwner {
  preview(): Promise<LocalAccountImportPreview>;
  confirm(sessionId: string): Promise<LocalAccountImportResult>;
  discard(sessionId: string): { discarded: boolean } | Promise<{ discarded: boolean }>;
  getPostImportStatus(
    taskId: string,
  ): LocalAccountPostImportTaskSnapshot | Promise<LocalAccountPostImportTaskSnapshot>;
}

export function createLocalAccountImportRouter(coordinator: LocalAccountImportOwner) {
  return os.router({
    preview: os.output(LocalAccountImportPreviewSchema).handler(async () => {
      try {
        return await coordinator.preview();
      } catch (error) {
        throw toLocalAccountImportORPCError(error);
      }
    }),
    confirm: os
      .input(LocalAccountImportSessionInputSchema)
      .output(LocalAccountImportResultSchema)
      .handler(async ({ input }) => {
        try {
          return await coordinator.confirm(input.sessionId);
        } catch (error) {
          throw toLocalAccountImportORPCError(error);
        }
      }),
    discard: os
      .input(LocalAccountImportSessionInputSchema)
      .output(LocalAccountImportDiscardResultSchema)
      .handler(async ({ input }) => {
        try {
          return await coordinator.discard(input.sessionId);
        } catch (error) {
          throw toLocalAccountImportORPCError(error);
        }
      }),
    getPostImportStatus: os
      .input(LocalAccountPostImportTaskInputSchema)
      .output(LocalAccountPostImportTaskSnapshotSchema)
      .handler(async ({ input }) => {
        try {
          return await coordinator.getPostImportStatus(input.taskId);
        } catch (error) {
          throw toLocalAccountImportORPCError(error);
        }
      }),
  });
}

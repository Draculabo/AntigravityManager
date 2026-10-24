import { ORPCError, os } from '@orpc/server';
import { z } from 'zod';
import { dialog } from 'electron';
import {
  CreateWorkspaceProfileInputSchema,
  DeleteWorkspaceProfileInputSchema,
  GetWorkspaceProfileInputSchema,
  LaunchWorkspaceInputSchema,
  LaunchWorkspaceResultSchema,
  SelectDirectoryInputSchema,
  StopWorkspaceInputSchema,
  UpdateWorkspaceProfileInputSchema,
  WorkspaceProfileSchema,
  WorkspaceProfileViewSchema,
  WorkspaceNotFoundError,
  AccountNotFoundError,
  ActiveWorkspaceDeletionError,
  WorkspaceValidationError,
  WorkspaceDirectoryError,
} from '../types';
import { WorkspaceProfileService } from '../services/workspace-profile.service';

export function toWorkspaceORPCError(error: unknown) {
  if (error instanceof ORPCError) {
    return error;
  }
  if (error instanceof z.ZodError) {
    return new ORPCError('BAD_REQUEST', {
      message: error.message,
      data: { code: 'VALIDATION_ERROR', issues: error.issues },
    });
  }
  if (error instanceof WorkspaceNotFoundError) {
    return new ORPCError('NOT_FOUND', {
      message: error.message,
      data: { code: error.code, id: error.id },
    });
  }
  if (
    error instanceof AccountNotFoundError ||
    error instanceof ActiveWorkspaceDeletionError ||
    error instanceof WorkspaceValidationError
  ) {
    return new ORPCError('BAD_REQUEST', {
      message: error.message,
      data: { code: error.code },
    });
  }
  if (error instanceof WorkspaceDirectoryError) {
    return new ORPCError('INTERNAL_SERVER_ERROR', {
      message: error.message,
      data: { code: error.code, dirPath: error.dirPath },
    });
  }
  return new ORPCError('INTERNAL_SERVER_ERROR', {
    message: error instanceof Error ? error.message : 'Workspace operation failed',
  });
}

export function createWorkspaceRouter(
  service: typeof WorkspaceProfileService = WorkspaceProfileService,
) {
  return os.router({
    list: os.output(z.array(WorkspaceProfileViewSchema)).handler(async () => {
      try {
        return await service.listViews();
      } catch (error) {
        throw toWorkspaceORPCError(error);
      }
    }),

    get: os
      .input(GetWorkspaceProfileInputSchema)
      .output(WorkspaceProfileViewSchema.nullable())
      .handler(async ({ input }) => {
        try {
          return await service.getView(input.id);
        } catch (error) {
          throw toWorkspaceORPCError(error);
        }
      }),

    create: os
      .input(CreateWorkspaceProfileInputSchema)
      .output(WorkspaceProfileSchema)
      .handler(async ({ input }) => {
        try {
          return await service.create(input);
        } catch (error) {
          throw toWorkspaceORPCError(error);
        }
      }),

    update: os
      .input(UpdateWorkspaceProfileInputSchema)
      .output(WorkspaceProfileSchema)
      .handler(async ({ input }) => {
        try {
          return await service.update(input);
        } catch (error) {
          throw toWorkspaceORPCError(error);
        }
      }),

    delete: os
      .input(DeleteWorkspaceProfileInputSchema)
      .output(z.void())
      .handler(async ({ input }) => {
        try {
          await service.delete(input.id, {
            cleanUserDataDir: input.cleanUserDataDir,
            force: input.force,
          });
        } catch (error) {
          throw toWorkspaceORPCError(error);
        }
      }),

    launch: os
      .input(LaunchWorkspaceInputSchema)
      .output(LaunchWorkspaceResultSchema)
      .handler(async ({ input }) => {
        try {
          return await service.launch(input.id);
        } catch (error) {
          throw toWorkspaceORPCError(error);
        }
      }),

    stop: os
      .input(StopWorkspaceInputSchema)
      .output(z.void())
      .handler(async ({ input }) => {
        try {
          await service.stop(input.id);
        } catch (error) {
          throw toWorkspaceORPCError(error);
        }
      }),

    selectDirectory: os
      .input(SelectDirectoryInputSchema.optional())
      .output(z.string().nullable())
      .handler(async ({ input }) => {
        try {
          const result = await dialog.showOpenDialog({
            title: 'Select Workspace Project Folder',
            defaultPath: input?.defaultPath,
            properties: ['openDirectory', 'createDirectory'],
          });
          return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
        } catch (error) {
          throw toWorkspaceORPCError(error);
        }
      }),
  });
}

export const workspaceRouter = createWorkspaceRouter();

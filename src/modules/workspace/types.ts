import { z } from 'zod';
import { CloudAccountViewSchema } from '@/modules/cloud-account/services/cloud-account-view';

/** Core persistent Workspace Profile entity schema */
export const WorkspaceProfileSchema = z.object({
  id: z.string().uuid('Invalid workspace ID format'),
  name: z
    .string()
    .trim()
    .min(1, 'Workspace name is required')
    .max(100, 'Name cannot exceed 100 characters'),
  accountId: z.string().trim().min(1, 'Bound Google Account ID is required'),
  projectPath: z.string().trim().min(1, 'Project directory path is required'),
  userDataDir: z.string().trim().min(1, 'User data directory path is required'),
  createdAt: z.number().int().positive(),
  lastLaunchedAt: z.number().int().positive().nullable().optional(),
});
export type WorkspaceProfile = z.infer<typeof WorkspaceProfileSchema>;

/** Create input */
export const CreateWorkspaceProfileInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Workspace name is required')
    .max(100, 'Name cannot exceed 100 characters'),
  accountId: z.string().trim().min(1, 'Bound Google Account ID is required'),
  projectPath: z.string().trim().min(1, 'Project directory path is required'),
});
export type CreateWorkspaceProfileInput = z.infer<typeof CreateWorkspaceProfileInputSchema>;

/** Update input */
export const UpdateWorkspaceProfileInputSchema = z.object({
  id: z.string().uuid('Invalid workspace ID format'),
  name: z
    .string()
    .trim()
    .min(1, 'Workspace name cannot be empty')
    .max(100, 'Name cannot exceed 100 characters')
    .optional(),
  accountId: z.string().trim().min(1, 'Bound Google Account ID cannot be empty').optional(),
  projectPath: z.string().trim().min(1, 'Project directory path cannot be empty').optional(),
});
export type UpdateWorkspaceProfileInput = z.infer<typeof UpdateWorkspaceProfileInputSchema>;

/** Delete input */
export const DeleteWorkspaceProfileInputSchema = z.object({
  id: z.string().uuid('Invalid workspace ID format'),
  cleanUserDataDir: z.boolean().optional().default(true),
  force: z.boolean().optional().default(false),
});
export type DeleteWorkspaceProfileInput = z.infer<typeof DeleteWorkspaceProfileInputSchema>;

/** Get input */
export const GetWorkspaceProfileInputSchema = z.object({
  id: z.string().uuid('Invalid workspace ID format'),
});
export type GetWorkspaceProfileInput = z.infer<typeof GetWorkspaceProfileInputSchema>;

/** Launch input & output */
export const LaunchWorkspaceInputSchema = z.object({
  id: z.string().uuid('Invalid workspace ID format'),
});
export type LaunchWorkspaceInput = z.infer<typeof LaunchWorkspaceInputSchema>;

export const LaunchWorkspaceResultSchema = z.object({
  pid: z.number().int().nonnegative(),
});
export type LaunchWorkspaceResult = z.infer<typeof LaunchWorkspaceResultSchema>;

/** Launch for account input */
export const LaunchForAccountInputSchema = z.object({
  accountId: z.string().trim().min(1, 'Bound Google Account ID is required'),
});
export type LaunchForAccountInput = z.infer<typeof LaunchForAccountInputSchema>;

/** Stop input */
export const StopWorkspaceInputSchema = z.object({
  id: z.string().uuid('Invalid workspace ID format'),
});
export type StopWorkspaceInput = z.infer<typeof StopWorkspaceInputSchema>;

/** Directory picker input */
export const SelectDirectoryInputSchema = z.object({
  defaultPath: z.string().optional(),
});
export type SelectDirectoryInput = z.infer<typeof SelectDirectoryInputSchema>;

/** Runtime status schema */
export const WorkspaceProfileStatusSchema = z.object({
  running: z.boolean(),
  pid: z.number().int().positive().optional(),
});
export type WorkspaceProfileStatus = z.infer<typeof WorkspaceProfileStatusSchema>;

/** Enriched view schema for UI consumption */
export const WorkspaceProfileViewSchema = WorkspaceProfileSchema.extend({
  status: WorkspaceProfileStatusSchema,
  account: CloudAccountViewSchema.optional(),
});
export type WorkspaceProfileView = z.infer<typeof WorkspaceProfileViewSchema>;

/** Interface for runtime lifecycle delegate */
export interface WorkspaceLifecycleDelegate {
  launch(profileId: string): Promise<{ pid: number }>;
  stop(profileId: string): Promise<void>;
  getStatus(profile: WorkspaceProfile): Promise<WorkspaceProfileStatus>;
}

/** Domain Error Classes */
export class WorkspaceError extends Error {
  readonly code: string;
  constructor(message: string, code: string = 'WORKSPACE_ERROR', cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'WorkspaceError';
    this.code = code;
  }
}

export class WorkspaceNotFoundError extends WorkspaceError {
  readonly id: string;
  constructor(id: string) {
    super(`Workspace profile not found: ${id}`, 'NOT_FOUND');
    this.name = 'WorkspaceNotFoundError';
    this.id = id;
  }
}

export class AccountNotFoundError extends WorkspaceError {
  readonly accountId: string;
  constructor(accountId: string) {
    super(`Bound Google account not found: ${accountId}`, 'BAD_REQUEST');
    this.name = 'AccountNotFoundError';
    this.accountId = accountId;
  }
}

export class ActiveWorkspaceDeletionError extends WorkspaceError {
  readonly id: string;
  constructor(id: string) {
    super('Cannot delete a running workspace. Stop the workspace first.', 'BAD_REQUEST');
    this.name = 'ActiveWorkspaceDeletionError';
    this.id = id;
  }
}

export class WorkspaceValidationError extends WorkspaceError {
  constructor(message: string) {
    super(message, 'BAD_REQUEST');
    this.name = 'WorkspaceValidationError';
  }
}

export class WorkspaceDirectoryError extends WorkspaceError {
  readonly dirPath: string;
  constructor(dirPath: string, cause?: unknown) {
    super(`Failed to create workspace directory: ${dirPath}`, 'DIRECTORY_CREATION_FAILED', cause);
    this.name = 'WorkspaceDirectoryError';
    this.dirPath = dirPath;
  }
}

// Aliases for compatibility
export { WorkspaceNotFoundError as WorkspaceProfileNotFoundError };
export { WorkspaceValidationError as WorkspaceProfileValidationError };
export { WorkspaceError as WorkspaceProfileError };

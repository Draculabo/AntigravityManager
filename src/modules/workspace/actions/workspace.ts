import { ipc } from '@/ipc/manager';
import type {
  CreateWorkspaceProfileInput,
  LaunchWorkspaceResult,
  UpdateWorkspaceProfileInput,
  WorkspaceProfile,
  WorkspaceProfileView,
} from '../types';

export function listWorkspaces(): Promise<WorkspaceProfileView[]> {
  return ipc.client.workspace.list();
}

export function getWorkspace(id: string): Promise<WorkspaceProfileView | null> {
  return ipc.client.workspace.get({ id });
}

export function createWorkspace(input: CreateWorkspaceProfileInput): Promise<WorkspaceProfile> {
  return ipc.client.workspace.create(input);
}

export function updateWorkspace(input: UpdateWorkspaceProfileInput): Promise<WorkspaceProfile> {
  return ipc.client.workspace.update(input);
}

export function deleteWorkspace(
  id: string,
  cleanUserDataDir?: boolean,
  force?: boolean,
): Promise<void> {
  return ipc.client.workspace.delete({ id, cleanUserDataDir, force });
}

export function launchWorkspace(id: string): Promise<LaunchWorkspaceResult> {
  return ipc.client.workspace.launch({ id });
}

export function launchWorkspaceForAccount(accountId: string): Promise<LaunchWorkspaceResult> {
  return ipc.client.workspace.launchForAccount({ accountId });
}

export function stopWorkspace(id: string): Promise<void> {
  return ipc.client.workspace.stop({ id });
}

export function selectWorkspaceDirectory(defaultPath?: string): Promise<string | null> {
  return ipc.client.workspace.selectDirectory(defaultPath ? { defaultPath } : undefined);
}

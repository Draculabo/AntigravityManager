import { ipc } from '@/ipc/manager';
import type { AgentTool } from '../agent-tools/agent-tools.schema';
import type { ClientConfigPlan } from '../agent-tools/client-config.schema';
import type { ConnectionProfileView } from '../connection-profiles/connection-profiles.schema';

type Tool = ConnectionProfileView['client'];

export interface NativeToolStatus {
  connected: boolean;
  available: boolean;
  replacement?: boolean;
  hasBackup?: boolean;
  canView?: boolean;
  canRevoke?: boolean;
}

export interface NativeToolConnection {
  status(baseUrl: string): Promise<NativeToolStatus>;
  connect(baseUrl: string, model: string, models: readonly string[]): Promise<unknown>;
  disconnect(baseUrl: string): Promise<unknown>;
  view?(): Promise<{ configPath: string; content: string }>;
  restore?(): Promise<unknown>;
  revoke?(): Promise<unknown>;
}

function agentTool(tool: AgentTool): NativeToolConnection {
  return {
    async status(baseUrl) {
      const status = await ipc.client.gateway.agentTools.status({ tool, baseUrl });
      return {
        connected: status.isConfigured,
        available: true,
        replacement: !status.isConfigured && Boolean(status.currentBaseUrl),
        hasBackup: status.hasBackup,
        canView: status.exists,
      };
    },
    connect: (baseUrl, model) => ipc.client.gateway.agentTools.configure({ tool, baseUrl, model }),
    disconnect: () => ipc.client.gateway.agentTools.remove({ tool }),
    view: () => ipc.client.gateway.agentTools.preview({ tool }),
    restore: () => ipc.client.gateway.agentTools.restore({ tool }),
  };
}

async function applyClientConfig(plan: ClientConfigPlan) {
  const preview = await ipc.client.gateway.clientConfig.preview(plan);
  await ipc.client.gateway.clientConfig.mutate({ plan, expectedSourceHash: preview.sourceHash });
}

function clientConfig(client: 'hermes' | 'openclaw'): NativeToolConnection {
  return {
    async status() {
      const status = await ipc.client.gateway.clientConfig.status({ client });
      const removal = status.exists
        ? await ipc.client.gateway.clientConfig.preview({ client, action: 'remove' })
        : undefined;
      return { available: true, connected: removal?.changed === true };
    },
    connect(baseUrl, activateModel, models) {
      const common = {
        action: 'sync' as const,
        baseUrl,
        activateModel,
        models: models.slice(0, 256),
      };
      return applyClientConfig(
        client === 'hermes'
          ? { ...common, client, discoverModels: true }
          : { ...common, client, version: 'v2', modelsMode: 'preserve' },
      );
    },
    disconnect: () => applyClientConfig({ client, action: 'remove' }),
  };
}

const dshProfile = 'web';

export const nativeToolConnections: Partial<Record<Tool, NativeToolConnection>> = {
  claude: agentTool('claude'),
  codex: agentTool('codex'),
  opencode: {
    async status(baseUrl) {
      const status = await ipc.client.gateway.openCodeStatus({ baseUrl });
      return {
        connected: status.isConfigured,
        available: true,
        canView: status.exists,
        hasBackup: status.hasBackup,
        canRevoke: status.keyConfigured,
      };
    },
    connect: (baseUrl, _model, models) =>
      ipc.client.gateway.syncOpenCode({
        baseUrl,
        models: models.slice(0, 256).map((id) => ({ id })),
        syncAccounts: false,
      }),
    disconnect: (baseUrl) => ipc.client.gateway.clearOpenCode({ baseUrl, clearLegacy: false }),
    view: () => ipc.client.gateway.readOpenCodeConfig(),
    restore: () => ipc.client.gateway.restoreOpenCode(),
    revoke: () => ipc.client.gateway.revokeOpenCodeKey(),
  },
  hermes: clientConfig('hermes'),
  openclaw: clientConfig('openclaw'),
  dsh: {
    async status() {
      const status = await ipc.client.gateway.dsh.status({ profile: dshProfile });
      const removal = status.exists
        ? await ipc.client.gateway.dsh.preview({ profile: dshProfile, action: 'remove' })
        : undefined;
      return { available: status.exists, connected: Boolean(removal?.baseUrl) };
    },
    async connect(baseUrl, activateModel, models) {
      const plan = {
        action: 'sync' as const,
        profile: dshProfile,
        protocol: 'openai-completions' as const,
        baseUrl,
        activateModel,
        models: models.slice(0, 256),
        credentialRef: 'ANTIGRAVITY_MANAGER',
        credentialMode: 'manager-key' as const,
      };
      const preview = await ipc.client.gateway.dsh.preview(plan);
      await ipc.client.gateway.dsh.sync({ ...plan, expectedSourceHash: preview.sourceHash });
    },
    async disconnect() {
      const preview = await ipc.client.gateway.dsh.preview({
        profile: dshProfile,
        action: 'remove',
      });
      await ipc.client.gateway.dsh.remove({
        profile: dshProfile,
        expectedSourceHash: preview.sourceHash,
      });
    },
  },
};

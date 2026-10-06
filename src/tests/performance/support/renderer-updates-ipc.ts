import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { DesktopPreferencesSchema } from '@/modules/config/service-config.schema';
import { serviceConfigPlaceholder } from '@/modules/config/settings-change';
import { DEFAULT_CLOUD_ACCOUNT_ALERT_POLICY } from '@/modules/cloud-account/services/cloud-account-alert-policy.schema';
import type { CloudAccountView } from '@/modules/cloud-account/services/cloud-account-view';
import type {
  TrafficAuditSummary,
  TrafficAuditDetail,
  TrafficAuditBodyDescriptor,
  TrafficAuditBodyPage,
} from '@/modules/proxy-gateway/audit/traffic-audit.types';
import { DEFAULT_WEEKLY_WARMUP_CONFIG } from '@/modules/cloud-account/services/weekly-warmup-contract';
import type { AgentTool } from '@/modules/proxy-gateway/agent-tools/agent-tools.schema';
import type { DeviceProfilesSnapshot } from '@/modules/identity-profile/types';
import type { LocalAccountImportPreview } from '@/modules/cloud-account/local-import/actions';

const fixtureTime = Date.now();
const dialogChecks = new URLSearchParams(window.location.search).has('dialogs');
let profileReads = 0;
let configReads = 0;
let cacheReads = 0;
const deviceProfile = {
  machineId: 'synthetic-device',
  macMachineId: 'synthetic-mac',
  devDeviceId: 'synthetic-installation',
  sqmId: 'synthetic-diagnostics',
};
const deviceSnapshot: DeviceProfilesSnapshot = {
  currentStorage: deviceProfile,
  boundProfile: deviceProfile,
  baseline: deviceProfile,
  history: Array.from({ length: 12 }, (_, i) => ({
    id: `version-${i}`,
    label: `Synthetic version ${i}`,
    createdAt: Math.floor(fixtureTime / 1000) - i * 60,
    profile: deviceProfile,
    isCurrent: i === 0,
  })),
};
export const accounts: CloudAccountView[] = Array.from({ length: 100 }, (_, index) => ({
  id: `synthetic-${index}`,
  provider: 'google',
  email: `synthetic-${index}@example.com`,
  name: `Synthetic ${index}`,
  created_at: Math.floor(fixtureTime / 1000) - (100 - index) * 60,
  last_used: Math.floor(fixtureTime / 1000) - (100 - index) * 60,
  proxy_configured: false,
  quota: { models: { 'gemini-3-pro': { percentage: 80, resetTime: '2099-01-01T00:00:00Z' } } },
}));
export const trafficItems: TrafficAuditSummary[] = Array.from({ length: 50 }, (_, index) => ({
  id: `synthetic-request-${index}`,
  recordKind: 'request',
  trafficClass: 'model',
  timestamp: fixtureTime - index * 1000,
  completedAt: fixtureTime - index * 1000 + 100,
  durationMs: 100,
  attributedAccountId: 'synthetic-0',
  protocol: 'openai',
  method: 'POST',
  url: '/v1/chat/completions',
  model: 'gemini-3-pro',
  mappedModel: 'gemini-3-pro',
  physicalModel: 'gemini-3-pro',
  physicalModelFamily: 'gemini',
  hasImageOutput: false,
  hasTextOutput: true,
  inputTokens: 100,
  outputTokens: 50,
  status: 200,
  outcome: 'completed',
}));
export const feedbackMode = (['loading', 'empty', 'error'] as const).find(
  (mode) => mode === new URLSearchParams(window.location.search).get('feedback'),
);
const accountRead = Promise.withResolvers<CloudAccountView[]>();
const trafficRead = Promise.withResolvers<{ items: TrafficAuditSummary[]; total: number }>();
let accountReads = 0;
let trafficReads = 0;
export function releaseFeedbackReads() {
  accountRead.resolve(accounts);
  trafficRead.resolve({ items: trafficItems, total: 100 });
}
export const statistics = { rows: 100, databaseBytes: 1024, droppedCount: 0, bodyStoredBytes: 0 };
export const desktopPreferences = DesktopPreferencesSchema.strip().parse({
  ...DEFAULT_APP_CONFIG,
  grid_layout: 'list',
});
const initialServiceConfig = serviceConfigPlaceholder();
export const serviceConfig = {
  ...initialServiceConfig,
  proxy: { ...initialServiceConfig.proxy, api_key_configured: true },
};
export const weeklyWarmupConfig = DEFAULT_WEEKLY_WARMUP_CONFIG;
const bodyText = '{"message":"Synthetic response","model":"gemini-3-pro"}';
const responseBody: TrafficAuditBodyDescriptor = {
  id: '00000000-0000-4000-8000-000000000001',
  ownerId: 'attempt-2',
  ownerKind: 'attempt',
  direction: 'response',
  chunkCount: 1,
  completedAt: fixtureTime,
  droppedReason: null,
  errorSummary: null,
  kind: 'json',
  logicalBytes: bodyText.length,
  oversized: false,
  parseErrorOffset: null,
  partial: false,
  representation: 'sanitized_json',
  sha256: null,
  sha256Scope: 'unavailable',
  state: 'complete',
  storedBytes: bodyText.length,
  terminalStatus: 'completed',
};
const requestBody: TrafficAuditBodyDescriptor = {
  ...responseBody,
  id: '00000000-0000-4000-8000-000000000002',
  ownerId: 'synthetic-request-0',
  ownerKind: 'parent',
  direction: 'request',
};
const detailReads = new Map<string, number>();
function syntheticTrafficDetail(id: string): TrafficAuditDetail {
  return {
    recordKind: 'request',
    request: {
      id,
      timestamp: fixtureTime,
      completedAt: fixtureTime + 100,
      durationMs: 100,
      attributedAccountId: 'synthetic-0',
      cachedTokens: 10,
      clientIp: '127.0.0.1',
      error: null,
      hasImageOutput: false,
      hasTextOutput: true,
      inputTokens: 100,
      outputTokens: 50,
      mappedModel: 'gemini-3-pro',
      method: 'POST',
      model: 'gemini-3-pro',
      operation: 'chat',
      outcome: 'completed',
      physicalModel: 'gemini-3-pro',
      physicalModelFamily: 'gemini',
      protocol: 'openai',
      reasoningTokens: 20,
      requestHeaders: '{}',
      requestQuery: null,
      responseHeaders: '{}',
      responsePartial: false,
      sessionId: 'synthetic-session',
      status: 200,
      trafficClass: 'model',
      url: '/v1/chat/completions',
      username: null,
    },
    attempts: [
      {
        accountId: 'synthetic-0',
        accountIdHash: null,
        attemptIndex: 1,
        completedAt: fixtureTime + 20,
        durationMs: 20,
        endpoint: 'https://model.example.invalid',
        error: 'Synthetic temporary limit',
        id: 'attempt-1',
        model: 'gemini-3-pro',
        operation: 'chat',
        outcome: 'upstream_error',
        parentId: id,
        requestHeaders: '{}',
        responseHeaders: '{}',
        responsePartial: false,
        status: 429,
        timestamp: fixtureTime,
      },
      {
        accountId: 'synthetic-0',
        accountIdHash: null,
        attemptIndex: 2,
        completedAt: fixtureTime + 100,
        durationMs: 80,
        endpoint: 'https://model.example.invalid',
        error: null,
        id: 'attempt-2',
        model: 'gemini-3-pro',
        operation: 'chat',
        outcome: 'completed',
        parentId: id,
        requestHeaders: '{}',
        responseHeaders: '{}',
        responsePartial: false,
        status: 200,
        timestamp: fixtureTime + 20,
      },
    ],
    bodies: [{ ...requestBody, ownerId: id }, responseBody],
  };
}

// The profiling window has no preload or provider connection. Unexpected actions fail explicitly.
export const ipc = {
  client: {
    app: { currentPlatfom: async () => 'win32', appVersion: async () => '0.22.0' },
    theme: { setThemeMode: async () => undefined },
    system: {
      get_local_ips: async () => [{ address: '127.0.0.1', name: 'localhost', isRecommended: true }],
    },
    proc: {
      isProcessRunning: async () => false,
      getOperation: async () => 'idle',
    },
    antigravityClientCache: {
      paths: async () => {
        if (!dialogChecks) {
          throw new Error('Cache inspection is not enabled in this fixture.');
        }
        cacheReads += 1;
        if (cacheReads === 1) {
          throw new Error('Synthetic cache read failure');
        }
        return Array.from({ length: 20 }, (_, i) => `C:/synthetic/Antigravity/Cache/location-${i}`);
      },
    },
    config: {
      desktop: { load: async () => desktopPreferences },
      service: { read: async () => serviceConfig },
      accountAlertPolicy: { read: async () => DEFAULT_CLOUD_ACCOUNT_ALERT_POLICY },
    },
    cloud: {
      localImport: {
        preview: async (): Promise<LocalAccountImportPreview> => ({
          sessionId: '00000000-0000-4000-8000-000000000001',
          expiresAt: Math.floor(fixtureTime / 1000) + 300,
          accounts: Array.from({ length: 20 }, (_, i) => ({
            fingerprint: `synthetic-${i}`,
            sources: [{ id: 'antigravity-ide-db', location: 'synthetic' }],
            emailHints: [`synthetic-${i}@example.com`],
            hasAccessToken: true,
            hasIdToken: false,
            identity: { email: `synthetic-${i}@example.com`, name: `Synthetic ${i}` },
          })),
          validationFailures: [],
          discoveryFailures: [],
          merged: [],
          sourceSummaries: [],
          duplicateCount: 0,
          emailCollisionGroups: [],
        }),
        discard: async () => ({ discarded: true }),
      },
      getIdentityProfiles: async () => {
        if (!dialogChecks) {
          throw new Error('Device inspection is not enabled in this fixture.');
        }
        profileReads += 1;
        if (profileReads === 1) {
          throw new Error('Synthetic device read failure');
        }
        return deviceSnapshot;
      },
      listCloudAccounts: async () => {
        accountReads += 1;
        if (feedbackMode === 'loading') {
          return accountRead.promise;
        }
        if (feedbackMode === 'error' && accountReads === 1) {
          throw new Error('Synthetic account read failure');
        }
        return feedbackMode === 'empty' ? [] : accounts;
      },
      getAutoSwitchEnabled: async () => false,
      getWeeklyWarmupConfig: async () => weeklyWarmupConfig,
      getAutoSwitchModelsConfig: async () => ({}),
      listOAuthClients: async () => [],
    },
    gateway: {
      status: async () => ({ running: false }),
      agentTools: {
        status: async ({ tool }: { tool: AgentTool }) => ({
          tool,
          installed: true,
          version: 'test',
          configPath: '/synthetic/config',
          exists: dialogChecks,
          hasBackup: dialogChecks,
          isConfigured: false,
          isSynced: false,
          currentBaseUrl: null,
          model: null,
        }),
        preview: async () => ({
          content: 'model = "synthetic-model"\n' + '# Synthetic configuration\n'.repeat(80),
          configPath: '/synthetic/config',
        }),
      },
      openCodeStatus: async () => ({
        installed: true,
        version: 'test',
        configPath: '/synthetic/opencode.json',
        exists: dialogChecks,
        hasBackup: dialogChecks,
        isConfigured: false,
        isSynced: false,
        currentBaseUrl: null,
        models: dialogChecks ? [{ id: 'gemini-3-pro', name: 'Gemini Pro' }] : [],
        hasAuthPlugin: false,
        keyConfigured: false,
      }),
      readOpenCodeConfig: async () => {
        if (!dialogChecks) {
          throw new Error('Configuration inspection is not enabled in this fixture.');
        }
        configReads += 1;
        if (configReads === 1) {
          throw new Error('Synthetic configuration read failure');
        }
        return {
          fileName: 'opencode.jsonc',
          configPath: '/synthetic/opencode.jsonc',
          content: JSON.stringify(
            {
              apiKey: '[REDACTED]',
              models: Array.from({ length: 40 }, (_, i) => ({
                id: `synthetic-model-${i}`,
                name: `Synthetic model ${i}`,
              })),
            },
            null,
            2,
          ),
        };
      },
      thoughtStats: async () => ({ sessions: 0, databaseBytes: 0, integrity: 'ok' }),
      modelAvailability: async () => [],
      auditList: async () => {
        trafficReads += 1;
        if (feedbackMode === 'loading') {
          return trafficRead.promise;
        }
        if (feedbackMode === 'error' && trafficReads === 1) {
          throw new Error('Synthetic traffic read failure');
        }
        return feedbackMode === 'empty'
          ? { items: [], total: 0 }
          : { items: trafficItems, total: 100 };
      },
      auditStats: async () => (feedbackMode === 'empty' ? { ...statistics, rows: 0 } : statistics),
      auditDetail: async ({ id }: { id: string }) => {
        const count = (detailReads.get(id) ?? 0) + 1;
        detailReads.set(id, count);
        if (id === 'synthetic-request-1') {
          return null;
        }
        if (id === 'synthetic-request-2' && count === 1) {
          throw new Error('Synthetic detail read failure');
        }
        return syntheticTrafficDetail(id);
      },
      auditBodyPage: async ({ bodyId }: { bodyId: string }): Promise<TrafficAuditBodyPage> => ({
        body: bodyId === requestBody.id ? requestBody : responseBody,
        chunks: [{ data: bodyText, sequence: 0 }],
        complete: true,
        nextCursor: null,
      }),
      auditFilterOptions: async () => ({ accountIds: ['synthetic-0'], modelFamilies: ['gemini'] }),
    },
  },
};

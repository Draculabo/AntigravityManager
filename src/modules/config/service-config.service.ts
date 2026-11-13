import { createHash, randomUUID } from 'node:crypto';
import { ConfigManager } from './ipc/manager';
import type { AppConfig, ProxyConfig } from './types';
import {
  ServiceConfigSnapshotSchema,
  AuditConfigConflictError,
  ServiceRuntimeSchema,
  ServiceConfigUpdateSchema,
  GatewayThinkingBudgetPatchSchema,
  InvalidGatewayThinkingBudgetError,
  ServiceSecretWriteSchema,
  type ServiceConfigSnapshot,
  type ServiceConfigUpdate,
  type ServiceConfigWriteResult,
  type ServiceSecretName,
  type ServiceSecretWrite,
  type ServiceConfigApplyIssue,
} from './service-config.schema';
import { setServerConfig } from '@/server/server-config';
import { getNestServerRestartFields, getNestServerStatus } from '@/server/main';
import { trafficAuditService } from '@/modules/proxy-gateway/audit/traffic-audit.service';
import { thoughtStoreService } from '@/modules/proxy-gateway/thought-store/thought-store.service';
import { logger } from '@/shared/logging/logger';
import {
  assertValidUpstreamProxyConfig,
  UpstreamProxyConfigurationError,
  UpstreamProxyUrlSchema,
} from './upstream-proxy.schema';
import { assertPredictableModelAliasEquivalence } from './model-aliases';
import { hasConfiguredApiKey } from '@/shared/security/api-key';
import { validateClientAddressPolicy } from '@/shared/network/client-address';
import { errorProcessOwner } from '@/modules/error-diagnostics/public';
import { resolveErrorWindowBudget } from '@/modules/error-diagnostics/configuration';

export interface ServiceConfigOperations {
  read(): Promise<ServiceConfigSnapshot>;
  update(input: ServiceConfigUpdate): Promise<ServiceConfigWriteResult>;
  writeSecret(input: ServiceSecretWrite): Promise<ServiceConfigWriteResult>;
  revealSecret(name: ServiceSecretName): Promise<{ value: string }>;
  generateKey(): Promise<ServiceConfigWriteResult>;
}

export interface ServiceConfigDependencies {
  load(): AppConfig;
  loadForCleanup?(): AppConfig;
  save(config: AppConfig): Promise<void>;
  apply(proxy: ProxyConfig, config?: AppConfig): Promise<boolean | { issues: ServiceConfigApplyIssue[] }>;
  runningPort(): Promise<number | null>;
  restartFields?(proxy: ProxyConfig): string[];
  initialization?(): ServiceConfigSnapshot['initialization'];
}

export function projectServiceConfig(config: AppConfig): ServiceConfigSnapshot {
  const { api_key, upstream_proxy, ...proxy } = config.proxy;
  return ServiceConfigSnapshotSchema.parse({
    errorDiagnosticsBudget: resolveErrorWindowBudget(
      config.error_diagnostics.max_storage_mib,
      process.env.AGM_INTERNAL_ERROR_LOG_MB,
    ),
    auditRevision: auditConfigRevision(config.proxy.traffic_audit),
    ...ServiceRuntimeSchema.strip().parse(config),
    proxy: {
      ...proxy,
      upstream_proxy: { enabled: upstream_proxy.enabled },
      api_key_configured: Boolean(api_key),
      upstream_proxy_configured: UpstreamProxyUrlSchema.safeParse(upstream_proxy.url).success,
    },
  });
}

function auditConfigRevision(config: ProxyConfig['traffic_audit']): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        config.enabled,
        config.capture_successful_probes,
        config.max_disk_mib,
        config.max_rows,
        config.max_queue_records,
        config.max_queue_mib,
      ]),
    )
    .digest('hex');
}

function listenerConfigurationChanged(previous: ProxyConfig, next: ProxyConfig): boolean {
  return previous.port !== next.port || previous.network.lan_access !== next.network.lan_access;
}

function isExternalListenAddress(address: string | undefined): boolean {
  return Boolean(address && address !== '127.0.0.1' && address !== '::1');
}

function mergeProxyPatch(previous: ProxyConfig, patch: ServiceConfigUpdate['proxy']): ProxyConfig {
  if (!patch) {
    return previous;
  }

  const { upstream_proxy: _upstreamProxy, ...patchWithoutUpstreamProxy } = patch;
  return {
    ...previous,
    ...patchWithoutUpstreamProxy,
    global_system_prompt: {
      ...previous.global_system_prompt,
      ...patch.global_system_prompt,
    },
    upstream_proxy: {
      ...previous.upstream_proxy,
      ...patch.upstream_proxy,
    },
    experimental: {
      ...previous.experimental,
      ...patch.experimental,
    },
    traffic_audit: {
      ...previous.traffic_audit,
      ...patch.traffic_audit,
    },
    thought_store: {
      ...previous.thought_store,
      ...patch.thought_store,
    },
    image_scheduler: {
      ...previous.image_scheduler,
      ...patch.image_scheduler,
    },
    cowork_compaction: {
      ...previous.cowork_compaction,
      ...patch.cowork_compaction,
    },
    thinking_budget: {
      ...previous.thinking_budget,
      ...patch.thinking_budget,
    },
    network: {
      ...previous.network,
      ...patch.network,
    },
  };
}

/** Serializes the read/merge/persist/apply cycle so concurrent patches cannot lose fields. */
export function createServiceConfigService(
  dependencies: ServiceConfigDependencies,
): ServiceConfigOperations & {
  closeAdmission(): void;
  drain(): Promise<void>;
  ensureModelAlias(alias: string, target: string): Promise<'added' | 'existing' | 'disabled'>;
  clearDeletedAccountPreference(accountId: string, shouldClear?: () => boolean): Promise<void>;
} {
  let queue: Promise<unknown> = Promise.resolve();
  let accepting = true;
  // At most 4 MiB of admitted 128-KiB management messages, including the active write.
  const maxPendingWrites = (4 * 1024 * 1024) / (128 * 1024);
  let pendingWrites = 0;
  let initialDiagnosticStorage: number | undefined;
  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    if (!accepting) {
      return Promise.reject(new Error('Settings cannot be changed while the service is shutting down.'));
    }
    if (pendingWrites >= maxPendingWrites) {
      return Promise.reject(new Error('The settings queue is full. Try again after pending saves finish.'));
    }
    pendingWrites += 1;
    const task = queue.catch(() => undefined).then(work).finally(() => {
      pendingWrites -= 1;
    });
    queue = task;
    return task;
  }
  function mutate(
    change: (previous: AppConfig) => AppConfig,
    validateModelAliases = false,
  ): Promise<ServiceConfigWriteResult> {
    return enqueue(async () => {
        const previous = dependencies.load();
        initialDiagnosticStorage ??= previous.error_diagnostics.max_storage_mib;
        const next = change(previous);
        // Validate public fields before touching disk, including legacy files loaded by older codecs.
        projectServiceConfig(next);
        if (validateModelAliases) {
          assertPredictableModelAliasEquivalence(next.proxy);
        }
        await dependencies.save(next);
        const saved = dependencies.load();
        const issues: ServiceConfigApplyIssue[] = [];
        try {
          const applied = await dependencies.apply(saved.proxy, saved);
          if (typeof applied === 'boolean') {
            if (!applied) {
              const diagnosticId = randomUUID();
              issues.push({ step: 'gateway-config', fields: ['proxy'], reason: 'runtime-application-failed', diagnosticId });
              logger.error('Configuration was saved; the runtime consumer rejected application.', { diagnosticId });
            }
          } else {
            issues.push(...applied.issues);
          }
        } catch (error) {
          const diagnosticId = randomUUID();
          issues.push({ step: 'gateway-config', fields: ['proxy'], reason: 'runtime-application-failed', diagnosticId });
          logger.error('Configuration was saved; runtime application failed.', { diagnosticId }, error);
        }
        let port: number | null = null;
        try {
          port = await dependencies.runningPort();
        } catch (error) {
          const diagnosticId = randomUUID();
          issues.push({ step: 'runtime-status', fields: ['proxy.port', 'proxy.network.lan_access'], reason: 'runtime-application-failed', diagnosticId });
          logger.error('Configuration was saved; runtime status is unavailable.', { diagnosticId }, error);
        }
        const listenerNeedsRestart =
          port !== null && listenerConfigurationChanged(previous.proxy, saved.proxy);
        const restartFields: string[] = dependencies.restartFields?.(saved.proxy) ?? [];
        if (!dependencies.restartFields && (listenerNeedsRestart || (port !== null && port !== saved.proxy.port))) {
          restartFields.push('proxy.port', 'proxy.network.lan_access');
        }
        if (initialDiagnosticStorage !== saved.error_diagnostics.max_storage_mib) {
          restartFields.push('error_diagnostics.max_storage_mib');
        }
        return {
          state: issues.length ? 'partial-failure' : restartFields.length ? 'restart-required' : 'applied',
          snapshot: projectServiceConfig(saved),
          issues,
          restartFields,
        } satisfies ServiceConfigWriteResult;
      });
  }
  return {
    clearDeletedAccountPreference: (accountId, shouldClear) => {
      return enqueue(async () => {
          const previous = (dependencies.loadForCleanup ?? dependencies.load)();
          if (
            previous.proxy.preferred_account_id.trim() !== accountId ||
            (shouldClear && !shouldClear())
          ) {
            return;
          }
          const next = { ...previous, proxy: { ...previous.proxy, preferred_account_id: '' } };
          projectServiceConfig(next);
          await dependencies.save(next);
          const applied = await dependencies.apply(next.proxy, next);
          if (applied === false || (typeof applied !== 'boolean' && applied.issues.length > 0)) {
            throw new Error(
              'Deleted account preference was saved, but runtime application requires restart.',
            );
          }
        });
    },
    // Trusted feature operations use the same mutation queue as public settings updates.
    ensureModelAlias: async (alias, target) => {
      let outcome: 'added' | 'existing' | 'disabled' = 'added';
      await mutate((previous) => {
        const existing = previous.proxy.model_aliases.find((route) => route.alias === alias);
        if (existing) {
          outcome = existing.enabled ? 'existing' : 'disabled';
          return previous;
        }
        return {
          ...previous,
          proxy: {
            ...previous.proxy,
            model_aliases: [...previous.proxy.model_aliases, { alias, target, enabled: true }],
          },
        };
      }, true);
      return outcome;
    },
    closeAdmission: () => {
      accepting = false;
    },
    drain: async () => {
      await queue.catch(() => undefined);
    },
    read: async () => ({
      ...projectServiceConfig(dependencies.load()),
      ...(dependencies.initialization ? { initialization: dependencies.initialization() } : {}),
    }),
    update: (input) => {
      const { expectedAuditRevision, ...patch } = ServiceConfigUpdateSchema.parse(input);
      const validatesModelAliases =
        patch.proxy?.model_aliases !== undefined ||
        patch.proxy?.custom_mapping !== undefined ||
        patch.proxy?.anthropic_mapping !== undefined;
      return mutate((previous) => {
        const thinkingPatch = patch.proxy?.thinking_budget;
        if (thinkingPatch) {
          const thinking = { ...previous.proxy.thinking_budget, ...thinkingPatch };
          if (thinking.control_source === 'gateway') {
            if (
              !GatewayThinkingBudgetPatchSchema.safeParse(
                thinkingPatch.control_source === 'gateway' ? thinking : thinkingPatch,
              ).success
            ) {
              throw new InvalidGatewayThinkingBudgetError();
            }
          }
        }
        if (
          (patch.proxy?.traffic_audit !== undefined || expectedAuditRevision !== undefined) &&
          expectedAuditRevision !== auditConfigRevision(previous.proxy.traffic_audit)
        ) {
          throw new AuditConfigConflictError();
        }
        const upstreamProxy = { ...previous.proxy.upstream_proxy, ...patch.proxy?.upstream_proxy };
        if (patch.proxy?.upstream_proxy) {
          assertValidUpstreamProxyConfig(upstreamProxy);
        }
        if (
          patch.proxy?.network?.lan_access === true &&
          !hasConfiguredApiKey(previous.proxy.api_key)
        ) {
          throw new Error('LAN access requires an API key.');
        }
        const network = { ...previous.proxy.network, ...patch.proxy?.network };
        if (patch.proxy?.network) {
          const invalidAddresses = validateClientAddressPolicy(network);
          if (invalidAddresses.length > 0) {
            throw new Error(`Invalid IP address or CIDR: ${invalidAddresses.join(', ')}`);
          }
        }
        return {
          ...previous,
          ...patch,
          proxy: mergeProxyPatch(previous.proxy, {
            ...patch.proxy,
            upstream_proxy: upstreamProxy,
          }),
        };
      }, validatesModelAliases);
    },
    writeSecret: async (input) => {
      const secret = ServiceSecretWriteSchema.parse(input);
      if (secret.name === 'api-key' && !hasConfiguredApiKey(secret.value ?? '')) {
        const current = dependencies.load();
        const status = await getNestServerStatus();
        const externallyBound =
          status.running &&
          (isExternalListenAddress(status.listen_address) ||
            (!status.listen_address && current.proxy.network.lan_access));
        if (externallyBound && hasConfiguredApiKey(current.proxy.api_key)) {
          throw new Error(
            'A LAN gateway requires an API key. Stop the gateway or switch to local-only access and restart before clearing it.',
          );
        }
      }
      return mutate((previous) => {
        if (secret.name === 'api-key') {
          return { ...previous, proxy: { ...previous.proxy, api_key: secret.value ?? '' } };
        }
        const url = secret.value?.trim() ?? '';
        if (url && !UpstreamProxyUrlSchema.safeParse(url).success) {
          throw new UpstreamProxyConfigurationError();
        }
        return {
          ...previous,
          proxy: {
            ...previous.proxy,
            // Clearing the address and disabling its use are one queued, atomic write.
            upstream_proxy: { enabled: url ? previous.proxy.upstream_proxy.enabled : false, url },
          },
        };
      });
    },
    revealSecret: async (name) => {
      const config = dependencies.load();
      return { value: name === 'api-key' ? config.proxy.api_key : config.proxy.upstream_proxy.url };
    },
    generateKey: () =>
      mutate((previous) => ({
        ...previous,
        proxy: { ...previous.proxy, api_key: `sk-${randomUUID().replace(/-/g, '')}` },
      })),
  };
}

export const serviceConfigService = createServiceConfigService({
  initialization: () => ConfigManager.getInitializationState(),
  restartFields: getNestServerRestartFields,
  loadForCleanup: () => ConfigManager.loadConfig(true),
  load: () => ConfigManager.getCachedConfig() ?? ConfigManager.loadConfig(true),
  save: (config) => ConfigManager.saveConfig(config),
  runningPort: async () => {
    const status = await getNestServerStatus();
    return status.running ? status.port : null;
  },
  apply: async (proxy, config) => {
    const issues: ServiceConfigApplyIssue[] = [];
    const steps: Array<{ step: ServiceConfigApplyIssue['step']; fields: string[]; run(): void | Promise<void> }> = [
      { step: 'gateway-config', fields: ['proxy'], run: () => setServerConfig(structuredClone(proxy)) },
      { step: 'audit', fields: ['proxy.traffic_audit'], run: async () => { await trafficAuditService.configure(proxy.traffic_audit); } },
      { step: 'thought-store', fields: ['proxy.thought_store'], run: async () => { await thoughtStoreService.configure(proxy.thought_store); } },
      ...(config ? [{ step: 'error-diagnostics' as const, fields: ['error_diagnostics'], run: async () => { await errorProcessOwner.configure(config.error_diagnostics); } }] : []),
    ];
    for (const { step, fields, run } of steps) {
      try {
        await run();
      } catch (error) {
        const diagnosticId = randomUUID();
        logger.error('Configuration was saved; runtime consumer application failed.', { diagnosticId, step, fields }, error);
        issues.push({ step, fields, reason: 'runtime-application-failed', diagnosticId });
      }
    }
    trafficAuditService.recordAdminOperation('configure_thought_store');
    return { issues };
  },
});

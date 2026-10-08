import { randomUUID } from 'node:crypto';
import { ConfigManager } from './ipc/manager';
import type { AppConfig, ProxyConfig } from './types';
import {
  ServiceConfigSnapshotSchema,
  ServiceRuntimeSchema,
  ServiceConfigUpdateSchema,
  ServiceSecretWriteSchema,
  type ServiceConfigSnapshot,
  type ServiceConfigUpdate,
  type ServiceConfigWriteResult,
  type ServiceSecretName,
  type ServiceSecretWrite,
} from './service-config.schema';
import { setServerConfig } from '@/server/server-config';
import { getNestServerStatus } from '@/server/main';
import { trafficAuditService } from '@/modules/proxy-gateway/audit/traffic-audit.service';
import { thoughtStoreService } from '@/modules/proxy-gateway/thought-store/thought-store.service';
import { logger } from '@/shared/logging/logger';
import {
  assertValidUpstreamProxyConfig,
  UpstreamProxyConfigurationError,
  UpstreamProxyUrlSchema,
} from './upstream-proxy.schema';

export interface ServiceConfigOperations {
  read(): Promise<ServiceConfigSnapshot>;
  update(input: ServiceConfigUpdate): Promise<ServiceConfigWriteResult>;
  writeSecret(input: ServiceSecretWrite): Promise<ServiceConfigWriteResult>;
  revealSecret(name: ServiceSecretName): Promise<{ value: string }>;
  generateKey(): Promise<ServiceConfigWriteResult>;
}

export interface ServiceConfigDependencies {
  load(): AppConfig;
  save(config: AppConfig): Promise<void>;
  apply(proxy: ProxyConfig): Promise<boolean>;
  runningPort(): Promise<number | null>;
}

export function projectServiceConfig(config: AppConfig): ServiceConfigSnapshot {
  const { api_key, upstream_proxy, ...proxy } = config.proxy;
  return ServiceConfigSnapshotSchema.parse({
    ...ServiceRuntimeSchema.strip().parse(config),
    proxy: {
      ...proxy,
      upstream_proxy: { enabled: upstream_proxy.enabled },
      api_key_configured: Boolean(api_key),
      upstream_proxy_configured: UpstreamProxyUrlSchema.safeParse(upstream_proxy.url).success,
    },
  });
}

/** Serializes the read/merge/persist/apply cycle so concurrent patches cannot lose fields. */
export function createServiceConfigService(
  dependencies: ServiceConfigDependencies,
): ServiceConfigOperations & {
  closeAdmission(): void;
  drain(): Promise<void>;
  ensureModelAlias(alias: string, target: string): Promise<'added' | 'existing' | 'disabled'>;
} {
  let queue: Promise<unknown> = Promise.resolve();
  let accepting = true;
  function mutate(change: (previous: AppConfig) => AppConfig): Promise<ServiceConfigWriteResult> {
    if (!accepting) {
      return Promise.reject(
        new Error('Settings cannot be changed while the service is shutting down.'),
      );
    }
    const task = queue
      .catch(() => undefined)
      .then(async () => {
        const previous = dependencies.load();
        const next = change(previous);
        // Validate public fields before touching disk, including legacy files loaded by older codecs.
        projectServiceConfig(next);
        await dependencies.save(next);
        const saved = dependencies.load();
        let applied = false;
        try {
          applied = await dependencies.apply(saved.proxy);
        } catch {
          logger.warn('Service configuration persisted; runtime application requires restart');
        }
        let port: number | null = null;
        try {
          port = await dependencies.runningPort();
        } catch {
          applied = false;
          logger.warn('Service configuration persisted; runtime status requires restart');
        }
        return {
          state:
            applied && (port === null || port === saved.proxy.port)
              ? ('applied' as const)
              : ('restart-required' as const),
          snapshot: projectServiceConfig(saved),
        };
      });
    queue = task;
    return task;
  }
  return {
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
      });
      return outcome;
    },
    closeAdmission: () => {
      accepting = false;
    },
    drain: async () => {
      await queue.catch(() => undefined);
    },
    read: async () => projectServiceConfig(dependencies.load()),
    update: (input) => {
      const patch = ServiceConfigUpdateSchema.parse(input);
      return mutate((previous) => {
        const upstreamProxy = { ...previous.proxy.upstream_proxy, ...patch.proxy?.upstream_proxy };
        if (patch.proxy?.upstream_proxy) {
          assertValidUpstreamProxyConfig(upstreamProxy);
        }
        return {
          ...previous,
          ...patch,
          proxy: { ...previous.proxy, ...patch.proxy, upstream_proxy: upstreamProxy },
        };
      });
    },
    writeSecret: (input) => {
      const secret = ServiceSecretWriteSchema.parse(input);
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
  load: () => ConfigManager.getCachedConfig() ?? ConfigManager.loadConfig(),
  save: (config) => ConfigManager.saveConfig(config),
  runningPort: async () => {
    const status = await getNestServerStatus();
    return status.running ? status.port : null;
  },
  apply: async (proxy) => {
    setServerConfig(structuredClone(proxy));
    const results = await Promise.allSettled([
      trafficAuditService.configure(proxy.traffic_audit),
      thoughtStoreService.configure(proxy.thought_store),
    ]);
    trafficAuditService.recordAdminOperation('configure_thought_store');
    const applied = results.every((result) => result.status === 'fulfilled');
    if (!applied) {
      logger.warn('Service persistence settings saved; runtime application requires restart');
    }
    return applied;
  },
});

import { z } from 'zod';
import { AppConfigSchema, ProxyConfigSchema } from './types';
import type { CloudAccountAlertPolicy } from '@/modules/cloud-account/services/cloud-account-alert-policy.schema';

export const SERVICE_CONFIG_MAX_BYTES = 128 * 1024;
export const ServiceConfigErrorCodeSchema = z.enum(['unavailable', 'invalid-input']);
const text = z.string().max(4096);
const model = z.string().max(256);
const mapping = z.record(model, model).refine((value) => Object.keys(value).length <= 256);

/** Durable codecs stay unchanged; these limits apply at the management boundary. */
export const ServiceProxySchema = ProxyConfigSchema.omit({ api_key: true, upstream_proxy: true })
  .extend({
    backend_canary_enabled: z.boolean(),
    parity_enabled: z.boolean(),
    quota_aware_scheduling_enabled: z.boolean(),
    parity_shadow_enabled: z.boolean(),
    parity_kill_switch: z.boolean(),
    scheduling_mode: ProxyConfigSchema.shape.scheduling_mode.removeDefault(),
    account_selection_strategy: ProxyConfigSchema.shape.account_selection_strategy.removeDefault(),
    circuit_breaker_enabled: z.boolean(),
    only_raw_quota_models: z.boolean(),
    port: z.number().int().min(1024).max(65535),
    preferred_account_id: z.string().max(256),
    request_timeout: z.number().finite().min(1).max(3600),
    max_wait_seconds: z.number().finite().min(0).max(3600),
    parity_no_go_mismatch_rate: z.number().finite().min(0).max(1),
    parity_no_go_error_rate: z.number().finite().min(0).max(1),
    circuit_breaker_backoff_steps: z.array(z.number().finite().nonnegative().max(86400)).max(32),
    model_aliases: z
      .array(z.strictObject({ alias: model.min(1), target: model.min(1), enabled: z.boolean() }))
      .max(256),
    custom_mapping: mapping,
    anthropic_mapping: mapping,
    global_system_prompt: z.strictObject({ enabled: z.boolean(), content: z.string().max(32768) }),
    upstream_proxy: z.strictObject({ enabled: z.boolean() }),
    experimental: ProxyConfigSchema.shape.experimental.removeDefault().strict(),
    traffic_audit: ProxyConfigSchema.shape.traffic_audit.removeDefault().strict(),
    thought_store: ProxyConfigSchema.shape.thought_store.removeDefault().strict(),
    image_scheduler: z.strictObject({ per_account_concurrency: z.number().int().min(0).max(256) }),
  })
  .strict();

export const ServiceRuntimeSchema = AppConfigSchema.pick({
  antigravity_executable: true,
  antigravity_ide_executable: true,
  antigravity_cli_executable: true,
  antigravity_args: true,
  antigravity_ide_args: true,
})
  .extend({
    antigravity_executable: text.nullable(),
    antigravity_ide_executable: text.nullable(),
    antigravity_cli_executable: text.nullable(),
    antigravity_args: z.array(text).max(64),
    antigravity_ide_args: z.array(text).max(64),
  })
  .strict();

export const ServiceConfigSnapshotSchema = ServiceRuntimeSchema.extend({
  proxy: ServiceProxySchema.extend({
    api_key_configured: z.boolean(),
    upstream_proxy_configured: z.boolean(),
  }),
});
const bounded = (value: object) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength <= SERVICE_CONFIG_MAX_BYTES;
export const ServiceConfigUpdateSchema = ServiceRuntimeSchema.partial()
  .extend({ proxy: ServiceProxySchema.partial().optional() })
  .strict()
  .refine(bounded);
export const ServiceSecretNameSchema = z.enum(['api-key', 'upstream-proxy']);
export const ServiceSecretWriteSchema = z
  .strictObject({ name: ServiceSecretNameSchema, value: z.string().max(4096).nullable() })
  .refine((value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 3000);
export const ServiceSecretRevealSchema = z.strictObject({ value: z.string().max(4096) });
export const ServiceConfigWriteResultSchema = z.strictObject({
  state: z.enum(['applied', 'restart-required']),
  snapshot: ServiceConfigSnapshotSchema,
});
export type ServiceConfigSnapshot = z.infer<typeof ServiceConfigSnapshotSchema>;
export type ServiceConfigUpdate = z.infer<typeof ServiceConfigUpdateSchema>;
export type ServiceSecretName = z.infer<typeof ServiceSecretNameSchema>;
export type ServiceSecretWrite = z.infer<typeof ServiceSecretWriteSchema>;
export type ServiceConfigWriteResult = z.infer<typeof ServiceConfigWriteResultSchema>;

export const DesktopPreferencesSchema = AppConfigSchema.omit({
  proxy: true,
  antigravity_executable: true,
  antigravity_ide_executable: true,
  antigravity_cli_executable: true,
  antigravity_args: true,
  antigravity_ide_args: true,
  quota_alert_enabled: true,
  quota_alert_threshold: true,
  ai_credits_alert_enabled: true,
  ai_credits_alert_threshold: true,
})
  .extend({
    owner_mode: z.enum(['desktop-embedded', 'standalone-core']).optional(),
    language: z.string().max(32),
    theme: z.string().max(32),
    refresh_interval: z.number().finite().min(1).max(1440),
    sync_interval: z.number().finite().min(1).max(1440),
    default_export_path: text.nullable().optional(),
    model_visibility: z
      .record(model, z.boolean())
      .refine((value) => Object.keys(value).length <= 1024),
    account_tier_filter: z.array(z.string().max(128)).max(128),
  })
  .strict();
export type DesktopPreferences = z.infer<typeof DesktopPreferencesSchema>;
export const DesktopPreferencesUpdateSchema = DesktopPreferencesSchema.extend({
  start_in_tray: z.boolean(),
  telemetry_enabled: z.boolean(),
  clarity_enabled: z.boolean(),
  privacy_consent_asked: z.boolean(),
  provider_groupings_enabled: z.boolean(),
  grid_layout: AppConfigSchema.shape.grid_layout.removeDefault(),
  account_sort: AppConfigSchema.shape.account_sort.removeDefault(),
}).partial();
export type DesktopPreferencesUpdate = z.infer<typeof DesktopPreferencesUpdateSchema>;
export type SettingsConfig = DesktopPreferences & ServiceConfigSnapshot & CloudAccountAlertPolicy;

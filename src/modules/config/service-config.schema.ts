import { z } from 'zod';
import { AppConfigSchema, ProxyConfigSchema, ThinkingBudgetConfigSchema } from './types';
import type { CloudAccountAlertPolicy } from '@/modules/cloud-account/services/cloud-account-alert-policy.schema';
import { ErrorWindowBudgetSchema } from '@/modules/error-diagnostics/configuration';
import {
  DEFAULT_DESKTOP_ZOOM,
  DESKTOP_ZOOM_LEVELS,
  normalizeDesktopLanguage,
} from '@/modules/app-shell/desktop-appearance';

export const SERVICE_CONFIG_MAX_BYTES = 128 * 1024;
export const ServiceConfigErrorCodeSchema = z.enum(['unavailable', 'invalid-input', 'conflict']);
export class AuditConfigConflictError extends Error {
  constructor() {
    super('Audit settings changed. Refresh before retrying.');
  }
}
export class InvalidGatewayThinkingBudgetError extends Error {
  constructor() {
    super('Gateway thinking budgets must be -1 or a positive whole number.');
  }
}
const ServiceConfigErrorDataSchema = z.strictObject({ configCode: ServiceConfigErrorCodeSchema });

export function readServiceConfigErrorCode(error: unknown) {
  if (typeof error !== 'object' || error === null || !('data' in error)) {
    return null;
  }
  const result = ServiceConfigErrorDataSchema.safeParse(error.data);
  return result.success ? result.data.configCode : null;
}

const text = z.string().max(4096);
const model = z.string().max(256);
const mapping = z.record(model, model).refine((value) => Object.keys(value).length <= 256);

/** Durable codecs stay unchanged; these limits apply at the management boundary. */
export const ServiceProxySchema = ProxyConfigSchema.omit({ api_key: true, upstream_proxy: true })
  .extend({
    backend_canary_enabled: z.boolean(),
    parity_enabled: z.boolean(),
    quota_aware_scheduling_enabled: z.boolean(),
    weekly_quota_priority_enabled: z.boolean(),
    parity_shadow_enabled: z.boolean(),
    parity_kill_switch: z.boolean(),
    scheduling_mode: ProxyConfigSchema.shape.scheduling_mode.removeDefault(),
    account_selection_strategy: ProxyConfigSchema.shape.account_selection_strategy.removeDefault(),
    circuit_breaker_enabled: z.boolean(),
    only_raw_quota_models: z.boolean(),
    port: z.number().int().min(1024).max(65535),
    preferred_account_id: z.string().max(256),
    request_timeout: z.number().finite().min(1).max(3600),
    generation_timeout: ProxyConfigSchema.shape.generation_timeout.removeDefault(),
    max_wait_seconds: z.number().finite().min(0).max(3600),
    parity_no_go_mismatch_rate: z.number().finite().min(0).max(1),
    parity_no_go_error_rate: z.number().finite().min(0).max(1),
    circuit_breaker_backoff_steps: z.array(z.number().finite().nonnegative().max(86400)).max(32),
    model_aliases: z
      .array(
        z.strictObject({
          alias: model.min(1),
          target: model.min(1),
          enabled: z.boolean(),
          published: z.boolean().optional(),
        }),
      )
      .max(256),
    custom_mapping: mapping,
    anthropic_mapping: mapping,
    global_system_prompt: z.strictObject({ enabled: z.boolean(), content: z.string().max(32768) }),
    upstream_proxy: z.strictObject({ enabled: z.boolean() }),
    experimental: ProxyConfigSchema.shape.experimental.removeDefault().strict(),
    traffic_audit: ProxyConfigSchema.shape.traffic_audit.removeDefault().strict(),
    thought_store: ProxyConfigSchema.shape.thought_store.removeDefault().strict(),
    image_scheduler: z.strictObject({
      per_account_concurrency: z.number().int().min(0).max(256),
      send_window_enabled: z.boolean(),
      send_window_strategy: z.enum(['count', 'memory']),
      send_window_count: z.number().int().min(0).max(256),
      send_window_memory_mib: z.number().int().min(1).max(512),
      send_window_strip_remote_urls: z.boolean(),
    }),
    cowork_compaction: ProxyConfigSchema.shape.cowork_compaction.removeDefault().strict(),
    thinking_budget: ProxyConfigSchema.shape.thinking_budget.removeDefault().strict(),
  })
  .strict();

export const ServiceRuntimeSchema = AppConfigSchema.pick({
  error_diagnostics: true,
  antigravity_executable: true,
  antigravity_ide_executable: true,
  antigravity_cli_executable: true,
  antigravity_args: true,
  antigravity_ide_args: true,
})
  .extend({
    antigravity_executable: text.nullable(),
    error_diagnostics: AppConfigSchema.shape.error_diagnostics.removeDefault().strict(),
    antigravity_ide_executable: text.nullable(),
    antigravity_cli_executable: text.nullable(),
    antigravity_args: z.array(text).max(64),
    antigravity_ide_args: z.array(text).max(64),
  })
  .strict();

export const ServiceConfigSnapshotSchema = ServiceRuntimeSchema.extend({
  initialization: z
    .strictObject({
      source: z.enum(['missing', 'blank']),
      writeback: z.enum(['saved', 'failed']),
      diagnosticId: z.string().uuid().optional(),
    })
    .optional(),
  errorDiagnosticsBudget: ErrorWindowBudgetSchema,
  auditRevision: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  proxy: ServiceProxySchema.extend({
    api_key_configured: z.boolean(),
    upstream_proxy_configured: z.boolean(),
  }),
});
const bounded = (value: object) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength <= SERVICE_CONFIG_MAX_BYTES;

// Durable defaults must not overwrite fields omitted from an incremental update.
const coworkCompactionFields = ServiceProxySchema.shape.cowork_compaction.shape;
const CoworkCompactionPatchSchema = z
  .strictObject({
    auto_enabled: coworkCompactionFields.auto_enabled.removeDefault(),
    manual_enabled: coworkCompactionFields.manual_enabled.removeDefault(),
    auto_threshold: coworkCompactionFields.auto_threshold.removeDefault(),
    trusted_client_key_hashes: coworkCompactionFields.trusted_client_key_hashes.removeDefault(),
  })
  .partial();

const thinkingBudgetFields = ThinkingBudgetConfigSchema.shape;
const ThinkingBudgetPatchSchema = z
  .strictObject({
    control_source: thinkingBudgetFields.control_source.removeDefault(),
    flash_low: thinkingBudgetFields.flash_low.removeDefault(),
    flash_medium: thinkingBudgetFields.flash_medium.removeDefault(),
    flash_high: thinkingBudgetFields.flash_high.removeDefault(),
    flash_tiered: thinkingBudgetFields.flash_tiered.removeDefault(),
    pro_low: thinkingBudgetFields.pro_low.removeDefault(),
    pro_high: thinkingBudgetFields.pro_high.removeDefault(),
    claude_budget: thinkingBudgetFields.claude_budget.removeDefault(),
    claude_low: thinkingBudgetFields.claude_low.removeDefault(),
    claude_medium: thinkingBudgetFields.claude_medium.removeDefault(),
    claude_high: thinkingBudgetFields.claude_high.removeDefault(),
  })
  .partial();

const ServiceProxyUpdateSchema = ServiceProxySchema.partial().extend({
  global_system_prompt: ServiceProxySchema.shape.global_system_prompt.partial().optional(),
  upstream_proxy: ServiceProxySchema.shape.upstream_proxy.partial().optional(),
  experimental: ServiceProxySchema.shape.experimental.partial().optional(),
  traffic_audit: ServiceProxySchema.shape.traffic_audit.partial().optional(),
  thought_store: ServiceProxySchema.shape.thought_store.partial().optional(),
  image_scheduler: ServiceProxySchema.shape.image_scheduler.partial().optional(),
  cowork_compaction: CoworkCompactionPatchSchema.optional(),
  thinking_budget: ThinkingBudgetPatchSchema.optional(),
  network: ProxyConfigSchema.shape.network.unwrap().partial().optional(),
});

/** Write-only validation preserves readable legacy configuration without accepting new zero budgets. */
export const GatewayThinkingBudgetPatchSchema = ThinkingBudgetPatchSchema.superRefine(
  (patch, context) => {
    for (const [field, value] of Object.entries(patch)) {
      if (value === 0) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: 'Use -1 or a positive gateway thinking budget',
        });
      }
    }
  },
);

export const ServiceConfigUpdateSchema = ServiceRuntimeSchema.partial()
  .extend({ proxy: ServiceProxyUpdateSchema.optional() })
  .extend({
    expectedAuditRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
  })
  .strict()
  .refine(bounded);
export const ServiceSecretNameSchema = z.enum(['api-key', 'upstream-proxy']);
export const ServiceSecretWriteSchema = z
  .strictObject({ name: ServiceSecretNameSchema, value: z.string().max(4096).nullable() })
  .refine((value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 3000);
export const ServiceSecretRevealSchema = z.strictObject({ value: z.string().max(4096) });
export const ServiceConfigApplyIssueSchema = z.strictObject({
  step: z.enum(['gateway-config', 'audit', 'thought-store', 'error-diagnostics', 'runtime-status']),
  fields: z.array(z.string().max(128)).max(64),
  reason: z.literal('runtime-application-failed'),
  diagnosticId: z.string().uuid(),
});
export type ServiceConfigApplyIssue = z.infer<typeof ServiceConfigApplyIssueSchema>;
export const ServiceConfigWriteResultSchema = z.strictObject({
  state: z.enum(['applied', 'restart-required', 'partial-failure']),
  snapshot: ServiceConfigSnapshotSchema,
  issues: z.array(ServiceConfigApplyIssueSchema).max(8).optional(),
  restartFields: z.array(z.string().max(128)).max(64).optional(),
});
export type ServiceConfigSnapshot = z.infer<typeof ServiceConfigSnapshotSchema>;
export type ServiceConfigUpdate = z.infer<typeof ServiceConfigUpdateSchema>;
export type ServiceSecretName = z.infer<typeof ServiceSecretNameSchema>;
export type ServiceSecretWrite = z.infer<typeof ServiceSecretWriteSchema>;
export type ServiceConfigWriteResult = z.infer<typeof ServiceConfigWriteResultSchema>;

const DesktopZoomSchema = z.literal(DESKTOP_ZOOM_LEVELS);

export const DesktopPreferencesSchema = AppConfigSchema.omit({
  error_diagnostics: true,
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
    language: z.string().max(32).overwrite(normalizeDesktopLanguage),
    zoom_percent: DesktopZoomSchema.default(DEFAULT_DESKTOP_ZOOM),
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
  zoom_percent: DesktopZoomSchema,
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

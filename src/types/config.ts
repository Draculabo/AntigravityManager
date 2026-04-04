import { z } from 'zod';

export const UpstreamProxyConfigSchema = z.object({
  enabled: z.boolean(),
  url: z.string(),
});

export const ProxyConfigSchema = z.object({
  enabled: z.boolean(),
  port: z.number(),
  api_key: z.string(),
  auto_start: z.boolean(),
  backend_canary_enabled: z.boolean().default(true),
  parity_enabled: z.boolean().default(false),
  parity_shadow_enabled: z.boolean().default(false),
  parity_kill_switch: z.boolean().default(false),
  parity_no_go_mismatch_rate: z.number().default(0.15),
  parity_no_go_error_rate: z.number().default(0.4),
  scheduling_mode: z.enum(['cache-first', 'balance', 'performance-first']).default('balance'),
  max_wait_seconds: z.number().default(60),
  preferred_account_id: z.string().default(''),
  circuit_breaker_enabled: z.boolean().default(true),
  circuit_breaker_backoff_steps: z.array(z.number()).default([60, 300, 1800, 7200]),
  custom_mapping: z.record(z.string(), z.string()).default({}),
  anthropic_mapping: z.record(z.string(), z.string()), // Mapping table
  request_timeout: z.number().default(120), // Timeout in seconds
  upstream_proxy: UpstreamProxyConfigSchema,
});

export const AppConfigSchema = z.object({
  language: z.string(),
  theme: z.string(),
  auto_refresh: z.boolean(),
  refresh_interval: z.number(), // minutes
  auto_sync: z.boolean(),
  sync_interval: z.number(), // minutes
  auto_startup: z.boolean(),
  error_reporting_enabled: z.boolean(),
  privacy_consent_asked: z.boolean().optional().default(false), // Optional for backward compatibility
  default_export_path: z.string().nullable().optional(), // Export path
  model_visibility: z.record(z.string(), z.boolean()).default({}), // Model visibility preferences
  provider_groupings_enabled: z.boolean().default(false), // Enable provider groupings UI
  grid_layout: z.enum(['auto', '2-col', '3-col', 'list', 'compact']).default('auto'), // Account card grid layout
  account_sort: z
    .enum(['recently-used', 'quota-overall', 'quota-claude', 'quota-pro3', 'quota-flash'])
    .default('recently-used'),
  quota_alert_enabled: z.boolean().default(false),
  quota_alert_threshold: z.number().default(20),
  proxy: ProxyConfigSchema,
});

export type UpstreamProxyConfig = z.infer<typeof UpstreamProxyConfigSchema>;
export type ProxyConfig = z.infer<typeof ProxyConfigSchema>;
export type AppConfig = z.infer<typeof AppConfigSchema>;

export const DEFAULT_APP_CONFIG: AppConfig = {
  language: 'zh-CN',
  theme: 'dark',
  auto_refresh: false,
  refresh_interval: 15,
  auto_sync: false,
  sync_interval: 5,
  auto_startup: false,
  error_reporting_enabled: true, // Default to disabled for privacy
  privacy_consent_asked: false, // Whether the user has been asked for consent
  default_export_path: null,
  model_visibility: {}, // Model visibility preferences
  provider_groupings_enabled: false, // Enable provider groupings UI
  grid_layout: 'auto' as const, // Account card grid layout
  account_sort: 'recently-used' as const,
  quota_alert_enabled: false,
  quota_alert_threshold: 20,
  proxy: {
    enabled: false,
    port: 8045,
    api_key: '', // Generated dynamically if default needed
    auto_start: false,
    backend_canary_enabled: true,
    parity_enabled: false,
    parity_shadow_enabled: false,
    parity_kill_switch: false,
    parity_no_go_mismatch_rate: 0.15,
    parity_no_go_error_rate: 0.4,
    scheduling_mode: 'balance',
    max_wait_seconds: 60,
    preferred_account_id: '',
    circuit_breaker_enabled: true,
    circuit_breaker_backoff_steps: [60, 300, 1800, 7200],
    custom_mapping: {},
    anthropic_mapping: {},
    request_timeout: 120,
    upstream_proxy: {
      enabled: false,
      url: '',
    },
  },
};

import { z } from 'zod';

export const UpstreamProxyConfigSchema = z.object({
  enabled: z.boolean(),
  url: z.string(),
});

export const ProxyConfigSchema = z.object({
  enabled: z.boolean(), // 是否启用
  port: z.number(), // 监听端口
  api_key: z.string(), // API 密钥 (Also used for Admin Mode auth)
  auto_start: z.boolean(), // 是否自动启动
  anthropic_mapping: z.record(z.string(), z.string()), // 映射表
  request_timeout: z.number().default(120), // 超时秒数
  upstream_proxy: UpstreamProxyConfigSchema,
});

export const NotificationConfigSchema = z.object({
  enabled: z.boolean(),
  quota_warning_threshold: z.number().min(5).max(50), // Percentage to trigger warning
  quota_switch_threshold: z.number().min(1).max(20), // Percentage to trigger auto-switch
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
  default_export_path: z.string().nullable().optional(), // 导出路径
  notifications: NotificationConfigSchema,
  proxy: ProxyConfigSchema,
});

export type UpstreamProxyConfig = z.infer<typeof UpstreamProxyConfigSchema>;
export type ProxyConfig = z.infer<typeof ProxyConfigSchema>;
export type NotificationConfig = z.infer<typeof NotificationConfigSchema>;
export type AppConfig = z.infer<typeof AppConfigSchema>;

export const DEFAULT_APP_CONFIG: AppConfig = {
  language: 'zh-CN',
  theme: 'system',
  auto_refresh: false,
  refresh_interval: 15,
  auto_sync: false,
  sync_interval: 5,
  auto_startup: false,
  error_reporting_enabled: true, // Default to disabled for privacy
  privacy_consent_asked: false, // Whether the user has been asked for consent
  default_export_path: null,
  notifications: {
    enabled: true,
    quota_warning_threshold: 20, // Warn when quota < 20%
    quota_switch_threshold: 5, // Auto-switch when quota < 5%
  },
  proxy: {
    enabled: false,
    port: 8045,
    api_key: '', // Generated dynamically if default needed
    auto_start: false,
    anthropic_mapping: {},
    request_timeout: 120,
    upstream_proxy: {
      enabled: false,
      url: '',
    },
  },
};

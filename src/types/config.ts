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

export const AppConfigSchema = z.object({
  language: z.string(),
  theme: z.string(),
  auto_refresh: z.boolean(),
  refresh_interval: z.number(), // minutes
  auto_sync: z.boolean(), // 是否自动同步
  sync_interval: z.number(), // minutes
  auto_startup: z.boolean(), // 是否随系统启动
  default_export_path: z.string().nullable().optional(), // 导出路径
  proxy: ProxyConfigSchema,
});

export type UpstreamProxyConfig = z.infer<typeof UpstreamProxyConfigSchema>;
export type ProxyConfig = z.infer<typeof ProxyConfigSchema>;
export type AppConfig = z.infer<typeof AppConfigSchema>;

export const DEFAULT_APP_CONFIG: AppConfig = {
  language: 'zh-CN',
  theme: 'system',
  auto_refresh: false,
  refresh_interval: 15,
  auto_sync: false,
  sync_interval: 5,
  auto_startup: false,
  default_export_path: null,
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

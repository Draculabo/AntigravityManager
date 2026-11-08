import path from 'path';
import fs from 'fs';
import { randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import { AppConfig, AppConfigSchema, DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { migrateLegacyModelAliases } from '@/modules/config/model-aliases';
import { getAgentDir } from '@/shared/platform/paths';
import { logger } from '@/shared/logging/logger';
import { writeFileAtomic, writeFileAtomicSync } from '@/shared/persistence/atomic-json-file';
import { backupAuditWindowMigration } from './audit-window-migration';
import { backupThoughtWindowMigration, migratedThoughtTurnLimit } from './thought-window-migration';

const CONFIG_FILENAME = 'gui_config.json';
// The complete public contract includes 128 executable arguments of 4096 characters,
// 1024 model-visibility keys, 256 aliases and two 256-entry legacy maps. Allow six-byte
// JSON escaping and pretty-print overhead across all groups, not one 128-KiB patch.
const MAX_CONFIG_BYTES = 16 * 1024 * 1024;

export type ConfigLoadFailureCode = 'invalid-json' | 'invalid-config' | 'too-large' | 'unreadable';

export class ConfigLoadError extends Error {
  constructor(
    readonly code: ConfigLoadFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ConfigLoadError';
  }
}

export class ConfigManager {
  private static cachedConfig: AppConfig | null = null;
  private static saveQueue: Promise<void> = Promise.resolve();
  private static initialization: {
    source: 'missing' | 'blank';
    writeback: 'saved' | 'failed';
    diagnosticId?: string;
  } | undefined;

  static getInitializationState() {
    return this.initialization ? { ...this.initialization } : undefined;
  }

  private static initializeDefaults(configPath: string, source: 'missing' | 'blank'): AppConfig {
    const defaults = AppConfigSchema.parse(DEFAULT_APP_CONFIG);
    try {
      writeFileAtomicSync(configPath, JSON.stringify(defaults, null, 2));
      this.initialization = { source, writeback: 'saved' };
    } catch (cause) {
      const diagnosticId = randomUUID();
      this.initialization = { source, writeback: 'failed', diagnosticId };
      logger.error('Configuration defaults are in memory; initialization writeback failed.', { diagnosticId }, cause);
    }
    this.cachedConfig = defaults;
    return defaults;
  }

  private static getConfigPath(): string {
    const managerDataDir = getAgentDir();
    if (!fs.existsSync(managerDataDir)) {
      fs.mkdirSync(managerDataDir, { recursive: true });
    }
    return path.join(managerDataDir, CONFIG_FILENAME);
  }

  static loadConfig(_strict = false): AppConfig {
    try {
      const configPath = this.getConfigPath();
      let fd: number;
      try {
        fd = fs.openSync(configPath, 'r');
      } catch (cause) {
        if (!(cause instanceof Error && 'code' in cause && cause.code === 'ENOENT')) {
          throw cause;
        }
        return this.initializeDefaults(configPath, 'missing');
      }
      let content: string;
      try {
        const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
        let bytes = 0;
        while (bytes < buffer.length) {
          const count = fs.readSync(fd, buffer, bytes, buffer.length - bytes, null);
          if (count === 0) {
            break;
          }
          bytes += count;
        }
        if (bytes > MAX_CONFIG_BYTES) {
          throw new ConfigLoadError('too-large', 'Configuration exceeds the size limit.');
        }
        content = buffer.subarray(0, bytes).toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
      if (content.trim() === '') {
        return this.initializeDefaults(configPath, 'blank');
      }
      const raw = JSON.parse(content);
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new ConfigLoadError('invalid-config', 'Configuration must be an object.');
      }
      if (
        raw.proxy !== undefined &&
        (typeof raw.proxy !== 'object' || raw.proxy === null || Array.isArray(raw.proxy))
      ) {
        throw new ConfigLoadError('invalid-config', 'Proxy configuration must be an object.');
      }
      for (const key of ['upstream_proxy', 'experimental', 'thinking_budget', 'cowork_compaction', 'network']) {
        const value = raw.proxy?.[key];
        if (value !== undefined && (typeof value !== 'object' || value === null || Array.isArray(value))) {
          throw new ConfigLoadError('invalid-config', `Proxy configuration ${key} must be an object.`);
        }
      }

      // Merge with default to ensure new fields are present
      // Zod parse helps validate
      const merged = {
        ...DEFAULT_APP_CONFIG,
        ...raw,
        proxy: { ...DEFAULT_APP_CONFIG.proxy, ...(raw.proxy || {}) },
      };

      // Fix deep merge for upstream_proxy if needed
      if (raw.proxy && raw.proxy.upstream_proxy) {
        merged.proxy.upstream_proxy = {
          ...DEFAULT_APP_CONFIG.proxy.upstream_proxy,
          ...raw.proxy.upstream_proxy,
        };
      }

      if (raw.proxy && raw.proxy.experimental) {
        merged.proxy.experimental = {
          ...DEFAULT_APP_CONFIG.proxy.experimental,
          ...raw.proxy.experimental,
        };
      }

      if (raw.proxy && raw.proxy.thinking_budget) {
        merged.proxy.thinking_budget = {
          ...DEFAULT_APP_CONFIG.proxy.thinking_budget,
          ...raw.proxy.thinking_budget,
        };
      }

      if (raw.proxy && raw.proxy.cowork_compaction) {
        merged.proxy.cowork_compaction = {
          ...DEFAULT_APP_CONFIG.proxy.cowork_compaction,
          ...raw.proxy.cowork_compaction,
        };
      }

      if (raw.proxy && raw.proxy.network) {
        merged.proxy.network = {
          ...DEFAULT_APP_CONFIG.proxy.network,
          ...raw.proxy.network,
        };
      }

      // Handle Anthropic Mapping Map vs Object
      // In JSON it's object

      // The two legacy mapping objects become alias routes here, so everything downstream of a
      // load reads one list. The file itself is only rewritten on the next save.
      merged.proxy = migrateLegacyModelAliases(merged.proxy);
      const migratedTurns = migratedThoughtTurnLimit(raw);
      if (migratedTurns !== undefined) {
        merged.proxy.thought_store = {
          ...merged.proxy.thought_store,
          max_turns_per_session: migratedTurns,
        };
        logger.warn(
          'Thought Store cache limit below ten was raised to ten; the original configuration is backed up before saving.',
        );
      }
      const validated = AppConfigSchema.parse(merged);

      this.cachedConfig = validated;
      return validated;
    } catch (cause) {
      this.cachedConfig = null;
      logger.error('Configuration could not be loaded; the existing file is preserved.', cause);
      if (cause instanceof ConfigLoadError) {
        throw cause;
      }
      if (cause instanceof SyntaxError) {
        throw new ConfigLoadError('invalid-json', 'Configuration JSON is invalid.', { cause });
      }
      if (cause instanceof ZodError) {
        throw new ConfigLoadError('invalid-config', 'Configuration fields are invalid.', { cause });
      }
      throw new ConfigLoadError('unreadable', 'Configuration could not be loaded.', { cause });
    }
  }

  static getCachedConfig(): AppConfig | null {
    return this.cachedConfig;
  }

  /**
   * Copies the configuration aside once, before the first write that introduces `model_aliases`.
   *
   * The migration itself is reversible -- the legacy maps stay populated as a projection -- but a
   * one-time snapshot is what makes that claim testable rather than asserted, and it costs one
   * file the first time only.
   */
  private static async backupBeforeMigration(configPath: string): Promise<void> {
    const backupPath = `${configPath}.pre-alias-migration.bak`;

    if (!fs.existsSync(configPath)) {
      return;
    }

    const existing = await fs.promises.readFile(configPath, 'utf-8');
    if (!existing.trim()) {
      return;
    }
    const previous: unknown = JSON.parse(existing);
    const legacy = z.object({
      proxy: z.object({ model_aliases: z.unknown().optional() }).passthrough().optional(),
    }).passthrough();
    const parsed = legacy.safeParse(previous);
    if (parsed.success && (!parsed.data.proxy || !Object.hasOwn(parsed.data.proxy, 'model_aliases'))) {
      if (fs.existsSync(backupPath)) {
        const backup: unknown = JSON.parse(await fs.promises.readFile(backupPath, 'utf8'));
        if (!legacy.safeParse(backup).success) {
          throw new Error('Model alias migration backup is invalid.');
        }
        return;
      }
      await writeFileAtomic(backupPath, existing);
      logger.info(`Config: Wrote pre-migration backup to ${backupPath}`);
    }
  }

  static async saveConfig(config: AppConfig): Promise<void> {
    const configPath = this.getConfigPath();
    const migratedConfig: AppConfig = AppConfigSchema.parse({
      ...config,
      proxy: migrateLegacyModelAliases(config.proxy),
    });
    const content = JSON.stringify(migratedConfig, null, 2);
    if (Buffer.byteLength(content, 'utf8') > MAX_CONFIG_BYTES) {
      throw new Error('Configuration exceeds the size limit.');
    }

    this.saveQueue = this.saveQueue
      .catch(() => undefined)
      .then(async () => {
        // Never replace a file that cannot be read and validated by the current owner.
        this.loadConfig();
        await backupAuditWindowMigration(configPath);
        await backupThoughtWindowMigration(configPath);
        await this.backupBeforeMigration(configPath);

        await writeFileAtomic(configPath, content);
        this.cachedConfig = migratedConfig;
        if (this.initialization) {
          this.initialization = { source: this.initialization.source, writeback: 'saved' };
        }
        logger.info(`Config: Saved to ${configPath}`);
      })
      .catch((cause) => {
        logger.error('Config: Failed to save config', cause);
        throw new Error('Configuration could not be saved.', { cause });
      });

    return this.saveQueue;
  }
}

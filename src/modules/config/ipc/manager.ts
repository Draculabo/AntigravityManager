import path from 'path';
import fs from 'fs';
import { AppConfig, AppConfigSchema, DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { migrateLegacyModelAliases } from '@/modules/config/model-aliases';
import { getAgentDir } from '@/shared/platform/paths';
import { logger } from '@/shared/logging/logger';
import { writeFileAtomic } from '@/shared/persistence/atomic-json-file';
import { backupAuditWindowMigration } from './audit-window-migration';
import { backupThoughtWindowMigration, migratedThoughtTurnLimit } from './thought-window-migration';

const CONFIG_FILENAME = 'gui_config.json';

export type ConfigLoadFailureCode = 'invalid-json' | 'unreadable';

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

  private static getConfigPath(): string {
    const managerDataDir = getAgentDir();
    if (!fs.existsSync(managerDataDir)) {
      fs.mkdirSync(managerDataDir, { recursive: true });
    }
    return path.join(managerDataDir, CONFIG_FILENAME);
  }

  static loadConfig(strict = false): AppConfig {
    try {
      const configPath = this.getConfigPath();
      if (!fs.existsSync(configPath)) {
        logger.info(`Config: File not found at ${configPath}, returning default`);
        this.cachedConfig = DEFAULT_APP_CONFIG;
        return DEFAULT_APP_CONFIG;
      }

      const content = fs.readFileSync(configPath, 'utf-8');
      if (content.trim() === '') {
        this.cachedConfig = DEFAULT_APP_CONFIG;
        return DEFAULT_APP_CONFIG;
      }
      const raw = JSON.parse(content);

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
      if (strict) {
        if (cause instanceof SyntaxError) {
          throw new ConfigLoadError('invalid-json', 'Configuration JSON is invalid.', { cause });
        }
        throw new ConfigLoadError('unreadable', 'Configuration could not be loaded.', { cause });
      }
      logger.error('Config: Failed to load config');
      this.cachedConfig = DEFAULT_APP_CONFIG;
      return DEFAULT_APP_CONFIG;
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

    try {
      if (fs.existsSync(backupPath) || !fs.existsSync(configPath)) {
        return;
      }

      const existing = await fs.promises.readFile(configPath, 'utf-8');
      if (!existing.includes('"model_aliases"')) {
        await writeFileAtomic(backupPath, existing);
        logger.info(`Config: Wrote pre-migration backup to ${backupPath}`);
      }
    } catch (e) {
      // A missing backup must not stop the user from saving their settings.
      logger.warn('Config: Failed to write pre-migration backup', e);
    }
  }

  static async saveConfig(config: AppConfig): Promise<void> {
    const configPath = this.getConfigPath();
    const migratedConfig: AppConfig = AppConfigSchema.parse({
      ...config,
      proxy: migrateLegacyModelAliases(config.proxy),
    });
    const content = JSON.stringify(migratedConfig, null, 2);

    this.saveQueue = this.saveQueue
      .catch(() => undefined)
      .then(async () => {
        await backupAuditWindowMigration(configPath);
        await backupThoughtWindowMigration(configPath);
        await this.backupBeforeMigration(configPath);

        await writeFileAtomic(configPath, content);
        this.cachedConfig = migratedConfig;
        logger.info(`Config: Saved to ${configPath}`);
      })
      .catch((cause) => {
        logger.error('Config: Failed to save config');
        throw new Error('Configuration could not be saved.', { cause });
      });

    return this.saveQueue;
  }
}

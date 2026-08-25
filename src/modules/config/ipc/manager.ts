import path from 'path';
import fs from 'fs';
import { AppConfig, DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { migrateLegacyModelAliases } from '@/modules/config/model-aliases';
import { getAgentDir } from '@/shared/platform/paths';
import { logger } from '@/shared/logging/logger';

const CONFIG_FILENAME = 'gui_config.json';

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

  static loadConfig(): AppConfig {
    try {
      const configPath = this.getConfigPath();
      if (!fs.existsSync(configPath)) {
        logger.info(`Config: File not found at ${configPath}, returning default`);
        this.cachedConfig = DEFAULT_APP_CONFIG;
        return DEFAULT_APP_CONFIG;
      }

      const content = fs.readFileSync(configPath, 'utf-8');
      const raw = JSON.parse(content);

      // Merge with default to ensure new fields are present
      // Zod parse helps validate
      const merged: AppConfig = {
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

      // Handle Anthropic Mapping Map vs Object
      // In JSON it's object

      // The two legacy mapping objects become alias routes here, so everything downstream of a
      // load reads one list. The file itself is only rewritten on the next save.
      merged.proxy = migrateLegacyModelAliases(merged.proxy);

      this.cachedConfig = merged;
      return merged;
    } catch (e) {
      logger.error('Config: Failed to load config', e);
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
        await fs.promises.writeFile(backupPath, existing, 'utf-8');
        logger.info(`Config: Wrote pre-migration backup to ${backupPath}`);
      }
    } catch (e) {
      // A missing backup must not stop the user from saving their settings.
      logger.warn('Config: Failed to write pre-migration backup', e);
    }
  }

  static async saveConfig(config: AppConfig): Promise<void> {
    const configPath = this.getConfigPath();
    const migratedConfig: AppConfig = {
      ...config,
      proxy: migrateLegacyModelAliases(config.proxy),
    };
    const content = JSON.stringify(migratedConfig, null, 2);

    this.saveQueue = this.saveQueue
      .catch(() => undefined)
      .then(async () => {
        await this.backupBeforeMigration(configPath);

        // Write-then-rename: a crash or a full disk mid-write leaves the previous configuration
        // intact instead of a truncated file the app cannot parse on next start.
        const tempPath = `${configPath}.tmp`;
        await fs.promises.writeFile(tempPath, content, 'utf-8');
        await fs.promises.rename(tempPath, configPath);
        this.cachedConfig = migratedConfig;
        logger.info(`Config: Saved to ${configPath}`);
      })
      .catch((e) => {
        logger.error('Config: Failed to save config', e);
        throw e;
      });

    return this.saveQueue;
  }
}

import path from 'path';
import fs from 'fs';
import { AppConfig, AppConfigSchema, DEFAULT_APP_CONFIG } from '../../types/config';
import { getAppDataDir } from '../../utils/paths';
import { logger } from '../../utils/logger';

const CONFIG_FILENAME = 'gui_config.json';

export class ConfigManager {
  private static cachedConfig: AppConfig | null = null;
  private static saveQueue: Promise<void> = Promise.resolve();

  private static getConfigPath(): string {
    const appDataDir = getAppDataDir();
    if (!fs.existsSync(appDataDir)) {
      fs.mkdirSync(appDataDir, { recursive: true });
    }
    return path.join(appDataDir, CONFIG_FILENAME);
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
        notifications: { ...DEFAULT_APP_CONFIG.notifications, ...(raw.notifications || {}) },
        proxy: { ...DEFAULT_APP_CONFIG.proxy, ...(raw.proxy || {}) },
      };

      // Fix deep merge for upstream_proxy if needed
      if (raw.proxy && raw.proxy.upstream_proxy) {
        merged.proxy.upstream_proxy = {
          ...DEFAULT_APP_CONFIG.proxy.upstream_proxy,
          ...raw.proxy.upstream_proxy,
        };
      }

      // Handle Anthropic Mapping Map vs Object
      // In JSON it's object

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

  static async saveConfig(config: AppConfig): Promise<void> {
    const configPath = this.getConfigPath();
    const content = JSON.stringify(config, null, 2);

    this.saveQueue = this.saveQueue
      .catch(() => undefined)
      .then(async () => {
        await fs.promises.writeFile(configPath, content, 'utf-8');
        this.cachedConfig = config;
        logger.info(`Config: Saved to ${configPath}`);
      })
      .catch((e) => {
        logger.error('Config: Failed to save config', e);
        throw e;
      });

    return this.saveQueue;
  }
}

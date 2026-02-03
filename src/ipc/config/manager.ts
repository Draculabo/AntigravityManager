import path from 'path';
import fs from 'fs';
import { merge } from 'lodash-es';
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

  /**
   * Synchronously load the configuration.
   * @deprecated Prefer `loadConfigAsync` for improved responsiveness.
   */
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

      // Validate the raw config against the schema
      const validationResult = AppConfigSchema.safeParse(raw);
      if (!validationResult.success) {
        logger.warn(
          'Config: Loaded config failed schema validation, using defaults for invalid fields',
          validationResult.error.issues,
        );
      }

      // Deep merge user config with defaults to handle nested objects
      const merged = merge({}, DEFAULT_APP_CONFIG, raw) as AppConfig;

      // Final validation to ensure merged config is valid
      const finalValidation = AppConfigSchema.safeParse(merged);
      if (!finalValidation.success) {
        logger.error(
          'Config: Merged config is still invalid, falling back to defaults',
          finalValidation.error.issues,
        );
        this.cachedConfig = DEFAULT_APP_CONFIG;
        return DEFAULT_APP_CONFIG;
      }

      this.cachedConfig = finalValidation.data;
      return finalValidation.data;
    } catch (e) {
      logger.error('Config: Failed to load config', e);
      this.cachedConfig = DEFAULT_APP_CONFIG;
      return DEFAULT_APP_CONFIG;
    }
  }

  /**
   * Asynchronously load the configuration.
   * Recommended for non-blocking UI operations.
   */
  static async loadConfigAsync(): Promise<AppConfig> {
    try {
      const configPath = this.getConfigPath();
      if (!fs.existsSync(configPath)) {
        this.cachedConfig = DEFAULT_APP_CONFIG;
        return DEFAULT_APP_CONFIG;
      }

      const content = await fs.promises.readFile(configPath, 'utf-8');
      const raw = JSON.parse(content);
      const merged = merge({}, DEFAULT_APP_CONFIG, raw) as AppConfig;
      const finalValidation = AppConfigSchema.safeParse(merged);

      if (!finalValidation.success) {
        this.cachedConfig = DEFAULT_APP_CONFIG;
        return DEFAULT_APP_CONFIG;
      }

      this.cachedConfig = finalValidation.data;
      return finalValidation.data;
    } catch (e) {
      logger.error('Config: Failed to load config async', e);
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

import { AppConfig } from '../../types/config';
import { ConfigManager } from './manager';
import { syncAutoStart } from '../../utils/autoStart';

export function loadConfig(): AppConfig {
  return ConfigManager.loadConfig();
}

export function saveConfig(config: AppConfig): void {
  // Logic to notify proxy server if configuration changes (hot update)
  // Logic to update Tray if language changes
  // For now just save
  ConfigManager.saveConfig(config);
  syncAutoStart(config);
}

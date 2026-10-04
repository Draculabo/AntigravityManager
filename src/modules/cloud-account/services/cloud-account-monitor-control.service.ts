import { z } from 'zod';
import { CloudAccountSettingsStore } from '../persistence/cloud-account-settings-store';
import { AutoSwitchModelsConfigSchema, type AutoSwitchModelConfig } from '../types';
import { CloudMonitorService } from './CloudMonitorService';
import { WeeklyWarmupService } from './WeeklyWarmupService';
import type { WeeklyWarmupConfig } from './weekly-warmup-contract';

export const cloudAccountMonitorControl = {
  getAutoSwitchEnabled: () =>
    CloudAccountSettingsStore.getSetting('auto_switch_enabled', false, z.boolean()),
  setAutoSwitchEnabled: async (enabled: boolean) => {
    CloudAccountSettingsStore.setSetting('auto_switch_enabled', enabled);
    CloudMonitorService.syncSchedule();
  },
  getAutoSwitchModelsConfig: () =>
    CloudAccountSettingsStore.getSetting('auto_switch_models', {}, AutoSwitchModelsConfigSchema),
  setAutoSwitchModelsConfig: async (config: Record<string, AutoSwitchModelConfig>) => {
    CloudAccountSettingsStore.setSetting('auto_switch_models', config);
  },
  forcePoll: () => CloudMonitorService.poll(),
  getWeeklyWarmupConfig: () => WeeklyWarmupService.getConfig(),
  setWeeklyWarmupConfig: async (config: WeeklyWarmupConfig) => {
    WeeklyWarmupService.setConfig(config);
    CloudMonitorService.syncSchedule();
  },
};

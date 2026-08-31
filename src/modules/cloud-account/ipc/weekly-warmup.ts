import { WeeklyWarmupService } from '../services/WeeklyWarmupService';
import type { WeeklyWarmupConfig } from '../services/weekly-warmup-contract';
import { CloudMonitorService } from '../services/CloudMonitorService';

export function getWeeklyWarmupConfig(): WeeklyWarmupConfig {
  return WeeklyWarmupService.getConfig();
}

export function setWeeklyWarmupConfig(config: WeeklyWarmupConfig): void {
  WeeklyWarmupService.setConfig(config);
  CloudMonitorService.syncSchedule();
}

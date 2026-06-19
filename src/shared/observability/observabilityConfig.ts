import path from 'path';
import fs from 'fs';

import { getAgentDir } from '@/shared/platform/paths';

export interface ObservabilityConfig {
  errorReportingEnabled: boolean;
  telemetryEnabled: boolean;
}

export function getQuickObservabilityConfig(
  reportError?: (message: string, error: unknown) => void,
): ObservabilityConfig {
  try {
    const configPath = path.join(getAgentDir(), 'gui_config.json');
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(content);

      return {
        errorReportingEnabled: config.error_reporting_enabled !== false,
        telemetryEnabled: config.telemetry_enabled !== false,
      };
    }
  } catch (error) {
    reportError?.('Failed to read config for observability init:', error);
  }

  return {
    errorReportingEnabled: true,
    telemetryEnabled: true,
  };
}

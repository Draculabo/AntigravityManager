import path from 'path';
import fs from 'fs';
import { z } from 'zod';

import { getAgentDir } from '@/shared/platform/paths';

export interface ObservabilityConfig {
  errorReportingEnabled: boolean;
  telemetryEnabled: boolean;
}

export function getQuickObservabilityConfig(
  reportError?: (message: string, error: unknown) => void,
  desktopPreferencesPath?: string,
): ObservabilityConfig {
  try {
    const desktop = Boolean(desktopPreferencesPath && fs.existsSync(desktopPreferencesPath));
    const configPath =
      desktop && desktopPreferencesPath
        ? desktopPreferencesPath
        : path.join(getAgentDir(), 'gui_config.json');
    if (fs.existsSync(configPath)) {
      if (fs.statSync(configPath).size > (desktop ? 128 * 1024 : 1024 * 1024)) {
        throw new Error('Observability preferences are too large.');
      }
      const content = fs.readFileSync(configPath, 'utf-8');
      const raw: unknown = JSON.parse(content);
      const value = desktop ? z.object({ preferences: z.unknown() }).parse(raw).preferences : raw;
      const config = z
        .object({
          error_reporting_enabled: z.boolean().optional(),
          telemetry_enabled: z.boolean().optional(),
        })
        .parse(value);

      return {
        errorReportingEnabled: config.error_reporting_enabled !== false,
        telemetryEnabled: config.telemetry_enabled !== false,
      };
    }
  } catch {
    reportError?.(
      'Failed to read observability preferences.',
      new Error('Invalid observability preferences.'),
    );
    return { errorReportingEnabled: false, telemetryEnabled: false };
  }

  return {
    errorReportingEnabled: true,
    telemetryEnabled: true,
  };
}

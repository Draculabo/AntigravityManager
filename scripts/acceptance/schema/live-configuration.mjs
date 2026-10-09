import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadEnv } from 'vite';
import { z } from 'zod';

/** Resolve existing live-test settings in memory without persisting credentials or preferences. */
export function readLiveConfiguration(root) {
  const config = z
    .object({
      proxy: z.object({ port: z.number().int().positive(), api_key: z.string().optional() }),
    })
    .parse(
      JSON.parse(
        fs.readFileSync(path.join(os.homedir(), '.antigravity-agent/gui_config.json'), 'utf8'),
      ),
    );
  const development = loadEnv('development', root, '');
  const production = loadEnv('production', root, '');
  const reporting = Object.fromEntries(
    ['SENTRY_DSN', 'SENTRY_AUTH_TOKEN', 'SENTRY_ORG', 'SENTRY_PROJECT', 'SENTRY_BASE_URL'].map(
      (key) => [key, process.env[key] || development[key] || production[key] || ''],
    ),
  );
  const preferencePath = path.join(
    process.env.APPDATA,
    'Antigravity Manager/desktop-preferences.json',
  );
  const preferences = z
    .object({ preferences: z.object({ error_reporting_enabled: z.boolean() }) })
    .parse(JSON.parse(fs.readFileSync(preferencePath, 'utf8')));
  return { config, reporting, preferences, preferencePath };
}

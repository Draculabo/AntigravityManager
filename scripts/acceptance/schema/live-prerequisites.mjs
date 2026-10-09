import fs from 'node:fs';
import path from 'node:path';
import { loadEnv } from 'vite';
import { z } from 'zod';

const names = [
  'SENTRY_DSN',
  'SENTRY_AUTH_TOKEN',
  'SENTRY_ORG',
  'SENTRY_PROJECT',
  'SENTRY_BASE_URL',
];
const development = loadEnv('development', process.cwd(), '');
const production = loadEnv('production', process.cwd(), '');
const sources = [process.env, development, production].map((source) =>
  Object.fromEntries(names.map((name) => [name, Boolean(source[name])])),
);
const Config = z.object({
  proxy: z.object({
    port: z.number().int(),
    api_key: z.string().optional(),
    auto_start: z.boolean().optional(),
  }),
  error_reporting_enabled: z.boolean().optional(),
});
const prefs = [];
for (const name of ['antigravity-manager', 'Antigravity Manager', 'Antigravity Manager Dev']) {
  const file = path.join(process.env.APPDATA, name, 'desktop-preferences.json');
  if (!fs.existsSync(file)) {
    continue;
  }
  try {
    const preferences = z
      .object({
        preferences: z.object({
          error_reporting_enabled: z.boolean(),
          owner_mode: z.string().optional(),
        }),
      })
      .parse(JSON.parse(fs.readFileSync(file, 'utf8')));
    prefs.push({
      app: name,
      enabled: preferences.preferences.error_reporting_enabled,
      ownerMode: preferences.preferences.owner_mode,
    });
  } catch {
    prefs.push({ app: name, valid: false });
  }
}
try {
  const config = Config.parse(
    JSON.parse(
      fs.readFileSync(
        path.join(process.env.USERPROFILE, '.antigravity-agent/gui_config.json'),
        'utf8',
      ),
    ),
  );
  let gateway;
  try {
    const response = await fetch(`http://127.0.0.1:${config.proxy.port}/v1/models`, {
      headers: config.proxy.api_key ? { authorization: `Bearer ${config.proxy.api_key}` } : {},
      signal: AbortSignal.timeout(2000),
    });
    gateway = { reachable: true, status: response.status };
  } catch {
    gateway = { reachable: false };
  }
  console.log(
    JSON.stringify({
      sentrySources: sources,
      preferences: prefs,
      gateway,
      autoStart: config.proxy.auto_start,
      legacyReportingEnabled: config.error_reporting_enabled,
    }),
  );
} catch {
  console.log(
    JSON.stringify({ sentrySources: sources, preferences: prefs, configAvailable: false }),
  );
}

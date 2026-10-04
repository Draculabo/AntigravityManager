import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { z } from 'zod';
import {
  DesktopPreferencesSchema,
  DesktopPreferencesUpdateSchema,
  type DesktopPreferences,
  type DesktopPreferencesUpdate,
} from '../service-config.schema';
import { DEFAULT_APP_CONFIG } from '../types';
import { getAgentDir } from '@/shared/platform/paths';
import { writeFileAtomic } from '@/shared/persistence/atomic-json-file';

const StoredPreferencesSchema = z.strictObject({
  version: z.literal(1),
  preferences: DesktopPreferencesSchema,
});
const defaults = () => DesktopPreferencesSchema.strip().parse(DEFAULT_APP_CONFIG);

/** The file's existence is the one-time seed marker. Corrupt files fail closed; they are never reseeded. */
export function createDesktopPreferencesStore(filePath: () => string, legacyPath: () => string) {
  let queue: Promise<unknown> = Promise.resolve();
  function read(): DesktopPreferences {
    const target = filePath();
    if (fs.existsSync(target)) {
      if (fs.statSync(target).size > 128 * 1024) {
        throw new Error('Desktop preferences are invalid.');
      }
      try {
        return StoredPreferencesSchema.parse(JSON.parse(fs.readFileSync(target, 'utf8')))
          .preferences;
      } catch {
        throw new Error('Desktop preferences are invalid.');
      }
    }
    const legacy = legacyPath();
    if (!fs.existsSync(legacy)) {
      return defaults();
    }
    if (fs.statSync(legacy).size > 1024 * 1024) {
      throw new Error('Legacy preferences are invalid.');
    }
    try {
      const seed: unknown = JSON.parse(fs.readFileSync(legacy, 'utf8'));
      // Ownership activation must come from desktop-local preferences, never shared legacy config.
      const known = DesktopPreferencesSchema.omit({ owner_mode: true })
        .partial()
        .strip()
        .parse(seed);
      return DesktopPreferencesSchema.parse({ ...defaults(), ...known });
    } catch {
      throw new Error('Legacy preferences are invalid.');
    }
  }
  async function save(preferences: DesktopPreferences): Promise<DesktopPreferences> {
    const accepted = DesktopPreferencesSchema.parse(preferences);
    const content = JSON.stringify({ version: 1, preferences: accepted }, null, 2);
    if (Buffer.byteLength(content) > 128 * 1024) {
      throw new Error('Desktop preferences are too large.');
    }
    await writeFileAtomic(filePath(), content);
    return accepted;
  }
  function serialized<T>(work: () => Promise<T>): Promise<T> {
    const task = queue.catch(() => undefined).then(work);
    queue = task;
    return task;
  }
  return {
    load: () =>
      serialized(async () => {
        const preferences = read();
        if (!fs.existsSync(filePath())) {
          await save(preferences);
        }
        return preferences;
      }),
    save: (input: DesktopPreferencesUpdate) =>
      serialized(() => save({ ...read(), ...DesktopPreferencesUpdateSchema.parse(input) })),
  };
}

const store = createDesktopPreferencesStore(
  () => path.join(app.getPath('userData'), 'desktop-preferences.json'),
  () => path.join(getAgentDir(), 'gui_config.json'),
);
let current: DesktopPreferences | undefined;
export const desktopPreferencesStore = {
  load: async () => {
    current = await store.load();
    return current;
  },
  save: async (input: DesktopPreferencesUpdate) => {
    current = await store.save(input);
    return current;
  },
};
export function getDesktopPreferencesLanguage(fallback: string): string {
  return current?.language ?? fallback;
}

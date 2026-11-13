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
import { logger } from '@/shared/logging/logger';
import { DEFAULT_DESKTOP_ZOOM, normalizeDesktopLanguage, type DesktopZoom } from '@/modules/app-shell/desktop-appearance';

const StoredPreferencesSchema = z.strictObject({
  version: z.literal(1),
  preferences: DesktopPreferencesSchema,
});
const defaults = () => DesktopPreferencesSchema.strip().parse(DEFAULT_APP_CONFIG);

/** The file's existence is the one-time seed marker. Corrupt files fail closed; they are never reseeded. */
export function createDesktopPreferencesStore(filePath: () => string, legacyPath: () => string) {
  let queue: Promise<unknown> = Promise.resolve();
  let accepting = true;
  let pending = 0;
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
    try {
      if (fs.statSync(legacy).size > 1024 * 1024) {
        throw new Error('Legacy preferences exceed the seed limit.');
      }
      const seed: unknown = JSON.parse(fs.readFileSync(legacy, 'utf8'));
      // Ownership activation must come from desktop-local preferences, never shared legacy config.
      const known = DesktopPreferencesSchema.omit({ owner_mode: true })
        .partial()
        .strip()
        .parse(seed);
      return DesktopPreferencesSchema.parse({ ...defaults(), ...known });
    } catch (error) {
      logger.warn('Legacy configuration cannot seed desktop preferences; independent desktop defaults are used.', error);
      return defaults();
    }
  }
  async function save(preferences: DesktopPreferences): Promise<DesktopPreferences> {
    const accepted = DesktopPreferencesSchema.parse(preferences);
    const { zoom_percent, ...previousFormat } = accepted;
    // Keep the default profile readable by releases that reject unknown preference fields.
    const stored = zoom_percent === DEFAULT_DESKTOP_ZOOM ? previousFormat : accepted;
    const content = JSON.stringify({ version: 1, preferences: stored }, null, 2);
    if (Buffer.byteLength(content) > 128 * 1024) {
      throw new Error('Desktop preferences are too large.');
    }
    await writeFileAtomic(filePath(), content);
    return accepted;
  }
  function serialized<T>(work: () => Promise<T>): Promise<T> {
    if (!accepting || pending >= 32) {
      return Promise.reject(new Error('Desktop settings are shutting down or the save queue is full.'));
    }
    pending += 1;
    const task = queue.catch(() => undefined).then(work).finally(() => {
      pending -= 1;
    });
    queue = task;
    return task;
  }
  return {
    closeAdmission: () => {
      accepting = false;
    },
    drain: async () => {
      await queue.catch(() => undefined);
    },
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
  closeAdmission: store.closeAdmission,
  drain: store.drain,
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
  return normalizeDesktopLanguage(current?.language ?? fallback);
}

export function getDesktopPreferencesZoom(): DesktopZoom {
  return current?.zoom_percent ?? DEFAULT_DESKTOP_ZOOM;
}

import { v4 as uuidv4 } from 'uuid';
import { eq } from 'drizzle-orm';
import type { DeviceProfile, DeviceProfileVersion } from '@/modules/identity-profile/types';
import { logger } from '@/shared/logging/logger';
import { accounts } from '@/shared/persistence/database/schema';
import { getCloudDb } from './cloud-account-db';
import { writeAccount, type CloudAccountWriteGuard } from './cloudHandler';
import {
  areDeviceProfilesEqual,
  parseDeviceHistoryColumn,
  parseDeviceProfileColumn,
  serializeDeviceHistory,
  serializeDeviceProfile,
} from './cloud-account-device-profile-codec';

export class CloudAccountDeviceBindingStore {
  static setDeviceBinding(
    id: string,
    profile: DeviceProfile,
    label: string,
    guard: CloudAccountWriteGuard,
  ): void {
    writeAccount(id, guard, (transaction) => {
      const rows = transaction
        .select({
          deviceProfileJson: accounts.deviceProfileJson,
          deviceHistoryJson: accounts.deviceHistoryJson,
        })
        .from(accounts)
        .where(eq(accounts.id, id))
        .all();
      const row = rows[0];
      if (!row) {
        throw new Error(`Account not found: ${id}`);
      }

      const boundProfile = parseDeviceProfileColumn(row.deviceProfileJson);
      if (boundProfile && areDeviceProfilesEqual(boundProfile, profile)) {
        logger.info(
          `Skipping duplicate device profile binding for account ${id} (bound profile match)`,
        );
        return;
      }

      const historyRaw = parseDeviceHistoryColumn(row.deviceHistoryJson) || [];
      const currentVersion = historyRaw.find((version) => version.isCurrent);
      const latestVersion = historyRaw.length > 0 ? historyRaw[historyRaw.length - 1] : undefined;
      // History alone is not a committed binding; materialize its profile before reporting success.
      if (currentVersion && areDeviceProfilesEqual(currentVersion.profile, profile)) {
        logger.info(`Reusing current device profile history for account ${id}`);
        transaction
          .update(accounts)
          .set({ deviceProfileJson: serializeDeviceProfile(profile) })
          .where(eq(accounts.id, id))
          .run();
        return;
      }
      if (
        !currentVersion &&
        latestVersion &&
        areDeviceProfilesEqual(latestVersion.profile, profile)
      ) {
        logger.info(`Reusing latest device profile history for account ${id}`);
        transaction
          .update(accounts)
          .set({
            deviceProfileJson: serializeDeviceProfile(profile),
            deviceHistoryJson: serializeDeviceHistory(
              historyRaw.map((version) => ({
                ...version,
                isCurrent: version.id === latestVersion.id,
              })),
            ),
          })
          .where(eq(accounts.id, id))
          .run();
        return;
      }

      const history = historyRaw.map((version) => ({
        ...version,
        isCurrent: false,
      }));

      history.push({
        id: uuidv4(),
        createdAt: Math.floor(Date.now() / 1000),
        label,
        profile,
        isCurrent: true,
      });

      transaction
        .update(accounts)
        .set({
          deviceProfileJson: serializeDeviceProfile(profile),
          deviceHistoryJson: serializeDeviceHistory(history),
        })
        .where(eq(accounts.id, id))
        .run();
    });
  }

  static getDeviceBinding(id: string): {
    profile?: DeviceProfile;
    history: DeviceProfileVersion[];
  } {
    const { raw, orm } = getCloudDb();
    try {
      const rows = orm
        .select({
          deviceProfileJson: accounts.deviceProfileJson,
          deviceHistoryJson: accounts.deviceHistoryJson,
        })
        .from(accounts)
        .where(eq(accounts.id, id))
        .all();
      const row = rows[0];
      if (!row) {
        throw new Error(`Account not found: ${id}`);
      }

      return {
        profile: parseDeviceProfileColumn(row.deviceProfileJson),
        history: parseDeviceHistoryColumn(row.deviceHistoryJson) || [],
      };
    } finally {
      raw.close();
    }
  }

  static restoreDeviceVersion(
    id: string,
    versionId: string,
    baseline: DeviceProfile | null,
  ): DeviceProfile {
    const { raw, orm } = getCloudDb();
    try {
      const rows = orm
        .select({
          deviceProfileJson: accounts.deviceProfileJson,
          deviceHistoryJson: accounts.deviceHistoryJson,
        })
        .from(accounts)
        .where(eq(accounts.id, id))
        .all();
      const row = rows[0];
      if (!row) {
        throw new Error(`Account not found: ${id}`);
      }

      const currentProfile = parseDeviceProfileColumn(row.deviceProfileJson);
      const history = parseDeviceHistoryColumn(row.deviceHistoryJson) || [];

      let targetProfile: DeviceProfile;
      if (versionId === 'baseline') {
        if (!baseline) {
          throw new Error('Global original profile not found');
        }
        targetProfile = baseline;
      } else if (versionId === 'current') {
        if (!currentProfile) {
          throw new Error('No currently bound profile');
        }
        targetProfile = currentProfile;
      } else {
        const targetVersion = history.find((version) => version.id === versionId);
        if (!targetVersion) {
          throw new Error('Device profile version not found');
        }
        targetProfile = targetVersion.profile;
      }

      const nextHistory = history.map((version) => ({
        ...version,
        isCurrent: version.id === versionId,
      }));

      orm
        .update(accounts)
        .set({
          deviceProfileJson: serializeDeviceProfile(targetProfile),
          deviceHistoryJson: serializeDeviceHistory(nextHistory),
        })
        .where(eq(accounts.id, id))
        .run();

      return targetProfile;
    } finally {
      raw.close();
    }
  }

  static deleteDeviceVersion(id: string, versionId: string): void {
    if (versionId === 'baseline') {
      throw new Error('Original profile cannot be deleted');
    }

    const { raw, orm } = getCloudDb();
    try {
      const rows = orm
        .select({ deviceHistoryJson: accounts.deviceHistoryJson })
        .from(accounts)
        .where(eq(accounts.id, id))
        .all();
      const row = rows[0];
      if (!row) {
        throw new Error(`Account not found: ${id}`);
      }

      const history = parseDeviceHistoryColumn(row.deviceHistoryJson) || [];
      if (history.some((version) => version.id === versionId && version.isCurrent)) {
        throw new Error('Currently bound profile cannot be deleted');
      }

      const nextHistory = history.filter((version) => version.id !== versionId);
      if (nextHistory.length === history.length) {
        throw new Error('Historical device profile not found');
      }

      orm
        .update(accounts)
        .set({ deviceHistoryJson: serializeDeviceHistory(nextHistory) })
        .where(eq(accounts.id, id))
        .run();
    } finally {
      raw.close();
    }
  }
}

import { createHash } from 'node:crypto';
import { isNumber, isPlainObject, isString } from 'lodash-es';
import type { DeviceProfile, DeviceProfileVersion } from '@/modules/identity-profile/types';

const DEVICE_PAYLOAD_SCHEMA_VERSION = 1;

function readStringCandidate(
  source: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const candidate = source[key];
    if (isString(candidate) && candidate.length > 0) {
      return candidate;
    }
  }
  return undefined;
}

export function normalizeDeviceProfile(value: unknown): DeviceProfile | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const machineId = readStringCandidate(candidate, 'machineId', 'machine_id');
  const macMachineId = readStringCandidate(candidate, 'macMachineId', 'mac_machine_id');
  const devDeviceId = readStringCandidate(candidate, 'devDeviceId', 'dev_device_id');
  const sqmId = readStringCandidate(candidate, 'sqmId', 'sqm_id');
  if (!machineId || !macMachineId || !devDeviceId || !sqmId) {
    return undefined;
  }

  return {
    machineId,
    macMachineId,
    devDeviceId,
    sqmId,
  };
}

export function areDeviceProfilesEqual(left: DeviceProfile, right: DeviceProfile): boolean {
  return (
    left.machineId === right.machineId &&
    left.macMachineId === right.macMachineId &&
    left.devDeviceId === right.devDeviceId &&
    left.sqmId === right.sqmId
  );
}

function readVersionedProfilePayload(value: unknown): unknown {
  if (!isPlainObject(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  if (!('schemaVersion' in record)) {
    return value;
  }
  const schemaVersion = record.schemaVersion;
  if (!isNumber(schemaVersion) || !Number.isFinite(schemaVersion)) {
    throw new Error('invalid_device_profile_schema_version');
  }
  if (schemaVersion !== DEVICE_PAYLOAD_SCHEMA_VERSION) {
    throw new Error(`unsupported_device_profile_schema_version:${schemaVersion}`);
  }
  if (!('profile' in record)) {
    throw new Error('invalid_device_profile_payload');
  }
  return record.profile;
}

function readVersionedHistoryPayload(value: unknown): unknown {
  if (!isPlainObject(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  if (!('schemaVersion' in record)) {
    return value;
  }
  const schemaVersion = record.schemaVersion;
  if (!isNumber(schemaVersion) || !Number.isFinite(schemaVersion)) {
    throw new Error('invalid_device_history_schema_version');
  }
  if (schemaVersion !== DEVICE_PAYLOAD_SCHEMA_VERSION) {
    throw new Error(`unsupported_device_history_schema_version:${schemaVersion}`);
  }
  if (!('history' in record)) {
    throw new Error('invalid_device_history_payload');
  }
  return record.history;
}

function createLegacyDeviceHistoryFingerprint(
  itemRecord: Record<string, unknown>,
  profile: DeviceProfile,
): string {
  const createdAtCandidate = itemRecord.createdAt;
  const createdAt =
    isNumber(createdAtCandidate) && Number.isFinite(createdAtCandidate)
      ? Math.floor(createdAtCandidate)
      : null;
  const label = isString(itemRecord.label) && itemRecord.label.length > 0 ? itemRecord.label : null;
  return JSON.stringify({ createdAt, label, profile });
}

function createLegacyDeviceHistoryId(fingerprint: string, occurrence: number): string {
  const seed = JSON.stringify({ fingerprint, occurrence });
  return `legacy-${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`;
}

export function serializeDeviceProfile(profile: DeviceProfile | undefined): string | null {
  if (!profile) {
    return null;
  }
  return JSON.stringify({
    schemaVersion: DEVICE_PAYLOAD_SCHEMA_VERSION,
    profile,
  });
}

export function serializeDeviceHistory(history: DeviceProfileVersion[] | undefined): string | null {
  if (!history || history.length === 0) {
    return null;
  }
  return JSON.stringify({
    schemaVersion: DEVICE_PAYLOAD_SCHEMA_VERSION,
    history,
  });
}

export function normalizeDeviceHistory(value: unknown): DeviceProfileVersion[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized: DeviceProfileVersion[] = [];
  const legacyFingerprintOccurrences = new Map<string, number>();
  for (const item of value) {
    if (!isPlainObject(item)) {
      continue;
    }
    const itemRecord = item as Record<string, unknown>;
    const profile = normalizeDeviceProfile(itemRecord.profile);
    if (!profile) {
      continue;
    }

    let id: string;
    if (isString(itemRecord.id) && itemRecord.id.length > 0) {
      id = itemRecord.id;
    } else {
      const fingerprint = createLegacyDeviceHistoryFingerprint(itemRecord, profile);
      const occurrence = legacyFingerprintOccurrences.get(fingerprint) ?? 0;
      legacyFingerprintOccurrences.set(fingerprint, occurrence + 1);
      id = createLegacyDeviceHistoryId(fingerprint, occurrence);
    }
    const createdAtCandidate = itemRecord.createdAt;
    const createdAt =
      isNumber(createdAtCandidate) && Number.isFinite(createdAtCandidate)
        ? Math.floor(createdAtCandidate)
        : 0;
    const label =
      isString(itemRecord.label) && itemRecord.label.length > 0 ? itemRecord.label : 'legacy';
    const isCurrent = itemRecord.isCurrent === true;

    normalized.push({
      id,
      createdAt,
      label,
      profile,
      isCurrent,
    });
  }
  return normalized;
}

export function parseDeviceProfileColumn(
  value: string | null | undefined,
): DeviceProfile | undefined {
  if (!value) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('invalid_device_profile_json');
  }
  const normalized = normalizeDeviceProfile(readVersionedProfilePayload(parsed));
  if (!normalized) {
    throw new Error('invalid_device_profile_json');
  }
  return normalized;
}

export function parseDeviceHistoryColumn(
  value: string | null | undefined,
): DeviceProfileVersion[] | undefined {
  if (!value) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('invalid_device_history_json');
  }
  const payload = readVersionedHistoryPayload(parsed);
  if (!Array.isArray(payload)) {
    throw new Error('invalid_device_history_json');
  }
  const normalized = normalizeDeviceHistory(payload);
  if (!normalized) {
    throw new Error('invalid_device_history_json');
  }
  if (normalized.length !== payload.length) {
    throw new Error('invalid_device_history_entry');
  }
  return normalized;
}

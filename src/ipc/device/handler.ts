import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { createHash, randomBytes } from 'crypto';
import { isBoolean, isNumber, isObjectLike, isString } from 'lodash-es';
import { type DeviceProfile } from '../../types/account';
import { logger } from '../../utils/logger';
import { getAgentDir, getAntigravityDbPaths, getAntigravityStoragePaths } from '../../utils/paths';

const GLOBAL_BASELINE_FILE = 'device_original.json';
const SQLITE_RETRY_COUNT = 3;
const LAST_KNOWN_GOOD_DIR = 'device_last_known_good';
const LAST_KNOWN_GOOD_STORAGE_FILE = 'storage.json';
const LAST_KNOWN_GOOD_STATE_DB_FILE = 'state.vscdb';
const LAST_KNOWN_GOOD_MARKER_FILE = 'marker.json';
const DEVICE_HARDENING_SAFE_MODE_THRESHOLD = 3;
const DEVICE_HARDENING_SAFE_MODE_DURATION_MS = 5 * 60 * 1000;

export type DeviceApplyFailureReason =
  | 'backup_failed'
  | 'storage_write_failed'
  | 'state_sync_failed'
  | 'verify_storage_failed'
  | 'verify_state_failed'
  | 'snapshot_update_failed'
  | 'rollback_failed'
  | 'unknown';

export interface DeviceHardeningSnapshot {
  consecutiveApplyFailures: number;
  safeModeActive: boolean;
  safeModeUntil: number | null;
  lastFailureReason: DeviceApplyFailureReason | null;
  lastFailureStage: string | null;
  lastFailureAt: number | null;
}

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SQM_ID_REGEX = /^\{[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}\}$/;

interface DeviceProfileTemplate {
  machineIdPrefix: string;
  machineIdHexLength: number;
}

const DEFAULT_PROFILE_TEMPLATE: DeviceProfileTemplate = {
  machineIdPrefix: 'auth0|user_',
  machineIdHexLength: 32,
};

const DEVICE_PROFILE_TEMPLATES: Record<string, DeviceProfileTemplate[]> = {
  win32: [DEFAULT_PROFILE_TEMPLATE],
  linux: [DEFAULT_PROFILE_TEMPLATE],
  darwin: [DEFAULT_PROFILE_TEMPLATE],
};

interface LastKnownGoodMarker {
  version: 1;
  savedAt: number;
  hasStateDb: boolean;
}

interface DeviceHardeningState {
  consecutiveApplyFailures: number;
  safeModeUntil: number | null;
  lastFailureReason: DeviceApplyFailureReason | null;
  lastFailureStage: string | null;
  lastFailureAt: number | null;
}

const deviceHardeningState: DeviceHardeningState = {
  consecutiveApplyFailures: 0,
  safeModeUntil: null,
  lastFailureReason: null,
  lastFailureStage: null,
  lastFailureAt: null,
};

function isSqliteBusyError(error: unknown): boolean {
  if (!isObjectLike(error)) {
    return false;
  }
  const candidate = error as { code?: string; message?: string };
  if (candidate.code === 'SQLITE_BUSY' || candidate.code === 'SQLITE_LOCKED') {
    return true;
  }
  if (isString(candidate.message)) {
    return candidate.message.includes('SQLITE_BUSY') || candidate.message.includes('SQLITE_LOCKED');
  }
  return false;
}

function resolveExistingPath(paths: string[]): string | null {
  for (const targetPath of paths) {
    if (fs.existsSync(targetPath)) {
      return targetPath;
    }
  }
  return null;
}

function randomHex(length: number): string {
  return randomBytes(Math.ceil(length / 2))
    .toString('hex')
    .slice(0, length)
    .toLowerCase();
}

function getLastKnownGoodSnapshotDir(): string {
  return path.join(getAgentDir(), LAST_KNOWN_GOOD_DIR);
}

function getLastKnownGoodStoragePath(): string {
  return path.join(getLastKnownGoodSnapshotDir(), LAST_KNOWN_GOOD_STORAGE_FILE);
}

function getLastKnownGoodStateDbPath(): string {
  return path.join(getLastKnownGoodSnapshotDir(), LAST_KNOWN_GOOD_STATE_DB_FILE);
}

function getLastKnownGoodMarkerPath(): string {
  return path.join(getLastKnownGoodSnapshotDir(), LAST_KNOWN_GOOD_MARKER_FILE);
}

function ensureDirectoryExists(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function readLastKnownGoodMarker(): LastKnownGoodMarker | null {
  const markerPath = getLastKnownGoodMarkerPath();
  if (!fs.existsSync(markerPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(markerPath, 'utf-8');
    const parsed = JSON.parse(content) as Partial<LastKnownGoodMarker>;
    if (
      parsed &&
      parsed.version === 1 &&
      isNumber(parsed.savedAt) &&
      isBoolean(parsed.hasStateDb)
    ) {
      return {
        version: 1,
        savedAt: parsed.savedAt,
        hasStateDb: parsed.hasStateDb,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function parseStorageJson(storagePath: string): Record<string, unknown> {
  const content = fs.readFileSync(storagePath, 'utf-8');
  const parsed = JSON.parse(content);
  if (!isObjectLike(parsed) || Array.isArray(parsed)) {
    throw new Error('storage.json top-level value must be an object');
  }
  return parsed as Record<string, unknown>;
}

function getTelemetryField(storage: Record<string, unknown>, key: string): string | null {
  const telemetry = storage.telemetry;
  if (isObjectLike(telemetry) && !Array.isArray(telemetry)) {
    const nestedValue = (telemetry as Record<string, unknown>)[key];
    if (isString(nestedValue) && nestedValue.length > 0) {
      return nestedValue;
    }
  }

  const flatValue = storage[`telemetry.${key}`];
  if (isString(flatValue) && flatValue.length > 0) {
    return flatValue;
  }

  return null;
}

function ensureTelemetryObject(storage: Record<string, unknown>): Record<string, unknown> {
  if (
    !storage.telemetry ||
    !isObjectLike(storage.telemetry) ||
    Array.isArray(storage.telemetry)
  ) {
    storage.telemetry = {};
  }
  return storage.telemetry as Record<string, unknown>;
}

function getStateDbPathFromStorage(storagePath: string): string {
  return path.join(path.dirname(storagePath), 'state.vscdb');
}

function getGlobalBaselinePath(): string {
  return path.join(getAgentDir(), GLOBAL_BASELINE_FILE);
}

function writeJsonAtomically(filePath: string, payload: unknown): void {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const content = `${JSON.stringify(payload, null, 2)}\n`;
  fs.writeFileSync(tempPath, content, 'utf-8');
  try {
    fs.renameSync(tempPath, filePath);
  } catch {
    fs.copyFileSync(tempPath, filePath);
    fs.unlinkSync(tempPath);
  }
}

function readStateServiceMachineIdValue(dbPath: string): string | null {
  if (!fs.existsSync(dbPath)) {
    return null;
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 3000');
    const row = db
      .prepare("SELECT value FROM ItemTable WHERE key = 'storage.serviceMachineId' LIMIT 1")
      .get() as { value?: unknown } | undefined;
    if (!row || !isString(row.value) || row.value.length === 0) {
      return null;
    }
    return row.value;
  } catch (error) {
    logger.warn('Failed to read state.serviceMachineId from state.vscdb', error);
    return null;
  } finally {
    if (db) {
      db.close();
    }
  }
}

function ensureStorageProfileApplied(profile: DeviceProfile, storagePath: string): void {
  const applied = readCurrentDeviceProfile(storagePath);
  const isMatched =
    applied.machineId === profile.machineId &&
    applied.macMachineId === profile.macMachineId &&
    applied.devDeviceId === profile.devDeviceId &&
    applied.sqmId === profile.sqmId;
  if (!isMatched) {
    throw new Error('device_profile_integrity_check_failed_for_storage');
  }
}

function ensureStateServiceMachineIdApplied(serviceMachineId: string, dbPath: string): void {
  const value = readStateServiceMachineIdValue(dbPath);
  if (value !== serviceMachineId) {
    throw new Error('device_profile_integrity_check_failed_for_state_db');
  }
}

function cleanupPathIfExists(targetPath: string): void {
  if (fs.existsSync(targetPath)) {
    fs.rmSync(targetPath, { force: true });
  }
}

function cleanupStateDbJournalFiles(dbPath: string): void {
  cleanupPathIfExists(`${dbPath}-wal`);
  cleanupPathIfExists(`${dbPath}-shm`);
}

function pickDeviceProfileTemplate(): DeviceProfileTemplate {
  const templates = DEVICE_PROFILE_TEMPLATES[process.platform] || [DEFAULT_PROFILE_TEMPLATE];
  const randomIndex = Number.parseInt(randomHex(2), 16) % templates.length;
  return templates[randomIndex];
}

function deterministicUuidFromSeed(seed: string, namespace: string): string {
  const hash = createHash('sha256').update(`${namespace}:${seed}`).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));

  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

function ensureGeneratedProfile(profile: DeviceProfile, template: DeviceProfileTemplate): void {
  const machineIdPrefix = template.machineIdPrefix;
  const machineIdSuffix = profile.machineId.slice(machineIdPrefix.length);

  if (!profile.machineId.startsWith(machineIdPrefix)) {
    throw new Error('generated_profile_machine_id_prefix_invalid');
  }
  if (machineIdSuffix.length !== template.machineIdHexLength) {
    throw new Error('generated_profile_machine_id_length_invalid');
  }
  if (!/^[0-9a-f]+$/.test(machineIdSuffix)) {
    throw new Error('generated_profile_machine_id_suffix_invalid');
  }
  if (!UUID_V4_REGEX.test(profile.macMachineId)) {
    throw new Error('generated_profile_mac_machine_id_invalid');
  }
  if (!UUID_V4_REGEX.test(profile.devDeviceId)) {
    throw new Error('generated_profile_dev_device_id_invalid');
  }
  if (!SQM_ID_REGEX.test(profile.sqmId)) {
    throw new Error('generated_profile_sqm_id_invalid');
  }
  if (profile.macMachineId === profile.devDeviceId) {
    throw new Error('generated_profile_uuid_collision');
  }
}

function ensureStorageStateConsistency(
  storagePath: string,
  stateDbPath: string,
  expectedStateDb: boolean,
  requireStateMachineIdMatch: boolean = true,
): void {
  const profile = readCurrentDeviceProfile(storagePath);
  const hasStateDb = fs.existsSync(stateDbPath);

  if (expectedStateDb && !hasStateDb) {
    throw new Error('state_vscdb_missing_after_restore');
  }
  if (!hasStateDb) {
    return;
  }

  const stateValue = readStateServiceMachineIdValue(stateDbPath);
  if (!requireStateMachineIdMatch && !stateValue) {
    return;
  }
  if (stateValue !== profile.devDeviceId) {
    throw new Error('storage_state_service_machine_id_mismatch');
  }
}

function saveLastKnownGoodSnapshot(storagePath: string, stateDbPath: string): void {
  const snapshotDir = getLastKnownGoodSnapshotDir();
  ensureDirectoryExists(snapshotDir);

  const storageSnapshotPath = getLastKnownGoodStoragePath();
  const stateDbSnapshotPath = getLastKnownGoodStateDbPath();
  const markerPath = getLastKnownGoodMarkerPath();
  const hasStateDb = fs.existsSync(stateDbPath);

  fs.copyFileSync(storagePath, storageSnapshotPath);
  if (hasStateDb) {
    fs.copyFileSync(stateDbPath, stateDbSnapshotPath);
  } else {
    cleanupPathIfExists(stateDbSnapshotPath);
  }

  const marker: LastKnownGoodMarker = {
    version: 1,
    savedAt: Date.now(),
    hasStateDb,
  };
  writeJsonAtomically(markerPath, marker);
}

function restoreLastKnownGoodSnapshot(storagePath: string, stateDbPath: string): boolean {
  const marker = readLastKnownGoodMarker();
  if (!marker) {
    return false;
  }

  const storageSnapshotPath = getLastKnownGoodStoragePath();
  const stateDbSnapshotPath = getLastKnownGoodStateDbPath();

  if (!fs.existsSync(storageSnapshotPath)) {
    return false;
  }

  try {
    fs.copyFileSync(storageSnapshotPath, storagePath);
    if (marker.hasStateDb && fs.existsSync(stateDbSnapshotPath)) {
      fs.copyFileSync(stateDbSnapshotPath, stateDbPath);
    } else {
      cleanupPathIfExists(stateDbPath);
      cleanupStateDbJournalFiles(stateDbPath);
    }
    ensureStorageStateConsistency(storagePath, stateDbPath, marker.hasStateDb);
    return true;
  } catch (error) {
    logger.error('Failed to restore last known good device snapshot', error);
    return false;
  }
}

function classifyApplyFailure(stage: string, error: unknown): DeviceApplyFailureReason {
  if (stage === 'prepare_backup') {
    return 'backup_failed';
  }
  if (stage === 'prepare_write_storage') {
    return 'storage_write_failed';
  }
  if (stage === 'prepare_sync_state') {
    return 'state_sync_failed';
  }
  if (stage === 'verify_storage') {
    return 'verify_storage_failed';
  }
  if (stage === 'verify_state') {
    return 'verify_state_failed';
  }
  if (stage === 'commit_snapshot') {
    return 'snapshot_update_failed';
  }
  if (stage === 'rollback') {
    return 'rollback_failed';
  }

  if (error instanceof Error) {
    if (error.message.includes('device_profile_integrity_check_failed_for_storage')) {
      return 'verify_storage_failed';
    }
    if (error.message.includes('device_profile_integrity_check_failed_for_state_db')) {
      return 'verify_state_failed';
    }
  }
  return 'unknown';
}

function markApplySuccess(): void {
  deviceHardeningState.consecutiveApplyFailures = 0;
  deviceHardeningState.safeModeUntil = null;
}

function markApplyFailure(reason: DeviceApplyFailureReason, stage: string): void {
  const now = Date.now();
  deviceHardeningState.consecutiveApplyFailures += 1;
  deviceHardeningState.lastFailureReason = reason;
  deviceHardeningState.lastFailureStage = stage;
  deviceHardeningState.lastFailureAt = now;
  if (deviceHardeningState.consecutiveApplyFailures >= DEVICE_HARDENING_SAFE_MODE_THRESHOLD) {
    deviceHardeningState.safeModeUntil = now + DEVICE_HARDENING_SAFE_MODE_DURATION_MS;
  }
}

function isSafeModeActiveNow(): boolean {
  if (!deviceHardeningState.safeModeUntil) {
    return false;
  }
  const active = Date.now() < deviceHardeningState.safeModeUntil;
  if (!active) {
    deviceHardeningState.safeModeUntil = null;
  }
  return active;
}

function buildApplyError(
  reason: DeviceApplyFailureReason,
  stage: string,
  original: unknown,
): Error {
  const message = original instanceof Error ? original.message : String(original);
  const wrapped = new Error(`device_apply_failed:${reason}:${stage}:${message}`);
  (
    wrapped as Error & {
      deviceFailureReason?: DeviceApplyFailureReason;
      deviceFailureStage?: string;
    }
  ).deviceFailureReason = reason;
  (
    wrapped as Error & {
      deviceFailureReason?: DeviceApplyFailureReason;
      deviceFailureStage?: string;
    }
  ).deviceFailureStage = stage;
  return wrapped;
}

export function getDeviceHardeningSnapshot(): DeviceHardeningSnapshot {
  const safeModeActive = isSafeModeActiveNow();
  return {
    consecutiveApplyFailures: deviceHardeningState.consecutiveApplyFailures,
    safeModeActive,
    safeModeUntil: safeModeActive ? deviceHardeningState.safeModeUntil : null,
    lastFailureReason: deviceHardeningState.lastFailureReason,
    lastFailureStage: deviceHardeningState.lastFailureStage,
    lastFailureAt: deviceHardeningState.lastFailureAt,
  };
}

export function isIdentityProfileApplyEnabled(): boolean {
  const raw =
    process.env.CRACK_IDENTITY_PROFILE_APPLY_ENABLED ??
    process.env.CRACK_DEVICE_FINGERPRINT_ENABLED;
  if (!raw) {
    return !isSafeModeActiveNow();
  }
  const normalized = raw.trim().toLowerCase();
  const envEnabled =
    normalized !== '0' && normalized !== 'false' && normalized !== 'off' && normalized !== 'no';
  if (!envEnabled) {
    return false;
  }
  return !isSafeModeActiveNow();
}

export function getStoragePath(): string {
  const storagePath = resolveExistingPath(getAntigravityStoragePaths());
  if (!storagePath) {
    throw new Error('storage_json_not_found');
  }
  return storagePath;
}

export function getStorageDirectoryPath(): string {
  return path.dirname(getStoragePath());
}

export function loadGlobalOriginalProfile(): DeviceProfile | null {
  const baselinePath = getGlobalBaselinePath();
  if (!fs.existsSync(baselinePath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(baselinePath, 'utf-8');
    return JSON.parse(raw) as DeviceProfile;
  } catch (error) {
    logger.warn('Failed to load global original device profile', error);
    return null;
  }
}

export function saveGlobalOriginalProfile(profile: DeviceProfile): void {
  const baselinePath = getGlobalBaselinePath();
  const baselineDir = path.dirname(baselinePath);
  if (!fs.existsSync(baselineDir)) {
    fs.mkdirSync(baselineDir, { recursive: true });
  }
  if (fs.existsSync(baselinePath)) {
    return;
  }
  fs.writeFileSync(baselinePath, JSON.stringify(profile, null, 2), 'utf-8');
}

export function readCurrentDeviceProfile(storagePath?: string): DeviceProfile {
  const targetPath = storagePath || getStoragePath();
  const storage = parseStorageJson(targetPath);

  const machineId = getTelemetryField(storage, 'machineId');
  const macMachineId = getTelemetryField(storage, 'macMachineId');
  const devDeviceId = getTelemetryField(storage, 'devDeviceId');
  const sqmId = getTelemetryField(storage, 'sqmId');

  if (!machineId || !macMachineId || !devDeviceId || !sqmId) {
    throw new Error('missing_device_fingerprint_fields');
  }

  return {
    machineId,
    macMachineId,
    devDeviceId,
    sqmId,
  };
}

export function ensureGlobalOriginalFromCurrentStorage(): void {
  if (loadGlobalOriginalProfile()) {
    return;
  }

  try {
    const profile = readCurrentDeviceProfile();
    saveGlobalOriginalProfile(profile);
  } catch (error) {
    logger.warn('Failed to capture baseline device profile from storage.json', error);
  }
}

export function generateDeviceProfile(): DeviceProfile {
  const template = pickDeviceProfileTemplate();
  const seed = randomHex(32);
  const profile: DeviceProfile = {
    machineId: `${template.machineIdPrefix}${seed.slice(0, template.machineIdHexLength)}`,
    macMachineId: deterministicUuidFromSeed(seed, 'mac'),
    devDeviceId: deterministicUuidFromSeed(seed, 'dev'),
    sqmId: `{${deterministicUuidFromSeed(seed, 'sqm').toUpperCase()}}`,
  };
  ensureGeneratedProfile(profile, template);
  return profile;
}

export function syncStateServiceMachineIdValue(serviceMachineId: string, dbPath?: string): void {
  const targetDbPath = dbPath || resolveExistingPath(getAntigravityDbPaths());
  if (!targetDbPath) {
    throw new Error('state_vscdb_not_found');
  }

  const targetDbDir = path.dirname(targetDbPath);
  if (!fs.existsSync(targetDbDir)) {
    fs.mkdirSync(targetDbDir, { recursive: true });
  }

  for (let attempt = 1; attempt <= SQLITE_RETRY_COUNT; attempt += 1) {
    let db: Database.Database | null = null;
    try {
      db = new Database(targetDbPath);
      db.pragma('busy_timeout = 3000');
      db.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value TEXT);');
      db.prepare(
        "INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('storage.serviceMachineId', ?)",
      ).run(serviceMachineId);
      return;
    } catch (error) {
      if (isSqliteBusyError(error) && attempt < SQLITE_RETRY_COUNT) {
        logger.warn(`state.vscdb busy, retrying (${attempt}/${SQLITE_RETRY_COUNT})`, error);
        continue;
      }
      throw error;
    } finally {
      if (db) {
        db.close();
      }
    }
  }

  throw new Error('sync_state_service_machine_id_failed');
}

export function applyDeviceProfile(profile: DeviceProfile): string {
  const storagePath = getStoragePath();
  const backupPath = `${storagePath}.backup`;
  const stateDbPath = getStateDbPathFromStorage(storagePath);
  const stateBackupPath = `${stateDbPath}.backup`;
  const hadStateDb = fs.existsSync(stateDbPath);
  let stage = 'prepare_backup';

  try {
    fs.copyFileSync(storagePath, backupPath);
    if (hadStateDb) {
      fs.copyFileSync(stateDbPath, stateBackupPath);
    }

    stage = 'prepare_write_storage';
    const storage = parseStorageJson(storagePath);
    const telemetry = ensureTelemetryObject(storage);

    telemetry.machineId = profile.machineId;
    telemetry.macMachineId = profile.macMachineId;
    telemetry.devDeviceId = profile.devDeviceId;
    telemetry.sqmId = profile.sqmId;

    storage['telemetry.machineId'] = profile.machineId;
    storage['telemetry.macMachineId'] = profile.macMachineId;
    storage['telemetry.devDeviceId'] = profile.devDeviceId;
    storage['telemetry.sqmId'] = profile.sqmId;
    storage['storage.serviceMachineId'] = profile.devDeviceId;

    writeJsonAtomically(storagePath, storage);

    stage = 'prepare_sync_state';
    syncStateServiceMachineIdValue(profile.devDeviceId, stateDbPath);

    stage = 'verify_storage';
    ensureStorageProfileApplied(profile, storagePath);

    stage = 'verify_state';
    ensureStateServiceMachineIdApplied(profile.devDeviceId, stateDbPath);

    stage = 'commit_snapshot';
    try {
      saveLastKnownGoodSnapshot(storagePath, stateDbPath);
    } catch (snapshotError) {
      logger.warn('Failed to update last known good device snapshot', snapshotError);
    }

    cleanupPathIfExists(backupPath);
    cleanupPathIfExists(stateBackupPath);
    markApplySuccess();
    return storagePath;
  } catch (error) {
    const classifiedReason = classifyApplyFailure(stage, error);
    markApplyFailure(classifiedReason, stage);

    let rollbackStage = 'rollback_immediate_backup';
    let restoredFromImmediateBackup = false;
    try {
      if (fs.existsSync(backupPath)) {
        fs.copyFileSync(backupPath, storagePath);
      }
      if (hadStateDb && fs.existsSync(stateBackupPath)) {
        fs.copyFileSync(stateBackupPath, stateDbPath);
      }
      if (!hadStateDb) {
        cleanupPathIfExists(stateDbPath);
        cleanupStateDbJournalFiles(stateDbPath);
      }
      ensureStorageStateConsistency(storagePath, stateDbPath, hadStateDb, false);
      restoredFromImmediateBackup = true;
    } catch (restoreError) {
      logger.error('Failed to restore device profile from immediate backup', restoreError);
      rollbackStage = 'rollback_last_known_good';
    }

    if (!restoredFromImmediateBackup) {
      const restoredFromLastKnownGood = restoreLastKnownGoodSnapshot(storagePath, stateDbPath);
      if (!restoredFromLastKnownGood) {
        logger.error('Failed to restore device profile from last known good snapshot');
        markApplyFailure('rollback_failed', rollbackStage);
      }
    }

    throw buildApplyError(classifiedReason, stage, error);
  } finally {
    cleanupPathIfExists(backupPath);
    cleanupPathIfExists(stateBackupPath);
  }
}

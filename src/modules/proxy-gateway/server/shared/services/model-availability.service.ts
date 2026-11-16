import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { CloudAccountSettingsStore } from '@/modules/cloud-account/persistence/cloud-account-settings-store';
import { getQuotaModelFamilyId } from '@/modules/cloud-account/utils/quota-model-families';
import { logger } from '@/shared/logging/logger';
import { hasQualifiedQuotaDeadline } from './qualified-quota-evidence';

export type ProxyModelAvailabilityReason =
  | 'model_not_supported'
  | 'model_forbidden'
  | 'quota_exhausted'
  | 'rate_limited'
  | 'capacity_exhausted';

export interface ProxyModelAvailability {
  accountId: string;
  modelId: string;
  reason: ProxyModelAvailabilityReason;
  unavailableUntil: number;
  status?: number;
  detectedAt: number;
  message?: string;
}

const MODEL_UNAVAILABLE_CACHE_MS = 900_000;
const DEFAULT_RATE_LIMIT_CACHE_MS = 5 * 60 * 1000;
const RECENT_FAILURE_DISPLAY_MS = 10 * 60 * 1000;
const MAX_MESSAGE_LENGTH = 500;
const PERSISTENCE_KEY = 'proxy_model_availability.v1';

const ProxyModelAvailabilitySchema = z.object({
  accountId: z.string().min(1),
  modelId: z.string().min(1),
  reason: z.enum([
    'model_not_supported',
    'model_forbidden',
    'quota_exhausted',
    'rate_limited',
    'capacity_exhausted',
  ]),
  unavailableUntil: z.number().finite(),
  status: z.number().int().min(100).max(599).optional(),
  detectedAt: z.number().finite(),
  message: z.string().max(MAX_MESSAGE_LENGTH).optional(),
});

const ProxyModelAvailabilityListSchema = z.array(ProxyModelAvailabilitySchema);

export interface ProxyModelAvailabilityPersistence {
  load(): unknown;
  save(entries: ProxyModelAvailability[]): void;
}

function normalizeModelId(modelId: string): string {
  return modelId
    .trim()
    .replace(/^models\//i, '')
    .toLowerCase();
}

function createKey(accountId: string, modelId: string): string {
  return `${accountId}:${normalizeModelId(modelId)}`;
}

function isCapabilityReason(reason: ProxyModelAvailabilityReason): boolean {
  return reason === 'model_not_supported' || reason === 'model_forbidden';
}

function getCapabilityModelId(modelId: string): string {
  return getQuotaModelFamilyId(normalizeModelId(modelId));
}

function createCapabilityKey(accountId: string, modelId: string): string {
  return `${accountId}:${getCapabilityModelId(modelId)}`;
}

function shouldRetainEntry(entry: ProxyModelAvailability, now: number): boolean {
  return entry.unavailableUntil > now || entry.detectedAt + RECENT_FAILURE_DISPLAY_MS > now;
}

@Injectable()
export class ModelAvailabilityService {
  private readonly entries = new Map<string, ProxyModelAvailability>();
  private isHydrated = false;
  private hydrationFailed = false;

  constructor(private readonly persistence?: ProxyModelAvailabilityPersistence) {}

  mark(
    accountId: string,
    modelId: string,
    reason: ProxyModelAvailabilityReason,
    unavailableUntil?: number,
    details: {
      status?: number;
      detectedAt?: number;
      message?: string;
    } = {},
  ): void {
    if (!accountId || !modelId) {
      return;
    }
    this.hydrate();
    const timeout = isCapabilityReason(reason)
      ? MODEL_UNAVAILABLE_CACHE_MS
      : reason === 'capacity_exhausted'
        ? 3 * 60 * 1000
        : DEFAULT_RATE_LIMIT_CACHE_MS;
    const key = isCapabilityReason(reason)
      ? createCapabilityKey(accountId, modelId)
      : createKey(accountId, modelId);
    const incoming: ProxyModelAvailability = {
      accountId,
      modelId: isCapabilityReason(reason)
        ? getCapabilityModelId(modelId)
        : normalizeModelId(modelId),
      reason,
      unavailableUntil: unavailableUntil ?? Date.now() + timeout,
      status: details.status,
      detectedAt: details.detectedAt ?? Date.now(),
      message: details.message?.slice(0, MAX_MESSAGE_LENGTH),
    };
    const current = this.entries.get(key);
    if (
      current &&
      (reason === 'quota_exhausted' || reason === 'rate_limited') &&
      hasQualifiedQuotaDeadline(current) &&
      (!hasQualifiedQuotaDeadline(incoming) || current.unavailableUntil > incoming.unavailableUntil)
    ) {
      return;
    }
    this.entries.set(key, incoming);
    this.persist();
  }

  clearAccount(accountId: string): void {
    this.hydrate();
    let changed = false;
    for (const [key, entry] of this.entries) {
      if (entry.accountId === accountId) {
        this.entries.delete(key);
        changed = true;
      }
    }
    if (changed) {
      this.persist();
    }
  }

  clearModel(accountId: string, modelId: string): boolean {
    if (!accountId || !modelId) {
      return false;
    }
    this.hydrate();
    const normalizedModelId = normalizeModelId(modelId);
    const capabilityKey = createCapabilityKey(accountId, normalizedModelId);
    const changed =
      this.entries.delete(createKey(accountId, normalizedModelId)) ||
      this.entries.delete(capabilityKey);
    if (changed) {
      this.persist();
    }
    return changed;
  }

  /** Deletion is complete only after the retained snapshot is durably saved. Safe to retry. */
  clearAccountOrThrow(accountId: string): void {
    this.hydrate(true);
    const retained = [...this.entries.values()].filter((entry) => entry.accountId !== accountId);
    this.persistence?.save(retained);
    for (const [key, entry] of this.entries) {
      if (entry.accountId === accountId) {
        this.entries.delete(key);
      }
    }
  }

  clearModelFamily(accountId: string, modelId: string): number {
    if (!accountId || !modelId) {
      return 0;
    }
    this.hydrate();
    const family = getQuotaModelFamilyId(modelId);
    let deleted = 0;
    for (const [key, entry] of this.entries) {
      const capabilityFailure = isCapabilityReason(entry.reason);
      if (
        entry.accountId === accountId &&
        getQuotaModelFamilyId(entry.modelId) === family &&
        (!capabilityFailure || entry.modelId === normalizeModelId(modelId))
      ) {
        this.entries.delete(key);
        deleted += 1;
      }
    }
    if (deleted > 0) {
      this.persist();
    }
    return deleted;
  }

  clearCapabilityFailures(accountId: string, advertisedModels?: readonly string[]): void {
    this.hydrate();
    const advertisedFamilies =
      advertisedModels && new Set(advertisedModels.map(getCapabilityModelId));
    let changed = false;
    for (const [key, entry] of this.entries) {
      if (
        entry.accountId === accountId &&
        entry.modelId.includes('image') &&
        (!advertisedFamilies || advertisedFamilies.has(entry.modelId)) &&
        (entry.reason === 'model_not_supported' || entry.reason === 'model_forbidden')
      ) {
        this.entries.delete(key);
        changed = true;
      }
    }
    if (changed) {
      this.persist();
    }
  }

  isCapabilityBlocked(accountId: string, modelId: string): boolean {
    this.hydrate();
    const entry =
      this.entries.get(createCapabilityKey(accountId, modelId)) ??
      this.entries.get(createKey(accountId, modelId));
    return (
      entry !== undefined && entry.unavailableUntil > Date.now() && isCapabilityReason(entry.reason)
    );
  }

  getSnapshot(): ProxyModelAvailability[] {
    this.hydrate();
    const now = Date.now();
    let changed = false;
    for (const [key, entry] of this.entries) {
      if (!shouldRetainEntry(entry, now)) {
        this.entries.delete(key);
        changed = true;
      }
    }
    if (changed) {
      this.persist();
    }
    return [...this.entries.values()];
  }

  getActiveSnapshot(now = Date.now()): ProxyModelAvailability[] {
    this.hydrate();
    return [...this.entries.values()].filter((entry) => entry.unavailableUntil > now);
  }

  private hydrate(strict = false): void {
    if (this.isHydrated && !(strict && this.hydrationFailed)) {
      return;
    }
    this.isHydrated = true;
    if (!this.persistence) {
      this.isHydrated = true;
      return;
    }

    try {
      const parsed = ProxyModelAvailabilityListSchema.parse(this.persistence.load());
      const now = Date.now();
      for (const entry of parsed) {
        const key = isCapabilityReason(entry.reason)
          ? createCapabilityKey(entry.accountId, entry.modelId)
          : createKey(entry.accountId, entry.modelId);
        if (shouldRetainEntry(entry, now) && !this.entries.has(key)) {
          this.entries.set(key, entry);
        }
      }
      this.hydrationFailed = false;
      if (!strict && this.entries.size !== parsed.length) {
        this.persist();
      }
    } catch (error) {
      this.hydrationFailed = true;
      if (strict) {
        throw error;
      }
      logger.warn('Failed to load persisted proxy model availability', error);
    }
  }

  private persist(): void {
    if (!this.persistence || this.hydrationFailed) {
      return;
    }
    try {
      this.persistence.save([...this.entries.values()]);
    } catch (error) {
      // Availability persistence must never fail an otherwise valid proxy request.
      logger.warn('Failed to persist proxy model availability', error);
    }
  }
}

const persistentAvailabilityAdapter: ProxyModelAvailabilityPersistence | undefined =
  process.env.NODE_ENV === 'test'
    ? undefined
    : {
        load: () => {
          const stored = CloudAccountSettingsStore.readSetting(PERSISTENCE_KEY);
          return stored === undefined ? [] : stored;
        },
        save: (entries) => CloudAccountSettingsStore.setSetting(PERSISTENCE_KEY, entries),
      };

export const proxyModelAvailabilityStore = new ModelAvailabilityService(
  persistentAvailabilityAdapter,
);

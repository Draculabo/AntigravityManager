import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { CloudAccountSettingsStore } from '@/modules/cloud-account/persistence/cloud-account-settings-store';
import { logger } from '@/shared/logging/logger';

export type ProxyModelAvailabilityReason =
  | 'model_not_supported'
  | 'model_forbidden'
  | 'quota_exhausted'
  | 'rate_limited';

export interface ProxyModelAvailability {
  accountId: string;
  modelId: string;
  reason: ProxyModelAvailabilityReason;
  unavailableUntil: number;
  status?: number;
  detectedAt: number;
  message?: string;
}

const MODEL_UNAVAILABLE_CACHE_MS = 20 * 60 * 1000;
const DEFAULT_RATE_LIMIT_CACHE_MS = 5 * 60 * 1000;
const RECENT_FAILURE_DISPLAY_MS = 10 * 60 * 1000;
const MAX_MESSAGE_LENGTH = 500;
const PERSISTENCE_KEY = 'proxy_model_availability.v1';

const ProxyModelAvailabilitySchema = z.object({
  accountId: z.string().min(1),
  modelId: z.string().min(1),
  reason: z.enum(['model_not_supported', 'model_forbidden', 'quota_exhausted', 'rate_limited']),
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

function shouldRetainEntry(entry: ProxyModelAvailability, now: number): boolean {
  return entry.unavailableUntil > now || entry.detectedAt + RECENT_FAILURE_DISPLAY_MS > now;
}

@Injectable()
export class ModelAvailabilityService {
  private readonly entries = new Map<string, ProxyModelAvailability>();
  private isHydrated = false;

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
    const timeout =
      reason === 'model_not_supported' || reason === 'model_forbidden'
        ? MODEL_UNAVAILABLE_CACHE_MS
        : DEFAULT_RATE_LIMIT_CACHE_MS;
    this.entries.set(createKey(accountId, modelId), {
      accountId,
      modelId: normalizeModelId(modelId),
      reason,
      unavailableUntil: unavailableUntil ?? Date.now() + timeout,
      status: details.status,
      detectedAt: details.detectedAt ?? Date.now(),
      message: details.message?.slice(0, MAX_MESSAGE_LENGTH),
    });
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
    let changed = this.entries.delete(createKey(accountId, normalizedModelId));
    if (normalizedModelId.includes('image')) {
      changed = this.entries.delete(createKey(accountId, 'gemini-3.1-flash-image')) || changed;
      changed = this.entries.delete(createKey(accountId, 'gemini-3-pro-image')) || changed;
    }
    if (changed) {
      this.persist();
    }
    return changed;
  }

  clearCapabilityFailures(accountId: string): void {
    this.hydrate();
    let changed = false;
    for (const [key, entry] of this.entries) {
      if (
        entry.accountId === accountId &&
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

  private hydrate(): void {
    if (this.isHydrated) {
      return;
    }
    this.isHydrated = true;
    if (!this.persistence) {
      return;
    }

    try {
      const parsed = ProxyModelAvailabilityListSchema.safeParse(this.persistence.load());
      if (!parsed.success) {
        return;
      }
      const now = Date.now();
      for (const entry of parsed.data) {
        if (shouldRetainEntry(entry, now)) {
          this.entries.set(createKey(entry.accountId, entry.modelId), entry);
        }
      }
      if (this.entries.size !== parsed.data.length) {
        this.persist();
      }
    } catch (error) {
      logger.warn('Failed to load persisted proxy model availability', error);
    }
  }

  private persist(): void {
    if (!this.persistence) {
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
        load: () => CloudAccountSettingsStore.getSetting(PERSISTENCE_KEY, []),
        save: (entries) => CloudAccountSettingsStore.setSetting(PERSISTENCE_KEY, entries),
      };

export const proxyModelAvailabilityStore = new ModelAvailabilityService(
  persistentAvailabilityAdapter,
);

import path from 'node:path';

import { Inject, Injectable, Optional } from '@nestjs/common';

import { DurableRecordStore } from '@/shared/persistence/durable-record-store';
import {
  isDurableStoreTestEnvironment,
  readPositiveIntegerEnv,
} from '@/shared/persistence/durable-store-settings';
import { getProxyStateDir } from '@/shared/platform/paths';

export interface ModelRouteMissJournalEntry {
  model: string;
  count: number;
  lastSeen: number;
}

export interface ModelRouteMissJournalOptions {
  /** Absolute path of the backing file. Omit to keep the journal in memory only. */
  filePath?: string;
  maxEntries?: number;
  ttlMs?: number;
}

export const MODEL_ROUTE_MISS_JOURNAL_MAX_ENTRIES = 50;
export const MODEL_ROUTE_MISS_JOURNAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MODEL_ROUTE_MISS_JOURNAL_OPTIONS = 'MODEL_ROUTE_MISS_JOURNAL_OPTIONS';
export const MODEL_ROUTE_MISS_JOURNAL_FILENAME = 'model-route-misses.json';

const MODEL_ROUTE_ID_NORMALIZATION = /^models\//i;

function normalizeModelId(value: string): string {
  return value.replace(MODEL_ROUTE_ID_NORMALIZATION, '').trim().toLowerCase();
}

export function defaultModelRouteMissJournalOptions(): ModelRouteMissJournalOptions {
  return {
    filePath: isDurableStoreTestEnvironment()
      ? undefined
      : path.join(getProxyStateDir(), MODEL_ROUTE_MISS_JOURNAL_FILENAME),
    maxEntries: readPositiveIntegerEnv(
      'AGM_ROUTE_MISS_MAX_ENTRIES',
      MODEL_ROUTE_MISS_JOURNAL_MAX_ENTRIES,
    ),
    ttlMs: readPositiveIntegerEnv('AGM_ROUTE_MISS_TTL_MS', MODEL_ROUTE_MISS_JOURNAL_TTL_MS),
  };
}

/**
 * Records which model ids clients asked for that this gateway could not route.
 *
 * This is the first thing a user reads when a tool stops working, so it has to
 * outlive the restart that usually prompts the question. Only the id, a count
 * and a timestamp are kept -- never a prompt, a request body or account
 * identity.
 */
@Injectable()
export class ModelRouteMissJournalService {
  private readonly entries: DurableRecordStore<ModelRouteMissJournalEntry>;

  public constructor(
    @Optional()
    @Inject(MODEL_ROUTE_MISS_JOURNAL_OPTIONS)
    options?: ModelRouteMissJournalOptions,
  ) {
    const resolved = options ?? defaultModelRouteMissJournalOptions();
    this.entries = new DurableRecordStore<ModelRouteMissJournalEntry>({
      filePath: resolved.filePath,
      maxEntries: resolved.maxEntries ?? MODEL_ROUTE_MISS_JOURNAL_MAX_ENTRIES,
      ttlMs: resolved.ttlMs ?? MODEL_ROUTE_MISS_JOURNAL_TTL_MS,
      revive: reviveModelRouteMissJournalEntry,
    });
  }

  record(model: string): void {
    const normalizedModel = normalizeModelId(model);
    if (!normalizedModel) {
      return;
    }

    const now = Date.now();
    const existing = this.entries.get(normalizedModel, now);
    this.entries.set(
      normalizedModel,
      {
        model: normalizedModel,
        count: (existing?.count ?? 0) + 1,
        lastSeen: now,
      },
      now,
    );
  }

  clear(): void {
    this.entries.clear();
  }

  getSnapshot(): ModelRouteMissJournalEntry[] {
    return this.entries
      .entries()
      .map((record) => record.value)
      .sort((left, right) => right.lastSeen - left.lastSeen);
  }

  /** Resolves once every pending write has reached the disk. */
  flush(): Promise<void> {
    return this.entries.flush();
  }
}

function reviveModelRouteMissJournalEntry(value: unknown): ModelRouteMissJournalEntry | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const model = Reflect.get(value, 'model');
  const count = Reflect.get(value, 'count');
  const lastSeen = Reflect.get(value, 'lastSeen');
  if (typeof model !== 'string' || !model) {
    return null;
  }
  if (!Number.isInteger(count) || (count as number) < 1) {
    return null;
  }
  if (typeof lastSeen !== 'number' || !Number.isFinite(lastSeen)) {
    return null;
  }
  return { model, count: count as number, lastSeen };
}

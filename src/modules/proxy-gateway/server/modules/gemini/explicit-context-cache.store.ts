import { createHash } from 'node:crypto';

import type { GeminiInternalRequest, GeminiRequest } from '../../../antigravity/types';

const DEFAULT_TTL_MS = 60 * 60 * 1000;
const FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 500;
const MIN_STATIC_PREFIX_CHARACTERS = 8_192;

export interface ExplicitContextCacheSource {
  model: string;
  project: string;
  systemInstruction?: GeminiRequest['systemInstruction'];
  toolConfig?: GeminiRequest['toolConfig'];
  tools?: GeminiRequest['tools'];
}

export interface ExplicitContextCacheCandidate {
  key: string;
  source: ExplicitContextCacheSource;
}

export interface ExplicitContextCacheResource {
  expireTime?: string;
  name: string;
}

export interface ExplicitContextCacheStats {
  activeEntries: number;
  creationFailures: number;
  creations: number;
  hits: number;
  invalidations: number;
  lookups: number;
}

interface CacheEntry {
  expiresAt: number;
  name: string;
}

/**
 * Keeps only resource metadata in memory. The cache payload itself remains at
 * the upstream provider and is never written to disk or application logs.
 */
export class ExplicitContextCacheManager {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly failedUntil = new Map<string, number>();
  private readonly pending = new Map<string, Promise<string | null>>();
  private readonly stats: ExplicitContextCacheStats = {
    activeEntries: 0,
    creationFailures: 0,
    creations: 0,
    hits: 0,
    invalidations: 0,
    lookups: 0,
  };

  public createCandidate(body: GeminiInternalRequest): ExplicitContextCacheCandidate | null {
    const project = typeof body.project === 'string' ? body.project.trim() : '';
    const model = typeof body.model === 'string' ? body.model.trim() : '';
    const { systemInstruction, toolConfig, tools } = body.request;

    if (
      body.requestType === 'image_gen' ||
      !project ||
      !model ||
      (!systemInstruction && (!tools || tools.length === 0))
    ) {
      return null;
    }

    const source: ExplicitContextCacheSource = {
      model,
      project,
      systemInstruction,
      toolConfig,
      tools,
    };
    const serialized = JSON.stringify(source);
    if (serialized.length < this.getMinimumStaticPrefixCharacters()) {
      return null;
    }

    return {
      key: createHash('sha256').update(serialized).digest('hex'),
      source,
    };
  }

  public async resolve(
    candidate: ExplicitContextCacheCandidate,
    create: () => Promise<ExplicitContextCacheResource | null>,
  ): Promise<string | null> {
    this.stats.lookups += 1;
    const existing = this.get(candidate.key);
    if (existing) {
      this.stats.hits += 1;
      return existing;
    }

    if ((this.failedUntil.get(candidate.key) ?? 0) > Date.now()) {
      return null;
    }

    const pending = this.pending.get(candidate.key);
    if (pending) {
      return pending;
    }

    const task = create()
      .then((resource) => {
        if (!resource) {
          this.failedUntil.set(candidate.key, Date.now() + FAILURE_COOLDOWN_MS);
          this.stats.creationFailures += 1;
          return null;
        }

        this.entries.set(candidate.key, {
          expiresAt: this.resolveExpiry(resource.expireTime),
          name: resource.name,
        });
        this.stats.creations += 1;
        this.failedUntil.delete(candidate.key);
        this.evictExpired();
        return resource.name;
      })
      .catch(() => {
        this.failedUntil.set(candidate.key, Date.now() + FAILURE_COOLDOWN_MS);
        this.stats.creationFailures += 1;
        return null;
      })
      .finally(() => {
        this.pending.delete(candidate.key);
      });

    this.pending.set(candidate.key, task);
    return task;
  }

  public clear(): void {
    this.entries.clear();
    this.failedUntil.clear();
    this.pending.clear();
    this.resetStats();
  }

  public invalidate(key: string): void {
    this.entries.delete(key);
    this.failedUntil.set(key, Date.now() + FAILURE_COOLDOWN_MS);
    this.stats.invalidations += 1;
    this.updateActiveEntryCount();
  }

  public getStats(): ExplicitContextCacheStats {
    this.evictExpired();
    return { ...this.stats };
  }

  private get(key: string): string | null {
    const entry = this.entries.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      this.updateActiveEntryCount();
      return null;
    }
    return entry.name;
  }

  private resolveExpiry(expireTime: string | undefined): number {
    const parsed = expireTime ? Date.parse(expireTime) : Number.NaN;
    return Number.isFinite(parsed) && parsed > Date.now() ? parsed : Date.now() + DEFAULT_TTL_MS;
  }

  private evictExpired(): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= Date.now()) {
        this.entries.delete(key);
      }
    }

    while (this.entries.size > MAX_ENTRIES) {
      const oldestKey = this.entries.keys().next().value;
      if (!oldestKey) {
        return;
      }
      this.entries.delete(oldestKey);
    }
    this.updateActiveEntryCount();
  }

  private getMinimumStaticPrefixCharacters(): number {
    const configured = Number.parseInt(process.env.PROXY_CONTEXT_CACHE_MIN_CHARACTERS ?? '', 10);
    return configured > 0 ? configured : MIN_STATIC_PREFIX_CHARACTERS;
  }

  private resetStats(): void {
    this.stats.activeEntries = 0;
    this.stats.creationFailures = 0;
    this.stats.creations = 0;
    this.stats.hits = 0;
    this.stats.invalidations = 0;
    this.stats.lookups = 0;
  }

  private updateActiveEntryCount(): void {
    this.stats.activeEntries = this.entries.size;
  }
}

export const explicitContextCacheManager = new ExplicitContextCacheManager();

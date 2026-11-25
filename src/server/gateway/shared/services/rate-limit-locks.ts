import { RateLimitReason, type RateLimitInfo } from './rate-limit-types';

interface LockConstraints {
  explicitQuota?: RateLimitInfo;
  inferredQuota?: RateLimitInfo;
  transient?: RateLimitInfo;
}

/** Quota evidence and temporary waits expire independently, even when their deadlines overlap. */
export class RateLimitLocks {
  private readonly locks = new Map<string, LockConstraints>();

  get size(): number {
    return this.locks.size;
  }

  get(key: string): RateLimitInfo | undefined {
    const constraints = this.locks.get(key);
    if (!constraints) {
      return undefined;
    }
    const { explicitQuota, inferredQuota, transient } = constraints;
    const temporary = inferredQuota && (!transient || inferredQuota.resetTimeMs > transient.resetTimeMs)
      ? inferredQuota
      : transient;
    if (!explicitQuota) {
      return temporary;
    }
    if (!temporary || explicitQuota.resetTimeMs >= temporary.resetTimeMs) {
      return explicitQuota;
    }
    return {
      ...temporary,
      preservesExplicitQuota: explicitQuota.resetTimeMs > Date.now(),
    };
  }

  store(key: string, info: RateLimitInfo): RateLimitInfo {
    const constraints = this.locks.get(key) ?? {};
    if (info.preservesExplicitQuota) {
      const previous = constraints.explicitQuota;
      if (!previous || previous.resetTimeMs <= Date.now() || info.resetTimeMs >= previous.resetTimeMs) {
        constraints.explicitQuota = info;
      }
    } else if (info.reason === RateLimitReason.QuotaExhausted) {
      constraints.inferredQuota = info;
    } else {
      constraints.transient = info;
    }
    this.locks.set(key, constraints);
    return this.get(key) ?? info;
  }

  delete(key: string): boolean {
    return this.locks.delete(key);
  }

  clearRecoveredQuota(key: string): boolean {
    const constraints = this.locks.get(key);
    if (!constraints) {
      return false;
    }

    const expiredQuota =
      constraints.explicitQuota !== undefined && constraints.explicitQuota.resetTimeMs <= Date.now();
    const inferredQuota = constraints.inferredQuota !== undefined;
    if (expiredQuota) {
      delete constraints.explicitQuota;
    }
    if (inferredQuota) {
      delete constraints.inferredQuota;
    }
    if (!constraints.explicitQuota && !constraints.transient) {
      this.locks.delete(key);
    }
    return expiredQuota || inferredQuota;
  }

  clear(): void {
    this.locks.clear();
  }

  *entries(): IterableIterator<[string, RateLimitInfo]> {
    for (const key of this.locks.keys()) {
      const info = this.get(key);
      if (info) {
        yield [key, info];
      }
    }
  }
}

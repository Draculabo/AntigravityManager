import type { RateLimitInfo } from './rate-limit-types';

interface LockConstraints {
  quota?: RateLimitInfo;
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
    const quota = constraints?.quota;
    const transient = constraints?.transient;
    if (!quota) {
      return transient;
    }
    if (!transient || quota.resetTimeMs >= transient.resetTimeMs) {
      return quota;
    }
    return {
      ...transient,
      preservesExplicitQuota: quota.resetTimeMs > Date.now(),
    };
  }

  store(key: string, info: RateLimitInfo): RateLimitInfo {
    const constraints = this.locks.get(key) ?? {};
    const channel = info.preservesExplicitQuota ? 'quota' : 'transient';
    const previous = constraints[channel];
    if (
      channel === 'transient' ||
      !previous ||
      previous.resetTimeMs <= Date.now() ||
      info.resetTimeMs >= previous.resetTimeMs
    ) {
      constraints[channel] = info;
    }
    this.locks.set(key, constraints);
    return this.get(key) ?? info;
  }

  delete(key: string): boolean {
    return this.locks.delete(key);
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

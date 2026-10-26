export interface ThoughtCaptureLease {
  readonly sessionKey: string;
  readonly valid: boolean;
  release(): void;
}

class CaptureLease implements ThoughtCaptureLease {
  private live = true;
  constructor(
    readonly sessionKey: string,
    private readonly remove: () => void,
  ) {}
  get valid(): boolean {
    return this.live;
  }
  release(): void {
    this.live = false;
    this.remove();
  }
  revoke(): void {
    this.live = false;
  }
}

/** Request lifetime owns these entries; revocation needs no permanent session tombstones. */
export class ThoughtCaptureLeases {
  private readonly sessions = new Map<string, Set<CaptureLease>>();
  private readonly blockedSessions = new Map<string, number>();
  private blockedAll = 0;

  acquire(sessionKey: string): ThoughtCaptureLease {
    if (this.blockedAll || this.blockedSessions.has(sessionKey)) {
      const lease = new CaptureLease(sessionKey, () => {});
      lease.revoke();
      return lease;
    }
    let owned = this.sessions.get(sessionKey);
    if (!owned) {
      owned = new Set();
      this.sessions.set(sessionKey, owned);
    }
    const leases = owned;
    const lease = new CaptureLease(sessionKey, () => {
      leases.delete(lease);
      if (leases.size === 0 && this.sessions.get(sessionKey) === leases) {
        this.sessions.delete(sessionKey);
      }
    });
    leases.add(lease);
    return lease;
  }

  revoke(sessionKey?: string): void {
    const keys = sessionKey === undefined ? [...this.sessions.keys()] : [sessionKey];
    for (const key of keys) {
      const leases = this.sessions.get(key);
      this.sessions.delete(key);
      for (const lease of leases ?? []) {
        lease.revoke();
      }
    }
  }

  block(sessionKey?: string): () => void {
    this.revoke(sessionKey);
    if (sessionKey === undefined) {
      this.blockedAll += 1;
    } else {
      this.blockedSessions.set(sessionKey, (this.blockedSessions.get(sessionKey) ?? 0) + 1);
    }
    let active = true;
    return () => {
      if (!active) {
        return;
      }
      active = false;
      if (sessionKey === undefined) {
        this.blockedAll -= 1;
        return;
      }
      const count = (this.blockedSessions.get(sessionKey) ?? 1) - 1;
      if (count === 0) {
        this.blockedSessions.delete(sessionKey);
      } else {
        this.blockedSessions.set(sessionKey, count);
      }
    };
  }

  protectedKeys(maximum = 2000): string[] | null {
    return this.sessions.size > maximum ? null : [...this.sessions.keys()];
  }
}

export const thoughtCaptureLeases = new ThoughtCaptureLeases();

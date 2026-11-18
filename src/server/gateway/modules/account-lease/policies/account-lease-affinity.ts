import type { CloudAccount } from '@/modules/cloud-account/types';

interface Binding {
  accountId: string;
  expiresAt: number;
}
interface PendingAffinity {
  commit(): void;
  reject(): void;
}

/** Committed records have identity: a failed lease can remove only the record it observed. */
export class AccountLeaseAffinity {
  private readonly sessions = new Map<string, Binding>();
  private readonly models = new Map<string, Binding>();
  private readonly pending = new WeakMap<CloudAccount, PendingAffinity>();
  private epoch = {};
  private modelEpoch = {};
  private strategy?: 'balanced' | 'account-first';

  setStrategy(strategy: 'balanced' | 'account-first'): void {
    if (strategy !== this.strategy) {
      this.clearModels();
      this.strategy = strategy;
    }
  }

  getSession(sessionKey: string | undefined, now: number): Binding | undefined {
    if (!sessionKey) {
      return undefined;
    }
    const binding = this.sessions.get(sessionKey);
    if (binding && binding.expiresAt <= now) {
      this.sessions.delete(sessionKey);
      return undefined;
    }
    return binding;
  }

  getModelAccount(model: string): string | undefined {
    return this.models.get(model)?.accountId;
  }

  bindSession(sessionKey: string | undefined, accountId: string, expiresAt: number): void {
    if (sessionKey) {
      this.sessions.set(sessionKey, { accountId, expiresAt });
    }
  }

  prepare(
    sessionKey: string | undefined,
    model: string | undefined,
  ): (token: CloudAccount, isCurrent: () => boolean) => void {
    const epoch = this.epoch;
    const modelEpoch = this.modelEpoch;
    const modelKey = model?.trim().toLowerCase() ?? '';
    const observedSession = this.getSession(sessionKey, Date.now());
    const observedModel = this.models.get(modelKey);
    const accountFirst = this.strategy === 'account-first';
    return (token, isCurrent) => {
      let committed = false;
      this.pending.set(token, {
        commit: () => {
          if (committed || epoch !== this.epoch || !isCurrent()) {
            return;
          }
          committed = true;
          const expiresAt = Date.now() + 600_000;
          this.bindSession(sessionKey, token.id, expiresAt);
          if (accountFirst && modelEpoch === this.modelEpoch) {
            if (!this.models.has(modelKey) && this.models.size >= 256) {
              const oldest = this.models.keys().next().value;
              if (oldest !== undefined) {
                this.models.delete(oldest);
              }
            }
            this.models.set(modelKey, { accountId: token.id, expiresAt });
          }
        },
        reject: () => {
          if (epoch !== this.epoch) {
            return;
          }
          if (
            sessionKey &&
            observedSession?.accountId === token.id &&
            this.sessions.get(sessionKey) === observedSession
          ) {
            this.sessions.delete(sessionKey);
          }
          if (
            observedModel?.accountId === token.id &&
            this.models.get(modelKey) === observedModel
          ) {
            this.models.delete(modelKey);
          }
        },
      });
    };
  }

  commit(token: CloudAccount): void {
    this.pending.get(token)?.commit();
  }

  reject(token: CloudAccount): void {
    this.pending.get(token)?.reject();
  }

  clear(): void {
    this.sessions.clear();
    this.epoch = {};
    this.clearModels();
  }

  clearModels(): void {
    this.models.clear();
    this.modelEpoch = {};
  }

  clearAccount(accountId: string): void {
    for (const map of [this.sessions, this.models]) {
      for (const [key, binding] of map) {
        if (binding.accountId === accountId) {
          map.delete(key);
        }
      }
    }
  }

  cleanup(now: number): void {
    for (const [key, binding] of this.sessions) {
      if (binding.expiresAt <= now) {
        this.sessions.delete(key);
      }
    }
  }
}

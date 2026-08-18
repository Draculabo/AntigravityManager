const DEFAULT_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

interface PendingOAuthState {
  value: string;
  expiresAt: number;
}

class OAuthStateStoreImpl {
  private pending: PendingOAuthState | null = null;

  begin(state: string, now = Date.now()): void {
    const normalizedState = state.trim();
    if (!normalizedState) {
      throw new Error('OAuth state must not be empty');
    }

    this.pending = {
      value: normalizedState,
      expiresAt: now + DEFAULT_OAUTH_STATE_TTL_MS,
    };
  }

  consume(state: string | null | undefined, now = Date.now()): boolean {
    const pending = this.pending;
    if (!pending) {
      return false;
    }

    if (pending.expiresAt <= now) {
      this.pending = null;
      return false;
    }

    if (!state || state !== pending.value) {
      return false;
    }

    this.pending = null;
    return true;
  }

  clear(state?: string): void {
    if (!this.pending) {
      return;
    }

    if (state && this.pending.value !== state) {
      return;
    }

    this.pending = null;
  }
}

export const OAuthStateStore = new OAuthStateStoreImpl();

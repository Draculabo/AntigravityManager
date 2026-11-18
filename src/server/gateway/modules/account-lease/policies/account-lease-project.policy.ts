import type { Logger } from '@nestjs/common';
import type { AccountLeaseRefreshControl } from './account-lease-hydration.policy';
import type { AccountLeaseUpstream } from '../interfaces/account-lease-adapters';
import {
  type AccountLeaseTokenData,
  normalizeProjectId,
} from '../interfaces/account-lease-token-types';

interface ProjectProbeState {
  failedUntil: number;
  pending?: Promise<string | undefined>;
  signal?: AbortSignal;
  isCurrent(): boolean;
}

interface ProjectPolicyOptions {
  upstream: Pick<AccountLeaseUpstream, 'fetchProjectId'>;
  getTokenCache(): Map<string, AccountLeaseTokenData>;
  logger: Pick<Logger, 'warn' | 'log'>;
  persist(accountId: string, token: AccountLeaseTokenData, isCurrent: () => boolean): void;
}

/** Probe results belong to one live cache entry and credential context, never just an account ID. */
export class AccountLeaseProjectPolicy {
  private readonly states = new WeakMap<AccountLeaseTokenData, ProjectProbeState>();

  constructor(private readonly options: ProjectPolicyOptions) {}

  invalidate(token: AccountLeaseTokenData): void {
    this.states.delete(token);
  }

  async resolve(
    accountId: string,
    token: AccountLeaseTokenData,
    control?: AccountLeaseRefreshControl,
  ): Promise<string | undefined> {
    if (this.options.getTokenCache().get(accountId) !== token) {
      return undefined;
    }
    let state = this.states.get(token);
    if (!state?.isCurrent()) {
      const { refresh_token, oauth_client_key, email, upstream_proxy_url } = token;
      const current: ProjectProbeState = {
        failedUntil: 0,
        signal: control?.signal,
        isCurrent: () =>
          (!control || this.ownerCurrent(control)) &&
          this.options.getTokenCache().get(accountId) === token &&
          this.states.get(token) === current &&
          token.refresh_token === refresh_token &&
          token.oauth_client_key === oauth_client_key &&
          token.email === email &&
          token.upstream_proxy_url === upstream_proxy_url,
      };
      state = current;
      this.states.set(token, state);
    }

    const known = normalizeProjectId(token.project_id);
    token.project_id = known;
    if (known) {
      state.failedUntil = 0;
      return known;
    }
    if (state.failedUntil > Date.now()) {
      return undefined;
    }
    if (state.pending) {
      return state.pending;
    }

    const pending = this.probe(accountId, token, state).finally(() => {
      if (state.pending === pending) {
        state.pending = undefined;
      }
    });
    state.pending = pending;
    return pending;
  }

  private ownerCurrent(control: AccountLeaseRefreshControl): boolean {
    try {
      control.signal.throwIfAborted();
      control.assertCurrent();
      return true;
    } catch {
      return false;
    }
  }

  private async probe(
    accountId: string,
    token: AccountLeaseTokenData,
    state: ProjectProbeState,
  ): Promise<string | undefined> {
    let projectId: string | undefined;
    try {
      projectId = normalizeProjectId(
        state.signal
          ? await this.options.upstream.fetchProjectId(
              token.access_token,
              token.upstream_proxy_url,
              state.signal,
            )
          : await this.options.upstream.fetchProjectId(
              token.access_token,
              token.upstream_proxy_url,
            ),
      );
    } catch (error) {
      this.options.logger.warn(`Unable to resolve project ID for account ${accountId}`, error);
    }
    if (!state.isCurrent()) {
      return undefined;
    }
    // A concurrent authoritative update takes precedence over this probe's result or failure.
    const known = normalizeProjectId(token.project_id);
    if (known) {
      state.failedUntil = 0;
      return known;
    }
    if (!projectId) {
      state.failedUntil = Date.now() + 300_000;
      this.options.logger.warn(
        `Project ID unavailable for account ${accountId}; caching failure for 300 seconds`,
      );
      return undefined;
    }

    state.failedUntil = 0;
    token.project_id = projectId;
    this.options.persist(
      accountId,
      token,
      () => state.isCurrent() && normalizeProjectId(token.project_id) === projectId,
    );
    this.options.logger.log(`Resolved project ID for account ${accountId}: ${projectId}`);
    return projectId;
  }
}
